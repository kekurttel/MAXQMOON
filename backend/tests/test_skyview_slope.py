"""Analytic plane fixtures verify the slope fit, not runtime terrain data."""
import math
from types import SimpleNamespace

import numpy as np
import pytest

from app import skyview_slope as slope
from app.horizon import TerrainUnavailable


@pytest.mark.parametrize("lat,lon,a,b", [(-90, 0, 0, 0), (-89, 42, 0.1, -0.2), (-88, -137, -0.3, 0.15)])
def test_local_slope_recovers_plane_in_observer_enu(monkeypatch, lat, lon, a, b):
    latitude, longitude = math.radians(lat), math.radians(lon)
    up = np.array([math.cos(latitude) * math.cos(longitude), math.cos(latitude) * math.sin(longitude), math.sin(latitude)])
    east = np.array([-math.sin(longitude), math.cos(longitude), 0.0])
    north = np.cross(up, east)
    normal = up - a * east - b * north

    def sample(x, y):
        phi, lam = map(math.radians, slope.inverse_south_polar(x, y))
        unit = np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])
        # Intersect the radial direction with an exact ENU plane through R * up.
        return slope.MOON_RADIUS_M / float(unit @ normal) - slope.MOON_RADIUS_M

    dem = SimpleNamespace(spacing=200.0, sha256="analytic-plane-fixture", sample=sample)
    monkeypatch.setattr(slope, "_load_dem", lambda: dem)
    result = slope.local_slope(lat, lon)
    assert result["slope_deg"] == pytest.approx(math.degrees(math.atan(math.hypot(a, b))), abs=1e-8)
    assert result["fit_rms_m"] < 1e-8
    assert result["sample_count"] == 9
    assert result["neighborhood_projected_width_m"] == 400


def test_local_slope_does_not_fill_missing_neighbors(monkeypatch):
    x, y = slope.project_south_polar(-89, 0)

    def sample(px, py):
        if px != x or py != y:
            raise TerrainUnavailable("missing measured neighbor")
        return 0

    monkeypatch.setattr(slope, "_load_dem", lambda: SimpleNamespace(spacing=200, sample=sample))
    with pytest.raises(TerrainUnavailable, match="missing measured neighbor"):
        slope.local_slope(-89, 0)
