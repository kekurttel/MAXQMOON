"""Real DEM + direct SPICE endpoints, independent of legacy local series."""
import math

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from .dem_coverage import DEMCoverageUnavailable, validate_dem_coverage
from .discovery import DiscoveryRequest, discover_candidates
from .horizon import TerrainUnavailable, compute_horizon
from .reference_data import catalog
from .skyview import SkyViewUnavailable, compute_skyview, kernel_inventory, sample_times
from .skyview_planning import (MAX_BATCH_SAMPLES, CompareRequest, ScheduleShockRequest,
                               schedule_metadata, schedule_windows, visibility_summary)

from .skyview_search import (CatalogSearchLocation, SearchRequest, coordinate_identity,
                             meets_criteria, search_windows)
from .skyview_slope import local_slope

router = APIRouter(prefix="/api/skyview", tags=["DEM horizon / SPICE sky"])


class SkyViewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    site_id: str = Field(min_length=1, max_length=120)
    start_utc: str
    end_utc: str
    step_seconds: StrictInt = Field(default=600, ge=60, le=86400)
    observer_height_m: float = Field(default=2.0, ge=0, le=100)


class CustomSkyViewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    start_utc: str
    end_utc: str
    step_seconds: StrictInt = Field(default=600, ge=60, le=86400)


def site_by_id(site_id: str) -> dict:
    for site in catalog():
        if site["id"] == site_id:
            return site
    raise HTTPException(404, "Unknown site_id; use /api/skyview/sites")


def is_dem_covered(lat: float, lon: float) -> bool:
    try:
        validate_dem_coverage(lat, lon)
        return True
    except Exception:
        return False


@router.get("/sites")
def sites():
    items = []
    for site in catalog():
        covered = is_dem_covered(site["lat"], site["lon"])
        items.append({
            "id": site["id"],
            "name": site["name"],
            "lat": site["lat"],
            "lon": site["lon"],
            "dem_covered": covered,
        })
    return {"sites": items,
            "limits": "Catalog membership does not guarantee DEM coverage. Sites with dem_covered=false are outside the South Polar DEM and return 422 if simulated."}


@router.get("/status")
def status():
    try:
        import spiceypy
        kernels = kernel_inventory()
    except (ImportError, SkyViewUnavailable) as exc:
        return {"available": False, "reason": str(exc), "fallback": False}
    return {"available": True, "spiceypy": spiceypy.__version__, "frame": "MOON_ME_DE421",
            "kernels": [{k: v for k, v in kernel.items() if k != "path"} for kernel in kernels],
            "limits": "Dependencies found only; requested date coverage and DEM support are checked during analysis.",
            "fallback": False}


@router.get("/horizon/{site_id}")
def horizon(site_id: str):
    site = site_by_id(site_id)
    try:
        return compute_horizon(site["lat"], site["lon"])
    except TerrainUnavailable as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/custom")
def custom(request: CustomSkyViewRequest):
    try:
        coverage = validate_dem_coverage(request.lat, request.lon)
        # Coverage and horizon share the measured calculation grid. Horizon
        # still checks every required sample and reports finite/truncated rays.
        result = compute_skyview(request.lat, request.lon, request.start_utc,
                                 request.end_utc, request.step_seconds)
        result["provenance"]["coordinate_coverage"] = coverage
        return result
    except TerrainUnavailable as exc:
        raise HTTPException(422, str(exc)) from exc
    except (DEMCoverageUnavailable, SkyViewUnavailable) as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _planning_error(exc: Exception, label: str | None = None) -> HTTPException:
    if isinstance(exc, HTTPException):
        status_code, detail = exc.status_code, exc.detail
    else:
        status_code = 503 if isinstance(exc, (DEMCoverageUnavailable, SkyViewUnavailable)) else 422
        detail = str(exc)
    return HTTPException(status_code, f"{label}: {detail}" if label else detail)


@router.post("/compare")
def compare(request: CompareRequest):
    prepared = []
    total_samples = 0
    # Validate the entire batch before calculating either scenario. No response
    # is returned until both full results succeed, including runtime coverage.
    for label in ("scenarioA", "scenarioB"):
        scenario = getattr(request, label)
        try:
            total_samples += len(sample_times(scenario.start_utc, scenario.end_utc, scenario.step_seconds))
            if total_samples > MAX_BATCH_SAMPLES:
                raise ValueError(f"Batch exceeds {MAX_BATCH_SAMPLES} samples; increase step")
            if scenario.site_id is not None:
                site = site_by_id(scenario.site_id)
                lat, lon, coverage = site["lat"], site["lon"], None
            else:
                lat, lon = scenario.lat, scenario.lon
                coverage = validate_dem_coverage(lat, lon)
            prepared.append((label, scenario, lat, lon, coverage))
        except (HTTPException, TerrainUnavailable, DEMCoverageUnavailable, SkyViewUnavailable, ValueError) as exc:
            raise _planning_error(exc, label) from exc
    results = {}
    for label, scenario, lat, lon, coverage in prepared:
        try:
            result = compute_skyview(lat, lon, scenario.start_utc, scenario.end_utc, scenario.step_seconds)
            if coverage is not None:
                result["provenance"]["coordinate_coverage"] = coverage
            results[label] = result
        except (TerrainUnavailable, DEMCoverageUnavailable, SkyViewUnavailable, ValueError) as exc:
            raise _planning_error(exc, label) from exc
    return results


@router.post("/compare-planning")
def compare_planning(request: CompareRequest):
    results = compare(request)
    for label in ("scenarioA", "scenarioB"):
        result = results[label]
        result["planning_summary"] = visibility_summary(result, 0)
        try:
            result["local_slope"] = local_slope(result["site"]["lat_deg"], result["site"]["lon_deg"])
        except TerrainUnavailable as exc:
            result["local_slope"] = {"slope_deg": None, "unavailable_reason": str(exc)}
    return results


@router.post("/schedule-shock")
def schedule_shock(request: ScheduleShockRequest):
    try:
        windows = schedule_windows(request)
        coverage = validate_dem_coverage(request.lat, request.lon)
        results = []
        for delay, start, end in windows:
            result = compute_skyview(request.lat, request.lon, start, end, request.step_seconds)
            results.append(visibility_summary(result, delay))
        return {"results": results, "metadata": schedule_metadata(request, coverage)}
    except (TerrainUnavailable, DEMCoverageUnavailable, SkyViewUnavailable, ValueError) as exc:
        raise _planning_error(exc) from exc


@router.post("/search")
def search_sites(request: SearchRequest):
    try:
        windows = search_windows(request)
        selected, identities = [], set()
        legacy = request.site_ids is not None
        locations = request.site_ids if legacy else request.locations
        # Resolve every identifier/coordinate before any terrain or SPICE work.
        for index, location in enumerate(locations):
            label = f"locations[{index}]" if not legacy else f"site_ids[{index}]"
            try:
                identifier = location if legacy else (location.site_id if isinstance(location, CatalogSearchLocation) else None)
                if identifier is not None:
                    source = site_by_id(identifier)
                    site = {k: source[k] for k in ("id", "name", "lat", "lon")}
                else:
                    site = {"id": None, "name": location.name or f"{location.lat:g}, {location.lon:g}",
                            "lat": location.lat, "lon": location.lon}
                identity = coordinate_identity(site["lat"], site["lon"])
                if not legacy and identity in identities:
                    raise ValueError("duplicate resolved coordinates; choose distinct locations")
                identities.add(identity)
                if not legacy:
                    site["site_id"] = site["id"]
                selected.append((index, label, site))
            except (HTTPException, ValueError) as exc:
                raise _planning_error(exc, label) from exc

        matches, rejected, prepared, evaluated = [], [], [], 0
        # Preflight all custom coverage and slope neighborhoods atomically. A
        # supported center does not guarantee the complete 3x3 slope stencil.
        for index, label, site in selected:
            coverage = None
            if site["id"] is None:
                try:
                    coverage = validate_dem_coverage(site["lat"], site["lon"])
                except (TerrainUnavailable, DEMCoverageUnavailable, ValueError) as exc:
                    raise _planning_error(exc, label) from exc
            try:
                slope = local_slope(site["lat"], site["lon"])
                prepared.append((index, label, site, slope, coverage))
            except TerrainUnavailable as exc:
                rejection = {"site_id": site["id"], "reason": str(exc)}
                if not legacy:
                    rejection.update({"location_index": index,
                                      "lat": site["lat"], "lon": site["lon"], "name": site["name"],
                                      "reason": f"{label}: slope neighborhood unavailable: {exc}"})
                rejected.append(rejection)
            except (DEMCoverageUnavailable, SkyViewUnavailable, ValueError) as exc:
                raise _planning_error(exc, label) from exc

        for index, label, site, slope, coverage in prepared:
            site_matches = []
            try:
                for first, last in windows:
                    result = compute_skyview(site["lat"], site["lon"], first, last, request.step_seconds)
                    if coverage is not None:
                        result["provenance"]["coordinate_coverage"] = coverage
                    summary = visibility_summary(result, 0)
                    evaluated += 1
                    if meets_criteria(summary, slope, request):
                        match = {"site": site, "summary": summary, "local_slope": slope,
                                 "horizon_coverage": result["horizon"]["coverage"],
                                 "dem_provenance": result["horizon"]["provenance"]}
                        if not legacy:
                            match["step_seconds"] = request.step_seconds
                        site_matches.append(match)
                matches.extend(site_matches)
            except TerrainUnavailable as exc:
                rejection = {"site_id": site["id"], "reason": str(exc)}
                if not legacy:
                    rejection.update({"location_index": index,
                                      "lat": site["lat"], "lon": site["lon"], "name": site["name"],
                                      "reason": f"{label}: {exc}"})
                rejected.append(rejection)
            except (DEMCoverageUnavailable, SkyViewUnavailable, ValueError) as exc:
                raise _planning_error(exc, label) from exc
        matches.sort(key=lambda row: (row["summary"]["start_utc"], row["site"]["id"] or "",
                                      row["site"]["lat"], row["site"]["lon"]))
        return {"results": matches[:request.max_results], "metadata": {
            "criteria": request.model_dump(exclude={"locations"} if legacy else {"site_ids"}), "evaluated_windows": evaluated,
            "matched_windows": len(matches), "rejected_sites": rejected,
            "max_site_time_samples": MAX_BATCH_SAMPLES, "max_date_windows": 64,
            "ordering": ("earliest UTC first, then catalog identifier; not global optimum" if legacy else
                         "earliest UTC first, then catalog identifier and exact coordinates; not global optimum"),
            "coverage": ("Only requested catalog sites and complete observation windows at the requested cadence. Runtime SPICE date coverage is required; no extrapolation." if legacy else
                         "Only requested catalog/custom coordinates and complete observation windows at the requested cadence. Custom centers require measured calculation DEM coverage; the entire 3x3 slope neighborhood must also be supported. Runtime SPICE date coverage is required; no extrapolation or nearest-site substitution."),
            "integration": schedule_metadata(ScheduleShockRequest(lat=0, lon=0, base_date=request.start_utc), {})["integration"],
            "limits": "Geometric Sun/Earth center visibility, not solar energy, disk illumination, link budget or flight safety. Criteria use sampled midpoint estimates, not guaranteed continuous intervals."}}
    except (HTTPException, TerrainUnavailable, DEMCoverageUnavailable, SkyViewUnavailable, ValueError) as exc:
        raise _planning_error(exc) from exc


@router.post("/series")
def series(request: SkyViewRequest):
    site = site_by_id(request.site_id)
    if not math.isfinite(request.observer_height_m):
        raise HTTPException(422, "observer_height_m must be finite")
    try:
        return compute_skyview(site["lat"], site["lon"], request.start_utc,
                               request.end_utc, request.step_seconds, request.observer_height_m)
    except TerrainUnavailable as exc:
        raise HTTPException(422, str(exc)) from exc
    except SkyViewUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/discovery")
def discovery(request: DiscoveryRequest):
    try:
        return discover_candidates(request)
    except (TerrainUnavailable, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except (DEMCoverageUnavailable, SkyViewUnavailable) as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Discovery calculation failed: {exc}") from exc

