"""Coverage of the same finite measured grid used by horizon and slope.

The original 40 m PDS image is not a calculation dependency. The packaged
200 m decimation contains measured elevations; interpolation adds no resolution.
No raw-image bounds, catalog substitution, gap filling or extrapolation is used.
"""

from .horizon import (FRAME, MOON_RADIUS_M, PACKAGED_SHA256, PACKAGED_SHA256_75S, PACKAGED_SHA256_60S, TerrainUnavailable,
                      _load_dem, project_south_polar)


OUTSIDE_DEM_DETAIL = "Girilen koordinat DEM kapsama alanı dışında."


class DEMCoverageUnavailable(RuntimeError):
    """The measured calculation grid is missing, unreadable or malformed."""


def validate_dem_coverage(lat: float, lon: float) -> dict:
    """Validate center footprint; horizon/slope check their own required samples.

    Missing/invalid artifacts are service failures (503). Unsupported coordinates
    or nodata footprints are terrain failures (422). Boundary rays may truncate;
    their finite extent remains explicit in the returned horizon coverage.
    """
    try:
        dem = _load_dem()
    except TerrainUnavailable as exc:
        raise DEMCoverageUnavailable(str(exc)) from exc
    if lat == 90:
        raise TerrainUnavailable(OUTSIDE_DEM_DETAIL)
    x, y = project_south_polar(lat, lon)
    if not dem.contains(x, y):
        raise TerrainUnavailable(OUTSIDE_DEM_DETAIL)
    elevation = float(dem.sample(x, y))
    if MOON_RADIUS_M + elevation <= 0:
        raise TerrainUnavailable("DEM surface radius must be positive.")
    rows, cols = dem.values.shape
    packaged = dem.sha256 in (PACKAGED_SHA256, PACKAGED_SHA256_75S, PACKAGED_SHA256_60S)
    return {
        "source_product": (
            "LRO LOLA ldem_85s_40m; packaged grid decimated every fifth sample" if dem.sha256 == PACKAGED_SHA256
            else "LRO LOLA ldem_75s_240m; NASA PDS official 75°S-90°S 240m grid" if dem.sha256 == PACKAGED_SHA256_75S
            else "LRO LOLA ldem_60s_240m; NASA PDS official 60°S-90°S 240m grid" if dem.sha256 == PACKAGED_SHA256_60S
            else "Configured local grid; source identity not established by this module"
        ),
        "file": dem.path,
        "sha256": dem.sha256,
        "matches_packaged_asset": packaged,
        "frame": FRAME,
        "reference_radius_m": MOON_RADIUS_M,
        "projection": "spherical south-polar stereographic",
        "bounds_projected_m": {
            "x_min": -dem.sample0 * dem.spacing,
            "x_max": (cols - 1 - dem.sample0) * dem.spacing,
            "y_min": (dem.line0 - rows + 1) * dem.spacing,
            "y_max": dem.line0 * dem.spacing,
        },
        "point_projected_m": {"x": x, "y": y},
        "surface_elevation_m": elevation,
        "rows": rows, "cols": cols,
        "spacing_m": dem.spacing,
        "scale_m": dem.scale,
        "sampling": "Bilinear interpolation of measured grid; required nodata corners rejected; no extrapolation or gap filling",
        "use": "Center footprint validation on calculation DEM. Horizon validates every ray sample and reports finite/truncated extent; slope requires its own 3x3 neighborhood. Interpolation adds no measured resolution.",
    }
