"""Automated DEM-wide candidate landing site and observation window discovery."""
from datetime import datetime, timedelta
import math
from typing import Any
import numpy as np
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator
import spiceypy as spice

from .horizon import _DEM, _load_dem, compute_horizon, horizon_at, inverse_south_polar
from .skyview import (
    FRAME,
    SPICE_LOCK,
    SkyViewUnavailable,
    iso_utc,
    kernel_inventory,
    observer_basis,
    parse_utc,
    project_target,
    sample_times,
    visibility_intervals,
)
from .skyview_slope import local_slope

MAX_RANGE_DAYS = 90
MAX_WINDOWS = 64
MAX_UNIQUE_TIMESTAMPS = 2049
MAX_CANDIDATE_WINDOW_SAMPLES = 32768
MAX_TOTAL_SKYLINE_SAMPLES = 3000000


class DiscoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    start_utc: str
    end_utc: str
    duration_hours: float = Field(default=24, ge=1, le=168)
    cadence_hours: StrictInt = Field(default=24, ge=1, le=168)
    step_seconds: StrictInt = Field(default=3600, ge=600, le=21600)
    min_sunlight_hours: float = Field(default=0, ge=0, le=168)
    min_sunlight_fraction: float = Field(default=0, ge=0, le=1)
    min_earth_hours: float = Field(default=0, ge=0, le=168)
    min_earth_fraction: float = Field(default=0, ge=0, le=1)
    max_slope_deg: float = Field(default=15, ge=0, le=90)
    spatial_resolution_m: float = Field(default=20000, ge=200, le=1000000)
    max_candidates: StrictInt = Field(default=64, ge=1, le=128)
    max_results: StrictInt = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def validate_request(self):
        try:
            first = parse_utc(self.start_utc)
            last = parse_utc(self.end_utc)
        except Exception as exc:
            raise ValueError(f"Invalid ISO UTC timestamp: {exc}") from exc

        if last <= first:
            raise ValueError("end_utc must be strictly after start_utc")

        total_hours = (last - first).total_seconds() / 3600.0
        if total_hours > MAX_RANGE_DAYS * 24:
            raise ValueError(f"Requested range ({total_hours:.1f} h) exceeds maximum {MAX_RANGE_DAYS} days")

        if self.duration_hours > total_hours:
            raise ValueError(f"duration_hours ({self.duration_hours} h) cannot exceed total range ({total_hours:.1f} h)")

        # Verify windows count
        curr = first
        dur_td = timedelta(hours=self.duration_hours)
        cad_td = timedelta(hours=self.cadence_hours)
        num_windows = 0
        while curr + dur_td <= last:
            num_windows += 1
            curr += cad_td

        if num_windows == 0:
            raise ValueError("No complete windows fit inside the requested date range")
        if num_windows > MAX_WINDOWS:
            raise ValueError(f"Too many candidate windows ({num_windows} > {MAX_WINDOWS}); increase cadence or shorten date range")

        return self


def _generate_candidate_strata(dem: _DEM, spatial_resolution_m: float, max_candidates: int) -> tuple[list[dict], dict]:
    """Divide DEM footprint into deterministic equal-area strata; evaluate center only."""
    dem_rows, dem_cols = dem.values.shape
    x_min = -dem.sample0 * dem.spacing
    x_max = (dem_cols - 1 - dem.sample0) * dem.spacing
    y_min = (dem.line0 - dem_rows + 1) * dem.spacing
    y_max = dem.line0 * dem.spacing

    width_m = x_max - x_min
    height_m = y_max - y_min

    cols = max(1, int(math.floor(width_m / spatial_resolution_m)))
    rows = max(1, int(math.floor(height_m / spatial_resolution_m)))

    coarsened = False
    if cols * rows > max_candidates:
        coarsened = True
        aspect = width_m / height_m
        target_rows = max(1, int(math.floor(math.sqrt(max_candidates / aspect))))
        target_cols = max(1, int(math.floor(max_candidates / target_rows)))
        while target_cols * target_rows > max_candidates:
            if target_cols >= target_rows and target_cols > 1:
                target_cols -= 1
            elif target_rows > 1:
                target_rows -= 1
            else:
                break
        rows, cols = target_rows, target_cols

    actual_spacing_x = width_m / cols
    actual_spacing_y = height_m / rows

    strata = []
    idx = 1
    for r in range(rows):
        y_bot = y_min + r * actual_spacing_y
        y_top = y_bot + actual_spacing_y
        y_center = (y_bot + y_top) / 2.0
        for c in range(cols):
            x_left = x_min + c * actual_spacing_x
            x_right = x_left + actual_spacing_x
            x_center = (x_left + x_right) / 2.0

            lat_deg, lon_deg = inverse_south_polar(x_center, y_center)
            strata.append({
                "region_id": f"region_{idx:02d}",
                "lat": float(lat_deg),
                "lon": float(lon_deg),
                "center_projected_m": {"x": float(x_center), "y": float(y_center)},
                "bounds_projected_m": {
                    "x_min": float(x_left),
                    "x_max": float(x_right),
                    "y_min": float(y_bot),
                    "y_max": float(y_top),
                },
            })
            idx += 1

    coverage_meta = {
        "bounds_projected_m": {
            "x_min": float(x_min),
            "x_max": float(x_max),
            "y_min": float(y_min),
            "y_max": float(y_max),
        },
        "grid_rows": rows,
        "grid_cols": cols,
        "requested_spacing_m": float(spatial_resolution_m),
        "actual_spacing_x_m": float(actual_spacing_x),
        "actual_spacing_y_m": float(actual_spacing_y),
        "coarsened": coarsened,
        "dem_spacing_m": float(dem.spacing),
        "dem_sha256": dem.sha256,
        "dem_shape": list(dem.values.shape),
    }
    return strata, coverage_meta


def discover_candidates(req: DiscoveryRequest) -> dict[str, Any]:
    """Execute conditional landing site and window candidate discovery across DEM."""
    dem = _load_dem()

    first = parse_utc(req.start_utc)
    last = parse_utc(req.end_utc)

    # Build windows
    dur_td = timedelta(hours=req.duration_hours)
    cad_td = timedelta(hours=req.cadence_hours)
    windows_plan = []
    curr = first
    while curr + dur_td <= last:
        w_start = curr
        w_end = curr + dur_td
        w_times = sample_times(iso_utc(w_start), iso_utc(w_end), req.step_seconds)
        windows_plan.append({
            "start_utc": iso_utc(w_start),
            "end_utc": iso_utc(w_end),
            "duration_hours": float(req.duration_hours),
            "times": w_times,
        })
        curr += cad_td

    unique_times = sorted(set(t for w in windows_plan for t in w["times"]))
    if len(unique_times) > MAX_UNIQUE_TIMESTAMPS:
        raise ValueError(
            f"Too many unique evaluation timestamps ({len(unique_times)} > {MAX_UNIQUE_TIMESTAMPS}); "
            f"increase step_seconds or shorten range"
        )

    # 1. Stratified grid generation
    strata, coverage_meta = _generate_candidate_strata(dem, req.spatial_resolution_m, req.max_candidates)
    num_candidates = len(strata)

    # Budget checks
    planned_window_samples = sum(len(w["times"]) for w in windows_plan)
    planned_candidate_window_samples = num_candidates * planned_window_samples
    if planned_candidate_window_samples > MAX_CANDIDATE_WINDOW_SAMPLES:
        raise ValueError(
            f"Evaluation budget exceeded: {planned_candidate_window_samples} candidate-window samples > "
            f"{MAX_CANDIDATE_WINDOW_SAMPLES}; reduce max_candidates, windows, or increase step_seconds"
        )

    # 72 azimuth rays * (50000 / 240 ≈ 209 steps) ≈ 15000 ray samples per skyline
    ray_samples_per_candidate = 72 * max(1, int(50000.0 / dem.spacing))
    planned_max_skyline_samples = num_candidates * ray_samples_per_candidate
    if planned_max_skyline_samples > MAX_TOTAL_SKYLINE_SAMPLES:
        raise ValueError(
            f"Skyline ray budget exceeded: {planned_max_skyline_samples} > {MAX_TOTAL_SKYLINE_SAMPLES}; "
            f"reduce max_candidates"
        )

    # 2. Stage 1: Slope & nodata screening at strata centers
    rejected_reason_counts = {"slope": 0, "nodata": 0, "outside": 0, "conditions": 0}
    surviving_candidates = []

    for cand in strata:
        lat, lon = cand["lat"], cand["lon"]
        slope_info = local_slope(lat, lon)
        if slope_info.get("unavailable_reason") or slope_info.get("slope_deg") is None:
            reason = "nodata" if slope_info.get("unavailable_reason") == "nodata" else "outside"
            rejected_reason_counts[reason] += 1
            continue

        slope_deg = float(slope_info["slope_deg"])
        if slope_deg > req.max_slope_deg:
            rejected_reason_counts["slope"] += 1
            continue

        cand["local_slope"] = {
            "slope_deg": slope_deg,
            "fit_rms_m": float(slope_info.get("fit_rms_m", 0.0)),
            "grid_spacing_m": float(slope_info.get("grid_spacing_m", dem.spacing)),
        }
        surviving_candidates.append(cand)

    # 3. Stage 2: Compute skyline for surviving candidates (5° azimuth, 50 km range, 2m eye level)
    for cand in surviving_candidates:
        horizon = compute_horizon(
            cand["lat"], cand["lon"],
            observer_height_m=2.0,
            azimuth_step_deg=5.0,
            max_distance_m=50000.0,
        )
        cand["horizon"] = horizon
        cand["basis"] = observer_basis(
            cand["lat"], cand["lon"],
            horizon["surface_elevation_m"],
            observer_height_m=2.0
        )
        cand["horizon_coverage"] = {
            "azimuth_step_deg": horizon.get("azimuth_step_deg", 5.0),
            "max_radius_m": horizon.get("max_radius_m", 50000.0),
            "surface_elevation_m": horizon.get("surface_elevation_m", 0.0),
        }

    # 4. Compute unique SPICE target vectors
    kernels = kernel_inventory()
    sun_vectors: dict[datetime, np.ndarray] = {}
    earth_vectors: dict[datetime, np.ndarray] = {}

    with SPICE_LOCK:
        for k in kernels:
            spice.furnsh(k["path"])
        try:
            if spice.namfrm(FRAME) != 31007:
                raise SkyViewUnavailable("Frame MOON_ME_DE421 has unexpected ID; SPICE kernels misconfigured")
            for t in unique_times:
                et = spice.str2et(iso_utc(t))
                sun_vectors[t] = spice.spkpos("SUN", et, FRAME, "NONE", "MOON")[0]
                earth_vectors[t] = spice.spkpos("EARTH", et, FRAME, "NONE", "MOON")[0]
        finally:
            for k in reversed(kernels):
                spice.unload(k["path"])

    # 5. Evaluate windows for surviving candidates
    matched_results = []
    evaluated_windows_count = 0

    for cand in surviving_candidates:
        valid_windows = []
        slope_deg = cand["local_slope"]["slope_deg"]
        horizon = cand["horizon"]
        basis = cand["basis"]

        for w in windows_plan:
            evaluated_windows_count += 1
            w_times = w["times"]
            points = []

            for t in w_times:
                sun_pos = project_target(sun_vectors[t], basis)
                earth_pos = project_target(earth_vectors[t], basis)

                sun_skyline = float(horizon_at(horizon, sun_pos["azimuth_deg"]))
                earth_skyline = float(horizon_at(horizon, earth_pos["azimuth_deg"]))

                # Strict inequality per spec: center strictly above terrain
                sun_vis = sun_pos["elevation_deg"] > sun_skyline
                earth_vis = earth_pos["elevation_deg"] > earth_skyline

                points.append({
                    "time_utc": iso_utc(t),
                    "sun": {"center_visible": sun_vis},
                    "earth": {"center_visible": earth_vis},
                })

            # Calculate intervals
            intervals_data = visibility_intervals(points, req.step_seconds)

            # Trapezoidal integration
            times_dt = [parse_utc(p["time_utc"]) for p in points]
            total_duration_s = (times_dt[-1] - times_dt[0]).total_seconds()
            sun_s = 0.0
            earth_s = 0.0

            for i in range(1, len(points)):
                dt_step = (times_dt[i] - times_dt[i - 1]).total_seconds()
                sun_s += dt_step * (int(points[i - 1]["sun"]["center_visible"]) + int(points[i]["sun"]["center_visible"])) / 2.0
                earth_s += dt_step * (int(points[i - 1]["earth"]["center_visible"]) + int(points[i]["earth"]["center_visible"])) / 2.0

            sun_hours = sun_s / 3600.0
            sun_fraction = sun_s / total_duration_s if total_duration_s > 0 else 0.0
            earth_hours = earth_s / 3600.0
            earth_fraction = earth_s / total_duration_s if total_duration_s > 0 else 0.0

            # Filter conditions
            if sun_hours < req.min_sunlight_hours or sun_fraction < req.min_sunlight_fraction:
                continue
            if earth_hours < req.min_earth_hours or earth_fraction < req.min_earth_fraction:
                continue

            # Score per spec: 100 * (0.45 * sun_frac + 0.45 * earth_frac + 0.10 * (1 - slope/90))
            score = 100.0 * (0.45 * sun_fraction + 0.45 * earth_fraction + 0.10 * (1.0 - slope_deg / 90.0))

            valid_windows.append({
                "start_utc": w["start_utc"],
                "end_utc": w["end_utc"],
                "duration_hours": w["duration_hours"],
                "score": round(score, 2),
                "sun": {
                    "total_sunlight_hours": round(sun_hours, 2),
                    "sunlight_percentage": round(sun_fraction * 100.0, 2),
                    "intervals": intervals_data.get("sun", []),
                },
                "earth": {
                    "total_earth_visible_hours": round(earth_hours, 2),
                    "earth_visible_percentage": round(earth_fraction * 100.0, 2),
                    "intervals": intervals_data.get("earth", []),
                },
            })

        if valid_windows:
            # Sort windows descending by score, tie-break by start_utc
            valid_windows.sort(key=lambda item: (-item["score"], item["start_utc"]))
            best_window_score = valid_windows[0]["score"]
            matched_results.append({
                "region_id": cand["region_id"],
                "lat": cand["lat"],
                "lon": cand["lon"],
                "bounds_projected_m": cand["bounds_projected_m"],
                "score": best_window_score,
                "local_slope": cand["local_slope"],
                "horizon_coverage": cand["horizon_coverage"],
                "windows": valid_windows,
            })
        else:
            rejected_reason_counts["conditions"] += 1

    # Order candidates by best window score descending, tie-break by region_id
    matched_results.sort(key=lambda item: (-item["score"], item["region_id"]))
    top_results = matched_results[:req.max_results]

    metadata = {
        "criteria": req.model_dump(),
        "coverage": coverage_meta,
        "provenance": {
            "engine": "MAXQMOON Discovery Engine (LOLA DEM + NAIF SPICE)",
            "frame": FRAME,
            "frame_id": 31007,
            "aberration": "NONE",
            "observer_height_m": 2.0,
            "kernels": kernels,
            "score_definition": "100 * (0.45 * sun_fraction + 0.45 * earth_fraction + 0.10 * (1 - slope/90))",
        },
        "evaluated_candidates": num_candidates,
        "evaluated_windows": evaluated_windows_count,
        "horizons_computed": len(surviving_candidates),
        "matched_regions": len(matched_results),
        "rejected_regions": num_candidates - len(matched_results),
        "rejected_reason_counts": rejected_reason_counts,
        "unique_timestamps": len(unique_times),
        "planned_candidate_window_samples": planned_candidate_window_samples,
        "planned_max_skyline_samples": planned_max_skyline_samples,
        "skyline_samples_per_candidate_upper_bound": ray_samples_per_candidate,
        "budgets": {
            "max_range_days": MAX_RANGE_DAYS,
            "max_windows": MAX_WINDOWS,
            "max_unique_timestamps": MAX_UNIQUE_TIMESTAMPS,
            "max_candidate_window_samples": MAX_CANDIDATE_WINDOW_SAMPLES,
            "max_total_skyline_samples": MAX_TOTAL_SKYLINE_SAMPLES,
        },
        "ordering": "Candidates ordered by best window score descending, then region_id; windows ordered by score descending, then start_utc",
        "limits": [
            "Coarsened grid samples region centers only, not exhaustive terrain search",
            "50 km horizon raymarching is truncated; features beyond 50 km are not modeled in screening",
            "Screening score is a heuristic index, not a certified safe landing certificate",
        ],
    }

    return {"results": top_results, "metadata": metadata}
