"""Calculation coverage follows measured grid, never a second raw-file gate."""
import os
import struct

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app import skyview_router as api
from app.dem_coverage import DEMCoverageUnavailable, OUTSIDE_DEM_DETAIL, validate_dem_coverage
from app.horizon import (DEFAULT_DEM_PATH, PACKAGED_SHA256, TerrainUnavailable,
                         compute_horizon, inverse_south_polar)
from app.skyview_slope import local_slope

START = "2027-01-01T00:00:00Z"
END = "2027-01-01T00:10:00Z"


@pytest.fixture
def packaged(monkeypatch, tmp_path):
    monkeypatch.setenv("LUNAR_DEM_PATH", str(DEFAULT_DEM_PATH))
    # This nonexistent raw path must have no bearing on measured calculations.
    monkeypatch.setenv("LUNAR_PDS_DEM_PATH", str(tmp_path / "absent.img"))


def test_packaged_measured_grid_supports_arbitrary_coordinates(packaged):
    lat, lon = -89.4321, 42.1234
    coverage = validate_dem_coverage(lat, lon)
    horizon = compute_horizon(lat, lon, azimuth_step_deg=90, max_distance_m=1000)
    slope = local_slope(lat, lon)
    assert coverage["sha256"] == horizon["provenance"]["sha256"] == slope["dem_sha256"] == PACKAGED_SHA256
    assert coverage["spacing_m"] == horizon["provenance"]["spacing_m"] == slope["grid_spacing_m"] == 200
    assert coverage["surface_elevation_m"] == horizon["surface_elevation_m"]
    assert coverage["matches_packaged_asset"] is True
    assert validate_dem_coverage(lat, lon + 360)["point_projected_m"] == pytest.approx(coverage["point_projected_m"])


@pytest.mark.parametrize("lat,lon", [(0, 0), (90, 0), (-80, 45)])
def test_true_outside_coverage_fails(packaged, lat, lon):
    with pytest.raises(TerrainUnavailable, match=OUTSIDE_DEM_DETAIL):
        validate_dem_coverage(lat, lon)


@pytest.mark.parametrize("payload", [b"", b"broken", struct.pack("<IIffff", 2, 2, 200, 0, 0, .5),
                                      struct.pack("<IIffff", 2, 2, float("nan"), 0, 0, .5) + b"\0" * 8])
def test_corrupt_grid_is_service_failure(monkeypatch, tmp_path, payload):
    path = tmp_path / "bad.bin"
    path.write_bytes(payload)
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        response = client.post("/api/skyview/custom", json={"lat": -89, "lon": 0, "start_utc": START, "end_utc": END})
    assert response.status_code == 503
    assert "Invalid DEM" in response.json()["detail"]


def test_nodata_and_finite_boundaries_fail_without_extrapolation(monkeypatch, tmp_path):
    path = tmp_path / "grid.bin"
    header = struct.pack("<IIffff", 3, 3, 200, 1, 1, .5)
    path.write_bytes(header + struct.pack("<9h", *([0] * 8 + [-32768])))
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    with pytest.raises(TerrainUnavailable, match="nodata"):
        validate_dem_coverage(-90, 0)
    lat, lon = inverse_south_polar(201, 0)
    with pytest.raises(TerrainUnavailable, match=OUTSIDE_DEM_DETAIL):
        validate_dem_coverage(lat, lon)
    path.write_bytes(header + struct.pack("<9h", *([0] * 9)))
    lat, lon = inverse_south_polar(190, 0)
    assert validate_dem_coverage(lat, lon)["spacing_m"] == 200
    with pytest.raises(TerrainUnavailable, match="outside"):
        local_slope(lat, lon)
    with pytest.raises(TerrainUnavailable, match="first horizon sample"):
        compute_horizon(lat, lon, azimuth_step_deg=90, max_distance_m=1000)


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_catalog_equivalent_custom_and_arbitrary_point_real_spice(packaged):
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        site = api.site_by_id("shackleton_ridge")
        body = {"lat": site["lat"], "lon": site["lon"], "start_utc": START, "end_utc": END}
        custom = client.post("/api/skyview/custom", json=body)
        series = client.post("/api/skyview/series", json={"site_id": site["id"], "start_utc": START, "end_utc": END})
        assert custom.status_code == series.status_code == 200, (custom.text, series.text)
        result = custom.json()
        coverage = result["provenance"].pop("coordinate_coverage")
        assert coverage["sha256"] == PACKAGED_SHA256
        assert coverage["spacing_m"] == 200
        assert result == series.json()
        arbitrary = client.post("/api/skyview/custom", json={**body, "lat": -89.4321, "lon": 42.1234})
        assert arbitrary.status_code == 200, arbitrary.text
        assert arbitrary.json()["site"]["lat_deg"] == -89.4321
        assert arbitrary.json()["site"]["lon_deg"] == pytest.approx(42.1234)
        assert arbitrary.json()["horizon"]["provenance"]["spacing_m"] == 200
        pole = client.post("/api/skyview/custom", json={**body, "lat": -90, "lon": 0})
        assert pole.status_code == 200, pole.text
