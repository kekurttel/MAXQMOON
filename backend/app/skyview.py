"""Direct, geometric SPICE sky positions in the DEM's MOON_ME_DE421 frame.

No reference-series, network, IAU_MOON or synthetic fallback. SPICE's kernel
pool is process-global: all calls in this module hold the same lock.
"""
from __future__ import annotations

import hashlib
import math
import os
import threading
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np

from .horizon import compute_horizon, horizon_at

FRAME = "MOON_ME_DE421"
RADIUS_M = 1_737_400.0
MAX_SAMPLES = 2049
KERNEL_FILES = (
    "naif0012.tls", "de421.bsp", "moon_pa_de421_1900-2050.bpc", "moon_080317.tf",
)
SPICE_LOCK = threading.RLock()


class SkyViewUnavailable(RuntimeError):
    """Missing dependency/kernels or unavailable SPICE time/frame coverage."""


def parse_utc(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("Dates must be ISO 8601 with an explicit UTC timezone") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError("Dates must include an explicit UTC timezone (Z or +00:00)")
    return parsed.astimezone(timezone.utc)


def iso_utc(value: datetime) -> str:
    # Keep established millisecond output without truncating accepted UTC input.
    precision = "microseconds" if value.microsecond % 1000 else "milliseconds"
    return value.isoformat(timespec=precision).replace("+00:00", "Z")


def sample_times(start_utc: str, end_utc: str, step_seconds: int) -> list[datetime]:
    first, last = parse_utc(start_utc), parse_utc(end_utc)
    if not isinstance(step_seconds, int) or isinstance(step_seconds, bool) or not 60 <= step_seconds <= 86400:
        raise ValueError("step_seconds must be an integer between 60 and 86400")
    if last <= first:
        raise ValueError("end_utc must be after start_utc")
    count = (last - first) // timedelta(seconds=step_seconds) + 1
    # Include the actual requested endpoint; never predict past it.
    aligned = first + timedelta(seconds=(count - 1) * step_seconds) == last
    if count + (not aligned) > MAX_SAMPLES:
        raise ValueError(f"Request exceeds {MAX_SAMPLES} samples; shorten range or increase step")
    result = [first + timedelta(seconds=i * step_seconds) for i in range(count)]
    if not aligned:
        result.append(last)
    return result


def observer_basis(lat_deg: float, lon_deg: float, surface_elevation_m: float,
                   observer_height_m: float) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    if not all(math.isfinite(x) for x in (lat_deg, lon_deg, surface_elevation_m, observer_height_m)):
        raise ValueError("Observer coordinates and heights must be finite")
    if not -90 <= lat_deg < 90 or not -180 <= lon_deg <= 180 or observer_height_m < 0:
        raise ValueError("Observer outside supported coordinate/height range")
    # At the south pole, requested longitude defines the ENU azimuth reference.
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    east = np.array([-math.sin(lon), math.cos(lon), 0.0])
    north = np.cross(up, east)
    position_km = up * ((RADIUS_M + surface_elevation_m + observer_height_m) / 1000)
    return position_km, east, north, up


def project_target(vector_km: np.ndarray, basis: tuple) -> dict:
    observer, east, north, up = basis
    relative = np.asarray(vector_km, dtype=float) - observer
    if relative.shape != (3,) or not np.isfinite(relative).all():
        raise SkyViewUnavailable("SPICE returned a nonfinite target vector")
    distance = float(np.linalg.norm(relative))
    if not math.isfinite(distance) or distance <= 0:
        raise SkyViewUnavailable("SPICE returned an invalid target distance")
    e, n, u = (float(np.dot(relative, axis)) for axis in (east, north, up))
    horizontal = math.hypot(e, n)
    if horizontal / distance < 1e-12:
        raise SkyViewUnavailable("Target azimuth undefined at zenith/nadir")
    azimuth = math.degrees(math.atan2(e, n)) % 360
    # A tiny negative due-north angle can round to 360.0 after modulo.
    # Canonicalize that endpoint without snapping genuine near-north angles.
    if azimuth == 360.0:
        azimuth = 0.0
    return {"azimuth_deg": azimuth,
            "elevation_deg": math.degrees(math.atan2(u, horizontal)), "distance_km": distance}


@lru_cache(maxsize=32)
def _digest(path: str, size: int, mtime_ns: int) -> str:
    result = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def kernel_inventory() -> list[dict]:
    directory = Path(os.environ.get("LUNAR_KERNEL_DIR", Path(__file__).resolve().parents[1] / "data" / "kernels"))
    inventory = []
    for name in KERNEL_FILES:
        path = (directory / name).resolve()
        if not path.is_file():
            raise SkyViewUnavailable(f"Missing SPICE kernel: {name}; configure LUNAR_KERNEL_DIR (no fallback)")
        stat = path.stat()
        inventory.append({"file": name, "path": str(path), "sha256": _digest(str(path), stat.st_size, stat.st_mtime_ns)})
    return inventory


def _visibility(position: dict, horizon: dict) -> dict:
    terrain = float(horizon_at(horizon, position["azimuth_deg"]))
    clearance = position["elevation_deg"] - terrain
    return {**position, "horizon_elevation_deg": terrain, "clearance_deg": clearance,
            "center_visible": clearance > 0}


def _attach_transitions(points: list[dict], times: list[datetime], body: str) -> None:
    # Report a bracket, not an invented precise event or an extrapolated event.
    next_transition = None
    next_set_time = None
    remaining_field = {"sun": "hours_until_sunset", "earth": "hours_until_earthset"}[body]
    for i in range(len(points) - 1, -1, -1):
        if i + 1 < len(points) and points[i][body]["center_visible"] != points[i + 1][body]["center_visible"]:
            next_transition = {"after_utc": iso_utc(times[i]), "by_utc": iso_utc(times[i + 1]),
                               "becomes_visible": points[i + 1][body]["center_visible"]}
            if not points[i + 1][body]["center_visible"]:
                next_set_time = times[i + 1]
        points[i][body]["next_transition"] = next_transition
        points[i][remaining_field] = (
            (next_set_time - times[i]).total_seconds() / 3600
            if next_set_time is not None else None
        )


def visibility_intervals(points: list[dict], resolution_seconds: int) -> dict:
    """Estimate visible runs; midpoint edges match trapezoids within datetime precision."""
    times = [parse_utc(point["time_utc"]) for point in points]
    if len(times) < 2 or any(after <= before for before, after in zip(times, times[1:])):
        raise ValueError("Visibility interval sample times must be strictly increasing with at least two samples")

    result = {"method": "sampled-center-visibility-midpoint", "resolution_seconds": resolution_seconds}
    for body in ("sun", "earth"):
        intervals = []
        visible = points[0][body]["center_visible"]
        start = times[0] if visible else None
        start_bracket = None
        total_seconds = 0.0
        for i in range(1, len(points)):
            next_visible = points[i][body]["center_visible"]
            total_seconds += (times[i] - times[i - 1]).total_seconds() * (int(visible) + int(next_visible)) / 2
            if next_visible != visible:
                # datetime rounds half-microsecond edges; retain the unrounded
                # trapezoid total above (at most 0.5 us difference per edge).
                midpoint = times[i - 1] + (times[i] - times[i - 1]) / 2
                bracket = {"after_utc": iso_utc(times[i - 1]), "by_utc": iso_utc(times[i])}
                if next_visible:
                    start, start_bracket = midpoint, bracket
                else:
                    intervals.append({"start_utc": iso_utc(start), "end_utc": iso_utc(midpoint),
                                      "start_bracket": start_bracket, "end_bracket": bracket,
                                      "clipped_start": start_bracket is None, "clipped_end": False})
                visible = next_visible
        if visible:
            intervals.append({"start_utc": iso_utc(start), "end_utc": iso_utc(times[-1]),
                              "start_bracket": start_bracket, "end_bracket": None,
                              "clipped_start": start_bracket is None, "clipped_end": True})
        result[body] = {"intervals": intervals, "total_visible_hours": total_seconds / 3600}
    return result


def compute_skyview(lat_deg: float, lon_deg: float, start_utc: str, end_utc: str,
                    step_seconds: int = 600, observer_height_m: float = 2.0) -> dict:
    # Equivalent east-positive longitudes share one calculation convention.
    # Coordinates are never snapped to a catalog site.
    if math.isfinite(lon_deg):
        lon_deg = (lon_deg + 180) % 360 - 180
    times = sample_times(start_utc, end_utc, step_seconds)
    kernels = kernel_inventory()
    try:
        import spiceypy as spice
    except ImportError as exc:
        raise SkyViewUnavailable("spiceypy missing; install backend/requirements.txt (no fallback)") from exc
    horizon = compute_horizon(lat_deg, lon_deg, observer_height_m=observer_height_m)
    basis = observer_basis(lat_deg, lon_deg, horizon["surface_elevation_m"], observer_height_m)
    points = []
    with SPICE_LOCK:
        loaded = []
        try:
            for kernel in kernels:
                spice.furnsh(kernel["path"])
                loaded.append(kernel["path"])
            if spice.namfrm(FRAME) != 31007:
                raise SkyViewUnavailable("Expected MOON_ME_DE421 frame ID 31007; refusing another lunar frame")
            for instant in times:
                utc = iso_utc(instant)
                et = spice.str2et(utc)
                # Direct Moon-fixed evaluation; subtract the actual surface observer
                # before projecting. NONE is explicitly geometric, not apparent.
                sun = spice.spkpos("SUN", et, FRAME, "NONE", "MOON")[0]
                earth = spice.spkpos("EARTH", et, FRAME, "NONE", "MOON")[0]
                points.append({"time_utc": utc, "sun": _visibility(project_target(sun, basis), horizon),
                               "earth": _visibility(project_target(earth, basis), horizon)})
        except SkyViewUnavailable:
            raise
        except Exception as exc:
            raise SkyViewUnavailable(f"SPICE frame/time calculation failed; check kernel coverage: {exc}") from exc
        finally:
            for path in reversed(loaded):
                spice.unload(path)
    for body in ("sun", "earth"):
        _attach_transitions(points, times, body)
    try:
        from .skyview_slope import local_slope
        slope_info = local_slope(lat_deg, lon_deg)
    except Exception as exc:
        slope_info = {"slope_deg": None, "unavailable_reason": str(exc)}
    return {"frame": FRAME, "site": {"lat_deg": lat_deg, "lon_deg": lon_deg,
            "surface_elevation_m": horizon["surface_elevation_m"], "observer_height_m": observer_height_m},
            "start_utc": iso_utc(times[0]), "end_utc": iso_utc(times[-1]), "step_seconds": step_seconds,
            "horizon": horizon, "points": points,
            "visibility_intervals": visibility_intervals(points, step_seconds),
            "local_slope": slope_info,
            "provenance": {"engine": "NAIF SPICE / SpiceyPy", "frame": FRAME, "time_input": "UTC",
                "aberration_correction": "NONE", "coordinates": "planetocentric, east-positive longitude",
                "kernels": [{k: v for k, v in kernel.items() if k != "path"} for kernel in kernels],
                "visibility_definition": "Target center strictly above sampled DEM skyline; equality is not visible",
                "visibility_intervals": {
                    "method": "sampled-center-visibility-midpoint",
                    "definition": "Contiguous center-visible sample runs with midpoint transition estimates and explicit adjacent-sample brackets; visible endpoints are clipped to the requested window.",
                    "total_visible_hours": "Trapezoid integration of sampled center_visible using actual adjacent durations, including a partial final step; not solar energy or disk illumination.",
                    "resolution_seconds": step_seconds,
                    "extrapolation": False,
                    "limitations": "Transitions entirely between samples can be missed; midpoint estimates are not exact rise/set times.",
                },
                "time_to_set": {
                    "fields": ["hours_until_sunset", "hours_until_earthset"],
                    "units": "hours",
                    "definition": "Time to the first invisible sample of the next visible-to-hidden transition, even if currently hidden; null if no future set in the requested interval.",
                    "event_time_basis": "Upper endpoint (by_utc) of the sampled transition bracket, not an exact set time.",
                    "resolution_seconds": step_seconds,
                    "extrapolation": False,
                    "limitations": "Transitions entirely between samples can be missed; visibility remains unchanged.",
                },
                "limits": ["Geometric target centers; no light-time, aberration, refraction or solar/Earth disk occultation model.",
                           "Visibility is relative to a finite-range, sampled DEM skyline, not a certified full horizon.",
                           "Next transitions are sampled time brackets, not exact sunrise/set times; none means none found in requested interval.",
                           "SHA-256 identifies files; it does not validate scientific accuracy."]}}
