"""Analytic unit checks plus optional real-kernel integration. No runtime fixtures."""
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from app.skyview import (FRAME, SkyViewUnavailable, _attach_transitions,
                         compute_skyview, kernel_inventory, observer_basis,
                         project_target, sample_times)


def test_sample_grid_includes_actual_end():
    times = sample_times("2027-01-01T00:00:00Z", "2027-01-01T00:11:00Z", 600)
    assert [t.minute for t in times] == [0, 10, 11]


@pytest.mark.parametrize("first,last,step", [
    ("2027-01-01", "2027-01-02T00:00:00Z", 600),
    ("2027-01-01T00:00:00Z", "2027-01-01T00:00:00Z", 600),
    ("2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z", 60),
    ("2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z", 0),
])
def test_invalid_grid_rejected(first, last, step):
    with pytest.raises(ValueError):
        sample_times(first, last, step)


@pytest.mark.parametrize("lat,lon", [(-89, -137), (-89.4395, -137.1934), (-88.679, -68.1)])
def test_projection_compass_and_scale_analytic(lat, lon):
    basis = observer_basis(lat, lon, 1000, 2)
    observer, east, north, up = basis
    for azimuth in (0, 90, 180, 270, 359):
        for altitude in (-5, 0, 7.2, 80):
            az, alt = math.radians(azimuth), math.radians(altitude)
            direction = (east * math.sin(az) + north * math.cos(az)) * math.cos(alt) + up * math.sin(alt)
            point = project_target(observer + direction * 400000, basis)
            assert 0 <= point["azimuth_deg"] < 360
            assert point["azimuth_deg"] == pytest.approx(azimuth, abs=1e-9)
            assert point["elevation_deg"] == pytest.approx(altitude, abs=1e-9)


def test_projection_keeps_genuine_near_north_angle():
    basis = observer_basis(-89.4395, -137.1934, 1000, 2)
    observer, east, north, _ = basis
    azimuth = 359.99999999
    angle = math.radians(azimuth)
    point = project_target(observer + 400000 * (east * math.sin(angle) + north * math.cos(angle)), basis)
    assert point["azimuth_deg"] != 0
    assert point["azimuth_deg"] == pytest.approx(azimuth, abs=1e-10)


def test_missing_kernels_fail_no_fallback(tmp_path):
    with patch.dict(os.environ, {"LUNAR_KERNEL_DIR": str(tmp_path)}):
        with pytest.raises(SkyViewUnavailable, match="Missing SPICE kernel"):
            kernel_inventory()


def test_transition_is_bracket_not_invented_event():
    points = [{"sun": {"center_visible": state}} for state in (False, False, True, True)]
    times = sample_times("2027-01-01T00:00:00Z", "2027-01-01T00:30:00Z", 600)
    _attach_transitions(points, times, "sun")
    event = points[0]["sun"]["next_transition"]
    assert event["after_utc"] == "2027-01-01T00:10:00.000Z"
    assert event["by_utc"] == "2027-01-01T00:20:00.000Z"
    assert points[-1]["sun"]["next_transition"] is None


@pytest.mark.parametrize("body,field", [("sun", "hours_until_sunset"), ("earth", "hours_until_earthset")])
@pytest.mark.parametrize("states,expected_minutes", [
    ((True, True, False, False), (20, 10, None, None)),
    ((False, True, True, False), (30, 20, 10, None)),
    ((True, False, True, False), (10, 20, 10, None)),
    ((False, False, False, False), (None, None, None, None)),
    ((True, True, True, True), (None, None, None, None)),
    ((False, False, True, True), (None, None, None, None)),
])
def test_time_to_next_set_preserves_visibility(body, field, states, expected_minutes):
    points = [{body: {"center_visible": state}} for state in states]
    times = sample_times("2027-01-01T00:00:00Z", "2027-01-01T00:30:00Z", 600)
    _attach_transitions(points, times, body)
    for point, state, minutes in zip(points, states, expected_minutes):
        assert point[body]["center_visible"] is state
        if minutes is None:
            assert point[field] is None
        else:
            assert point[field] == pytest.approx(minutes / 60)


def test_time_to_set_uses_actual_short_final_step():
    times = sample_times("2027-01-01T00:00:00Z", "2027-01-01T00:11:00Z", 600)
    points = [{"sun": {"center_visible": state}} for state in (True, True, False)]
    _attach_transitions(points, times, "sun")
    assert points[0]["hours_until_sunset"] == pytest.approx(11 / 60)
    assert points[1]["hours_until_sunset"] == pytest.approx(1 / 60)
    assert points[2]["hours_until_sunset"] is None
    assert points[1]["sun"]["next_transition"]["by_utc"] == "2027-01-01T00:11:00.000Z"


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_real_spice_and_real_dem_match_spkcpo():
    import spiceypy as spice
    result = compute_skyview(-89.4395, -137.1934, "2027-01-01T00:00:00Z", "2027-01-01T01:00:00Z", 600)
    assert result["frame"] == FRAME
    assert len(result["points"]) == 7
    assert len(result["provenance"]["kernels"]) == 4
    assert all(len(k["sha256"]) == 64 for k in result["provenance"]["kernels"])
    assert result["provenance"]["time_to_set"]["resolution_seconds"] == 600
    for i, point in enumerate(result["points"]):
        for body, field in (("sun", "hours_until_sunset"), ("earth", "hours_until_earthset")):
            next_set = next((later for j, later in enumerate(result["points"][i + 1:], i + 1)
                             if result["points"][j - 1][body]["center_visible"] and not later[body]["center_visible"]), None)
            if next_set is None:
                assert point[field] is None
            else:
                expected_hours = (datetime.fromisoformat(next_set["time_utc"]) - datetime.fromisoformat(point["time_utc"])).total_seconds() / 3600
                assert point[field] == pytest.approx(expected_hours)
    basis = observer_basis(-89.4395, -137.1934, result["site"]["surface_elevation_m"], 2)
    loaded = []
    try:
        for item in kernel_inventory():
            spice.furnsh(item["path"])
            loaded.append(item["path"])
        for point in result["points"]:
            et = spice.str2et(point["time_utc"])
            for body in ("sun", "earth"):
                # SPICE independently subtracts the surface observer in spkcpo.
                state, _ = spice.spkcpo(body.upper(), et, FRAME, "OBSERVER", "NONE", basis[0], "MOON", FRAME)
                _, east, north, up = basis
                vector = np.asarray(state[:3])
                altitude = math.degrees(math.atan2(np.dot(vector, up), math.hypot(np.dot(vector, east), np.dot(vector, north))))
                azimuth = math.degrees(math.atan2(np.dot(vector, east), np.dot(vector, north))) % 360
                assert point[body]["elevation_deg"] == pytest.approx(altitude, abs=1e-9)
                assert point[body]["azimuth_deg"] == pytest.approx(azimuth, abs=1e-9)
                assert math.isfinite(point[body]["horizon_elevation_deg"])
    finally:
        for path in reversed(loaded):
            spice.unload(path)


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_real_january_illumination_and_july_shadow_not_constant_visibility():
    from app.skyview_planning import visibility_summary

    for start, end, continuous in (
        ("2027-01-01T00:00:00Z", "2027-01-08T00:00:00Z", True),
        ("2027-01-08T00:00:00Z", "2027-01-15T00:00:00Z", True),
        ("2027-01-15T00:00:00Z", "2027-01-22T00:00:00Z", True),
        ("2027-07-01T00:00:00Z", "2027-07-08T00:00:00Z", False),
    ):
        result = compute_skyview(-89.4395, -137.1934, start, end, 600)
        sun = [point["sun"] for point in result["points"]]
        total = visibility_summary(result, 0)["total_sunlight_hours"]
        assert all(body["center_visible"] == (body["clearance_deg"] > 0) for body in sun)
        if continuous:
            assert min(body["clearance_deg"] for body in sun) > 0
            assert total == 168
        else:
            assert min(body["clearance_deg"] for body in sun) < 0
            assert max(body["clearance_deg"] for body in sun) > 0
            assert 0 < total < 168
            assert any(point["hours_until_sunset"] is not None for point in result["points"])


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_real_month_contains_both_set_countdowns():
    result = compute_skyview(-88.679, -68.1, "2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z", 3600)
    points = result["points"]
    for body, field in (("sun", "hours_until_sunset"), ("earth", "hours_until_earthset")):
        sets = [i for i in range(1, len(points))
                if points[i - 1][body]["center_visible"] and not points[i][body]["center_visible"]]
        assert sets, f"Real DEM/SPICE series should contain a {body} set in this window"
        for i, point in enumerate(points):
            next_set = next((j for j in sets if j > i), None)
            if next_set is None:
                assert point[field] is None
            else:
                delta = (datetime.fromisoformat(points[next_set]["time_utc"]) - datetime.fromisoformat(point["time_utc"]))
                assert point[field] == pytest.approx(delta.total_seconds() / 3600)
