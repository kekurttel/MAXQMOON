"""Controlled epoch replay, not an ML backtest or independent observations.

The reference uses another SPICE observer API and an explicit ENU matrix, but
shares the production kernels. Tiny errors establish internal consistency only.
"""
import hashlib
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

from app.skyview import (FRAME, SPICE_LOCK, SkyViewUnavailable, _attach_transitions,
                         _visibility, compute_skyview, iso_utc, kernel_inventory,
                         observer_basis, parse_utc, project_target, sample_times)
from app.skyview_planning import visibility_summary

REAL_KERNELS = pytest.mark.skipif(
    not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
WINDOWS = [
    ("2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z", 745),
    ("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", 745),
    ("2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z", 25),
]


@REAL_KERNELS
@pytest.mark.parametrize("lat,lon", [(-89.4395, -137.1934), (-88.679, -68.1)])
@pytest.mark.parametrize("start,end,count", WINDOWS)
def test_historical_and_current_epoch_replay(lat, lon, start, end, count, record_property):
    import spiceypy as spice

    result = compute_skyview(lat, lon, start, end, 3600)
    points = result["points"]
    times = [parse_utc(point["time_utc"]) for point in points]
    assert len(points) == count
    assert times[0] == parse_utc(start) and times[-1] == parse_utc(end)
    assert all((right - left).total_seconds() == 3600 for left, right in zip(times, times[1:]))
    assert result["frame"] == FRAME
    assert result["provenance"]["aberration_correction"] == "NONE"
    kernels = kernel_inventory()
    assert result["provenance"]["kernels"] == [{k: v for k, v in item.items() if k != "path"} for item in kernels]
    for item in kernels:
        assert hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest() == item["sha256"]

    # Explicit analytic rotation: no production observer_basis/project_target.
    latitude, longitude = math.radians(lat), math.radians(lon)
    sl, cl = math.sin(latitude), math.cos(latitude)
    so, co = math.sin(longitude), math.cos(longitude)
    rotation = np.array([[-so, co, 0], [-sl * co, -sl * so, cl], [cl * co, cl * so, sl]])
    observer = rotation[2] * (1737400 + result["site"]["surface_elevation_m"] + 2) / 1000
    maxima = {"azimuth_deg": 0.0, "elevation_deg": 0.0, "distance_km": 0.0}
    with SPICE_LOCK:
        loaded = []
        try:
            for kernel in kernels:
                spice.furnsh(kernel["path"])
                loaded.append(kernel["path"])
            for point in points:
                et = spice.str2et(point["time_utc"])
                for body in ("sun", "earth"):
                    state, _ = spice.spkcpo(body.upper(), et, FRAME, "OBSERVER", "NONE", observer, "MOON", FRAME)
                    east, north, up = rotation @ np.asarray(state[:3])
                    azimuth = math.degrees(math.atan2(east, north)) % 360
                    elevation = math.degrees(math.atan2(up, math.hypot(east, north)))
                    actual = point[body]
                    errors = {
                        "azimuth_deg": abs((actual["azimuth_deg"] - azimuth + 180) % 360 - 180),
                        "elevation_deg": abs(actual["elevation_deg"] - elevation),
                        "distance_km": abs(actual["distance_km"] - np.linalg.norm(state[:3])),
                    }
                    for key, error in errors.items():
                        maxima[key] = max(maxima[key], float(error))
                        assert error < (1e-6 if key == "distance_km" else 1e-9)
                    assert 0 <= actual["azimuth_deg"] < 360
                    assert -90 <= actual["elevation_deg"] <= 90
                    assert math.isfinite(actual["distance_km"]) and actual["distance_km"] > 0
                    assert actual["clearance_deg"] == actual["elevation_deg"] - actual["horizon_elevation_deg"]
                    assert actual["center_visible"] == (actual["clearance_deg"] > 0)
        finally:
            for path in reversed(loaded):
                spice.unload(path)
    for key, value in maxima.items():
        record_property("max_" + key, value)

    for body, field in (("sun", "hours_until_sunset"), ("earth", "hours_until_earthset")):
        states = [point[body]["center_visible"] for point in points]
        changes = [i for i in range(1, count) if states[i] != states[i - 1]]
        sets = [i for i in changes if not states[i]]
        record_property(body + "_transitions", len(changes))
        record_property(body + "_sets", len(sets))
        for i, point in enumerate(points):
            transition = next((j for j in changes if j > i), None)
            expected = None if transition is None else {
                "after_utc": points[transition - 1]["time_utc"],
                "by_utc": points[transition]["time_utc"],
                "becomes_visible": states[transition],
            }
            assert point[body]["next_transition"] == expected
            next_set = next((j for j in sets if j > i), None)
            hours = None if next_set is None else (times[next_set] - times[i]).total_seconds() / 3600
            assert point[field] == hours

    summary = visibility_summary(result, 0)
    duration = (times[-1] - times[0]).total_seconds() / 3600
    for body, name in (("sun", "sunlight"), ("earth", "earth_visible")):
        hours = sum((right - left).total_seconds() / 3600 *
                    (int(a[body]["center_visible"]) + int(b[body]["center_visible"])) / 2
                    for left, right, a, b in zip(times, times[1:], points, points[1:]))
        assert summary["total_" + name + "_hours"] == pytest.approx(hours, abs=1e-12)
        assert summary[name + "_percentage"] == pytest.approx(hours / duration * 100, abs=1e-12)
        bounds = summary["visibility_hour_bounds"][name]
        assert 0 <= bounds["lower_hours"] <= hours <= bounds["upper_hours"] <= duration


def test_strict_center_visibility_threshold():
    horizon = {"azimuths_deg": [0, 180, 360], "elevations_deg": [2, 2, 2]}
    for elevation, visible in ((2 - 1e-9, False), (2, False), (2 + 1e-9, True)):
        assert _visibility({"azimuth_deg": 0, "elevation_deg": elevation}, horizon)["center_visible"] is visible


def test_nonuniform_endpoint_integration_and_no_extrapolated_set():
    times = sample_times("2026-11-15T00:00:00Z", "2026-11-15T00:11:00Z", 600)
    points = [{"time_utc": iso_utc(t), "sun": {"center_visible": state}, "earth": {"center_visible": state}}
              for t, state in zip(times, (True, True, False))]
    for body in ("sun", "earth"):
        _attach_transitions(points, times, body)
    result = {"points": points, "start_utc": iso_utc(times[0]), "end_utc": iso_utc(times[-1]), "provenance": {}}
    summary = visibility_summary(result, 0)
    for body, field, name in (("sun", "hours_until_sunset", "sunlight"),
                              ("earth", "hours_until_earthset", "earth_visible")):
        assert summary["total_" + name + "_hours"] == pytest.approx(10.5 / 60)
        assert points[0][field] == pytest.approx(11 / 60)
        assert points[1][field] == pytest.approx(1 / 60)
        assert points[-1][field] is None
        assert points[-1][body]["next_transition"] is None
        assert points[1][body]["next_transition"]["by_utc"] == iso_utc(times[-1])


@pytest.mark.parametrize("percent,verdict", [(49, "red"), (50, "yellow"), (79, "yellow"), (80, "green")])
def test_exact_verdict_thresholds(percent, verdict):
    start = datetime(2026, 11, 15, tzinfo=timezone.utc)
    points = [{"time_utc": iso_utc(start + timedelta(seconds=second)),
               "sun": {"center_visible": visible}, "earth": {"center_visible": visible}}
              for second, visible in ((0, True), (2 * percent - 1, True), (2 * percent + 1, False), (200, False))]
    result = {"points": points, "start_utc": points[0]["time_utc"], "end_utc": points[-1]["time_utc"], "provenance": {}}
    summary = visibility_summary(result, 0)
    assert summary["sunlight_percentage"] == percent
    assert summary["earth_visible_percentage"] == percent
    assert summary["verdict"] == verdict


@pytest.mark.parametrize("lat,lon,surface,height", [(float("nan"), 0, 0, 2), (-91, 0, 0, 2), (-89, 0, 0, -1)])
def test_invalid_observer_bounds(lat, lon, surface, height):
    with pytest.raises(ValueError):
        observer_basis(lat, lon, surface, height)


def test_nonfinite_target_rejected():
    with pytest.raises(SkyViewUnavailable, match="nonfinite target vector"):
        project_target(np.array([float("nan"), 0, 0]), observer_basis(-89, 0, 0, 2))


def test_boolean_timestep_rejected():
    with pytest.raises(ValueError, match="step_seconds must be an integer"):
        sample_times("2026-11-15T00:00:00Z", "2026-11-16T00:00:00Z", True)


@REAL_KERNELS
def test_epoch_outside_kernel_coverage_fails_without_extrapolation():
    with pytest.raises(SkyViewUnavailable, match="SPICE frame/time calculation failed"):
        compute_skyview(-89.4395, -137.1934, "2200-01-01T00:00:00Z", "2200-01-01T01:00:00Z", 3600)
