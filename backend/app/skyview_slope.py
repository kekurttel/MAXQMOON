"""Measured neighbourhood slope, independent of rendered terrain normals."""
import math

import numpy as np

from .horizon import (FRAME, MOON_RADIUS_M, _load_dem, inverse_south_polar,
                      project_south_polar)


def local_slope(lat: float, lon: float) -> dict:
    """Fit a plane to nine DEM samples in local spherical ENU coordinates.

    This is a grid-scale estimate, not a landing-footprint roughness assessment.
    Required missing/boundary cells fail through the DEM sampler.
    """
    dem = _load_dem()
    x, y = project_south_polar(lat, lon)
    latitude, longitude = math.radians(lat), math.radians(lon)
    up = np.array([math.cos(latitude) * math.cos(longitude), math.cos(latitude) * math.sin(longitude), math.sin(latitude)])
    east = np.array([-math.sin(longitude), math.cos(longitude), 0.0])
    north = np.cross(up, east)
    center = (MOON_RADIUS_M + float(dem.sample(x, y))) * up
    rows, heights = [], []
    for dy in (-dem.spacing, 0, dem.spacing):
        for dx in (-dem.spacing, 0, dem.spacing):
            a, b = inverse_south_polar(x + dx, y + dy)
            a, b = math.radians(a), math.radians(b)
            unit = np.array([math.cos(a) * math.cos(b), math.cos(a) * math.sin(b), math.sin(a)])
            relative = (MOON_RADIUS_M + float(dem.sample(x + dx, y + dy))) * unit - center
            rows.append([float(relative @ east), float(relative @ north), 1.0])
            heights.append(float(relative @ up))
    fit, _, _, _ = np.linalg.lstsq(rows, heights, rcond=None)
    residuals = np.asarray(rows) @ fit - heights
    return {"slope_deg": math.degrees(math.atan(math.hypot(float(fit[0]), float(fit[1])))),
            "method": "least-squares plane in local spherical ENU; 3x3 bilinear DEM samples",
            "frame": FRAME, "sample_count": 9, "grid_spacing_m": dem.spacing,
            "neighborhood_projected_width_m": 2 * dem.spacing,
            "fit_rms_m": float(np.sqrt(np.mean(residuals ** 2))),
            "dem_sha256": dem.sha256,
            "limits": "Grid-scale estimate only; interpolation adds no resolution. Not local hazard, roughness or landing certification."}
