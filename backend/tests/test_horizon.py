"""Analytic unit fixtures are not runtime terrain; smoke test uses shipped DEM."""

import math
from pathlib import Path
import struct

import numpy as np
import pytest

from app import horizon


def write_grid(tmp_path, values, spacing=200.0, scale=0.5):
    """Write explicitly synthetic analytic test cells only."""
    path = tmp_path / "analytic-unit-fixture.bin"
    rows, cols = values.shape
    path.write_bytes(struct.pack("<IIffff", rows, cols, spacing, (rows - 1) / 2, (cols - 1) / 2, scale) + np.asarray(values, dtype="<i2").tobytes())
    return path


@pytest.fixture
def sphere_dem(tmp_path, monkeypatch):
    path = write_grid(tmp_path, np.zeros((101, 101), dtype=np.int16))
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    return path


@pytest.mark.parametrize("latitude,longitude", [(-90, 0), (-89, 30), (-85, -120), (-88, 180), (-87, 359)])
def test_projection_inverse(latitude, longitude):
    x, y = horizon.project_south_polar(latitude, longitude)
    lat, lon = horizon.inverse_south_polar(x, y)
    assert lat == pytest.approx(latitude, abs=1e-10)
    if latitude != -90:
        assert (lon - longitude + 180) % 360 - 180 == pytest.approx(0, abs=1e-10)
    rho = 2 * horizon.MOON_RADIUS_M * math.tan(math.radians(90 + latitude) / 2)
    assert x == pytest.approx(rho * math.sin(math.radians(longitude)))
    assert y == pytest.approx(rho * math.cos(math.radians(longitude)))


def test_bilinear_measured_values(tmp_path, monkeypatch):
    path = write_grid(tmp_path, np.array([[0, 2], [4, 6]]), spacing=100)
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    dem = horizon._load_dem()
    assert float(dem.sample(0, 0)) == pytest.approx(1.5)
    assert float(dem.sample(-50, 50)) == pytest.approx(0)
    assert float(dem.sample(50, -50)) == pytest.approx(3)
    with pytest.raises(horizon.TerrainUnavailable, match="outside"):
        dem.sample(51, 0)


@pytest.mark.parametrize("latitude,longitude", [(-90, 0), (-89.9, 42), (-89.85, -120)])
def test_sphere_topocentric_altitude_and_closed_azimuths(sphere_dem, latitude, longitude):
    result = horizon.compute_horizon(latitude, longitude, azimuth_step_deg=45, max_distance_m=5000)
    distances = np.concatenate(([50, 100], np.arange(200, 5000, 200), [5000]))
    angles = distances / horizon.MOON_RADIUS_M
    expected = np.degrees(np.arctan2(horizon.MOON_RADIUS_M * (np.cos(angles) - 1) - 2, horizon.MOON_RADIUS_M * np.sin(angles))).max()
    assert result["elevations_deg"] == pytest.approx([expected] * 9, abs=1e-9)
    assert result["azimuths_deg"] == list(range(0, 361, 45))
    assert result["elevations_deg"][-1] == result["elevations_deg"][0]
    assert result["coverage"]["near_sample_distances_m"] == [50, 100]
    assert result["coverage"]["truncated"] is False
    assert result["coverage"]["whole_moon_horizon_certified"] is False
    assert result["provenance"]["matches_packaged_asset"] is False


def test_azimuth_is_east_positive_from_north(tmp_path, monkeypatch):
    cells = np.zeros((101, 101), dtype=np.int16)
    # At the south pole with longitude 0, east points toward projected +x.
    cells[49:52, 55:57] = 1000
    path = write_grid(tmp_path, cells)
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    result = horizon.compute_horizon(-90, 0, azimuth_step_deg=90, max_distance_m=3000)
    assert result["elevations_deg"][1] > 20
    assert result["elevations_deg"][3] < 0


def test_observer_height_and_curvature_are_physical(sphere_dem):
    ground = horizon.compute_horizon(-90, 0, observer_height_m=0, azimuth_step_deg=90, max_distance_m=1000)
    raised = horizon.compute_horizon(-90, 0, observer_height_m=20, azimuth_step_deg=90, max_distance_m=1000)
    # Sphere at ground level is already below the local tangent, not a flat 0°.
    assert ground["elevations_deg"][0] == pytest.approx(-math.degrees(50 / horizon.MOON_RADIUS_M / 2), abs=1e-8)
    assert raised["elevations_deg"][0] < ground["elevations_deg"][0]


def test_grid_exit_reports_per_ray_truncation(sphere_dem):
    result = horizon.compute_horizon(-90, 0, azimuth_step_deg=45, max_distance_m=20000)
    assert result["coverage"]["truncated"] is True
    assert result["coverage"]["complete_within_requested_radius"] is False
    assert all(0 < ray["max_distance_m"] < 20000 for ray in result["coverage"]["rays"])
    assert result["coverage"]["per_ray_max_distance_m"][1] > result["coverage"]["per_ray_max_distance_m"][0]
    assert "Unknown" in result["coverage"]["beyond_sampled_extent"]


def test_nodata_mid_ray_fails_closed(tmp_path, monkeypatch):
    cells = np.zeros((101, 101), dtype=np.int16)
    cells[40, 50] = -32768  # Northward ray, about two kilometres from observer.
    path = write_grid(tmp_path, cells)
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    with pytest.raises(horizon.TerrainUnavailable, match="nodata"):
        horizon.compute_horizon(-90, 0, azimuth_step_deg=90, max_distance_m=4000)


@pytest.mark.parametrize("missing", [-32767, -32768])
def test_nodata_bilinear_footprint_is_not_filled(tmp_path, monkeypatch, missing):
    cells = np.zeros((3, 3), dtype=np.int16)
    cells[0, 0] = missing
    path = write_grid(tmp_path, cells)
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    with pytest.raises(horizon.TerrainUnavailable, match="nodata"):
        horizon._load_dem().sample(-50, 50)


def test_missing_file_actionable(tmp_path, monkeypatch):
    monkeypatch.setenv("LUNAR_DEM_PATH", str(tmp_path / "missing.bin"))
    with pytest.raises(horizon.TerrainUnavailable, match="LUNAR_DEM_PATH"):
        horizon.compute_horizon(-90, 0)


@pytest.mark.parametrize("header,payload", [
    (b"short", b""),
    (struct.pack("<IIffff", 0, 3, 200, 1, 1, 0.5), b""),
    (struct.pack("<IIffff", 100000, 100000, 200, 1, 1, 0.5), b""),
    (struct.pack("<IIffff", 2, 2, float("nan"), 1, 1, 0.5), b"\0" * 8),
    (struct.pack("<IIffff", 2, 2, 200, 1, 1, -1), b"\0" * 8),
    (struct.pack("<IIffff", 2, 2, 200, 1, 1, 0.5), b"\0" * 6),
    (struct.pack("<IIffff", 2, 2, 200, 1, 1, 0.5), b"\0" * 10),
])
def test_malformed_grid_rejected(tmp_path, monkeypatch, header, payload):
    path = tmp_path / "malformed-unit-fixture.bin"
    path.write_bytes(header + payload)
    monkeypatch.setenv("LUNAR_DEM_PATH", str(path))
    with pytest.raises(horizon.TerrainUnavailable, match="Invalid DEM"):
        horizon.compute_horizon(-90, 0)


@pytest.mark.parametrize("kwargs", [
    {"frame": "J2000"}, {"lat_deg": 90}, {"lat_deg": float("nan")},
    {"observer_height_m": -1}, {"azimuth_step_deg": 7}, {"azimuth_step_deg": 0},
    {"max_distance_m": 0}, {"distance_step_m": 0},
    {"azimuth_step_deg": 0.001}, {"max_distance_m": float("inf")},
])
def test_request_validation(sphere_dem, kwargs):
    request = {"lat_deg": -90, "lon_deg": 0, **kwargs}
    with pytest.raises(horizon.TerrainUnavailable):
        horizon.compute_horizon(**request)


def test_out_of_coverage_site_never_extrapolates(sphere_dem):
    with pytest.raises(horizon.TerrainUnavailable, match="outside"):
        horizon.compute_horizon(-85, 0)


def test_cyclic_interpolation():
    skyline = {"azimuths_deg": [0, 90, 180, 270, 360], "elevations_deg": [0, 2, 4, 6, 0]}
    assert horizon.horizon_at(skyline, 45) == pytest.approx(1)
    assert horizon.horizon_at(skyline, 315) == pytest.approx(3)
    assert horizon.horizon_at(skyline, -45) == pytest.approx(3)
    assert horizon.horizon_at(skyline, 720) == pytest.approx(0)
    skyline = {"azimuths_deg": [10, 180, 350], "elevations_deg": [2, 4, 0]}
    assert horizon.horizon_at(skyline, 0) == pytest.approx(1)


@pytest.mark.parametrize("skyline", [
    {"azimuths_deg": [0, 360], "elevations_deg": [1, 2]},
    {"azimuths_deg": [0, 0], "elevations_deg": [1, 1]},
    {"azimuths_deg": [0, 90], "elevations_deg": [1]},
    {"azimuths_deg": [0, 90], "elevations_deg": [1, float("nan")]},
])
def test_bad_interpolation_inputs(skyline):
    with pytest.raises(horizon.TerrainUnavailable):
        horizon.horizon_at(skyline, 45)


def test_packaged_measured_dem_smoke(monkeypatch):
    monkeypatch.delenv("LUNAR_DEM_PATH", raising=False)
    assert Path(horizon.DEFAULT_DEM_PATH).is_file(), "The measured packaged DEM is required; no synthetic runtime fallback."
    result = horizon.compute_horizon(-89.9, 0, max_distance_m=2000, azimuth_step_deg=10)
    assert result["provenance"]["sha256"] == horizon.PACKAGED_SHA256
    assert result["provenance"]["matches_packaged_asset"] is True
    assert result["provenance"]["rows"] == 1517
    assert result["provenance"]["cols"] == 1517
    assert result["frame"] == "MOON_ME_DE421"
    assert result["geodetic"] == "planetocentric"
    assert len(result["elevations_deg"]) == 37
    assert np.all(np.isfinite(result["elevations_deg"]))
    assert result["surface_elevation_m"] != 0
