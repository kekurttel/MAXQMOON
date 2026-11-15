"""Planning validation, sampled integration, and optional real DEM/SPICE checks."""
import math
import os

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from app import skyview_router as api
from app.dem_coverage import DEMCoverageUnavailable, OUTSIDE_DEM_DETAIL
from app.horizon import TerrainUnavailable
from app.skyview import SkyViewUnavailable, iso_utc, parse_utc, sample_times
from app.skyview_planning import (CompareScenario, ScheduleShockRequest, schedule_windows,
                                  visibility_summary)

START = "2027-01-01T00:00:00Z"
END = "2027-01-01T02:00:00Z"
COORDS = {"lat": -89.4395, "lon": -137.1934}
CUSTOM = {**COORDS, "start_utc": START, "end_utc": END}
SITE = {"site_id": "shackleton_ridge", "start_utc": START, "end_utc": END}
SCHEDULE = {**COORDS, "base_date": "2027-01-01", "duration_days": 2 / 24, "delay_days": [0, 7]}


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def fake_engine(monkeypatch):
    """A deterministic fixture exists in tests only, never in runtime code."""
    calls = []

    def compute(lat, lon, start, end, step=600):
        calls.append((lat, lon, start, end, step))
        times = sample_times(start, end, step)
        return {"site": {"lat_deg": lat, "lon_deg": lon}, "start_utc": iso_utc(times[0]),
                "end_utc": iso_utc(times[-1]), "step_seconds": step,
                "points": [{"time_utc": iso_utc(t), "sun": {"center_visible": True},
                            "earth": {"center_visible": True}} for t in times],
                "provenance": {"test_fixture": True}}

    monkeypatch.setattr(api, "compute_skyview", compute)
    monkeypatch.setattr(api, "validate_dem_coverage", lambda lat, lon: {"test_coverage": True})
    return calls


@pytest.mark.parametrize("change", [
    {"site_id": "shackleton_ridge"}, {"lon": None}, {"lat": None},
    {"lat": 91}, {"lon": 181}, {"lat": float("inf")}, {"lon": float("nan")},
    {"step_seconds": True}, {"step_seconds": 600.0}, {"step_seconds": 59},
    {"unexpected": 1}, {"observer_height_m": 2},
])
def test_compare_scenario_validation(change):
    with pytest.raises(ValidationError):
        CompareScenario(**{**CUSTOM, **change})


@pytest.mark.parametrize("scenario", [
    {"start_utc": START, "end_utc": END},
    {"lat": -89, "start_utc": START, "end_utc": END},
    {**SITE, "site_id": None}, {**SITE, "lat": None},
])
def test_compare_requires_exactly_one_coordinate_choice(scenario):
    with pytest.raises(ValidationError):
        CompareScenario(**scenario)


def test_compare_keeps_full_results_and_catalog(client, fake_engine):
    response = client.post("/api/skyview/compare", json={"scenarioA": SITE, "scenarioB": CUSTOM})
    assert response.status_code == 200
    a, b = response.json()["scenarioA"], response.json()["scenarioB"]
    coverage = b["provenance"].pop("coordinate_coverage")
    assert coverage == {"test_coverage": True}
    assert a == b
    assert len(fake_engine) == 2
    assert len(client.get("/api/skyview/sites").json()["sites"]) == 33
    assert client.get("/api/skyview/status").status_code == 200


@pytest.mark.parametrize("bad,status,match", [
    ({**SITE, "site_id": "missing"}, 404, "scenarioB"),
    ({**SITE, "start_utc": "2027-01-01"}, 422, "scenarioB"),
    ({**SITE, "end_utc": START}, 422, "scenarioB"),
    ({**SITE, "end_utc": "2028-01-01T00:00:00Z"}, 422, "increase step"),
    ({**CUSTOM, "lat": None}, 422, "scenarioB"),
    ({**CUSTOM, "extra": True}, 422, "scenarioB"),
])
def test_compare_preflight_atomic(client, fake_engine, bad, status, match):
    response = client.post("/api/skyview/compare", json={"scenarioA": SITE, "scenarioB": bad})
    assert response.status_code == status
    assert match in response.text
    assert fake_engine == []
    assert "points" not in response.json()


def test_compare_rejects_outer_extra(client, fake_engine):
    response = client.post("/api/skyview/compare", json={"scenarioA": SITE, "scenarioB": SITE, "extra": 1})
    assert response.status_code == 422
    assert fake_engine == []


@pytest.mark.parametrize("exception,status", [
    (TerrainUnavailable("terrain unsupported"), 422),
    (DEMCoverageUnavailable("rasterio missing"), 503),
    (SkyViewUnavailable("kernels missing"), 503),
])
def test_compare_runtime_failure_has_label_no_partial_results(client, monkeypatch, exception, status):
    calls = []

    def fail_second(*args):
        calls.append(args)
        if len(calls) == 2:
            raise exception
        return {"points": ["not returned"], "provenance": {}}

    monkeypatch.setattr(api, "compute_skyview", fail_second)
    response = client.post("/api/skyview/compare", json={"scenarioA": SITE, "scenarioB": SITE})
    assert response.status_code == status
    assert "scenarioB" in response.json()["detail"]
    assert "points" not in response.json()


@pytest.mark.parametrize("change", [
    {"duration_days": 0}, {"duration_days": -1}, {"duration_days": 366},
    {"duration_days": float("nan")}, {"duration_days": float("inf")},
    {"delay_days": []}, {"delay_days": list(range(17))}, {"delay_days": [0, 0]},
    {"delay_days": [-1]}, {"delay_days": [3651]}, {"delay_days": [True]},
    {"delay_days": [1.0]}, {"delay_days": ["1"]}, {"step_seconds": True},
    {"step_seconds": 0}, {"step_seconds": 86401}, {"lat": float("inf")},
    {"lon": 181}, {"lat": -91}, {"extra": 1},
])
def test_schedule_request_validation(change):
    with pytest.raises(ValidationError):
        ScheduleShockRequest(**{**SCHEDULE, **change})


@pytest.mark.parametrize("change,match", [
    ({"base_date": "2027-01-01T00:00:00"}, "UTC"),
    ({"base_date": "2027-01-01T00:00:00+01:00"}, "UTC"),
    ({"base_date": "2027-02-30"}, "day"),
    ({"base_date": "9999-12-31", "delay_days": [1]}, "datetime range"),
    ({"duration_days": 365}, "2049 samples"),
    ({"duration_days": 7, "delay_days": list(range(9))}, "8192 samples"),
])
def test_schedule_preflight_before_calculation(client, fake_engine, change, match):
    response = client.post("/api/skyview/schedule-shock", json={**SCHEDULE, **change})
    assert response.status_code == 422
    assert match in response.text
    assert fake_engine == []


def test_schedule_defaults_and_utc_forms():
    request = ScheduleShockRequest(**COORDS, base_date="2027-01-01")
    assert request.duration_days == 7
    assert request.step_seconds == 600
    assert request.delay_days == [0, 7, 14, 21, 30]
    windows = schedule_windows(request)
    assert windows[0] == (0, "2027-01-01T00:00:00.000Z", "2027-01-08T00:00:00.000Z")
    explicit = ScheduleShockRequest(**COORDS, base_date="2027-01-01T00:00:00+00:00")
    assert schedule_windows(explicit) == windows


def test_schedule_preserves_order_and_covers_once(client, fake_engine, monkeypatch):
    coverage_calls = []
    monkeypatch.setattr(api, "validate_dem_coverage", lambda *args: coverage_calls.append(args) or {"coverage": True})
    response = client.post("/api/skyview/schedule-shock", json={**SCHEDULE, "delay_days": [7, 0]})
    assert response.status_code == 200
    data = response.json()
    assert len(coverage_calls) == 1
    assert len(fake_engine) == 2
    assert [row["delay_days"] for row in data["results"]] == [7, 0]
    assert data["results"][0]["start_utc"] == "2027-01-08T00:00:00.000Z"
    for row in data["results"]:
        assert row["total_sunlight_hours"] == pytest.approx(2)
        assert row["total_earth_visible_hours"] == pytest.approx(2)
        assert row["sunlight_percentage"] == pytest.approx(100)
        assert row["verdict"] == "green"
    metadata = data["metadata"]
    assert metadata["verdict_rule"]["scientific_certainty"] is False
    assert metadata["integration"]["exact"] is False
    assert metadata["integration"]["unseen_crossings_detected"] is False
    assert "midpoint" in metadata["integration"]["transition_model"]
    assert "not guaranteed" in metadata["integration"]["bounds"]


def _sample_result(minutes, sun, earth):
    return {"start_utc": START, "end_utc": f"2027-01-01T00:{minutes[-1]:02d}:00Z",
            "points": [{"time_utc": f"2027-01-01T00:{minute:02d}:00Z",
                        "sun": {"center_visible": s}, "earth": {"center_visible": e}}
                       for minute, s, e in zip(minutes, sun, earth)], "provenance": {}}


def test_summary_actual_nonuniform_deltas_not_sample_count():
    result = _sample_result([0, 10, 11], [False, True, True], [True, False, True])
    summary = visibility_summary(result, 0)
    assert summary["total_sunlight_hours"] == pytest.approx(6 / 60)
    assert summary["total_earth_visible_hours"] == pytest.approx(5.5 / 60)
    assert summary["sunlight_percentage"] == pytest.approx(600 / 11)
    assert summary["earth_visible_percentage"] == pytest.approx(50)
    assert summary["visibility_hour_bounds"]["sunlight"] == pytest.approx({"lower_hours": 1 / 60, "upper_hours": 11 / 60})
    assert summary["verdict"] == "yellow"


@pytest.mark.parametrize("sun,earth,verdict", [
    ([1, 1], [1, 1], "green"), ([1, 1], [0, 0], "red"),
    ([0, 1], [1, 1], "yellow"), ([0, 0], [1, 1], "red"),
])
def test_verdict_uses_minimum(sun, earth, verdict):
    assert visibility_summary(_sample_result([0, 10], sun, earth), 0)["verdict"] == verdict


@pytest.mark.parametrize("minutes,states,verdict", [
    ([0, 2, 10], [0, 1, 1], "green"),
    ([0, 4, 10], [0, 1, 1], "green"),  # Exactly 80%.
    ([0, 5, 10], [0, 1, 1], "yellow"),
    ([0, 10], [0, 1], "yellow"),  # Exactly 50%.
])
def test_verdict_thresholds(minutes, states, verdict):
    assert visibility_summary(_sample_result(minutes, states, states), 0)["verdict"] == verdict


@pytest.mark.parametrize("intervals,visible_count,percentage,verdict", [
    (12, 6, 50, "yellow"),
    (25, 20, 80, "green"),
])
def test_exact_threshold_after_many_intervals(intervals, visible_count, percentage, verdict):
    times = sample_times(START, f"2027-01-01T{intervals // 6:02d}:{intervals % 6 * 10:02d}:00Z", 600)
    result = {"start_utc": iso_utc(times[0]), "end_utc": iso_utc(times[-1]),
              "points": [{"time_utc": iso_utc(t), "sun": {"center_visible": 1 <= i <= visible_count},
                          "earth": {"center_visible": True}} for i, t in enumerate(times)],
              "provenance": {}}
    summary = visibility_summary(result, 0)
    assert summary["sunlight_percentage"] == percentage
    assert summary["verdict"] == verdict


def test_measured_dem_outside_and_missing_fail_without_compute(client, monkeypatch, tmp_path):
    def no_compute(*args):
        pytest.fail("Invalid coverage must not reach SPICE")

    monkeypatch.setattr(api, "compute_skyview", no_compute)
    outside = client.post("/api/skyview/schedule-shock", json={**SCHEDULE, "lat": 0})
    assert outside.status_code == 422
    assert outside.json()["detail"] == OUTSIDE_DEM_DETAIL
    compare = client.post("/api/skyview/compare", json={"scenarioA": SITE, "scenarioB": {**CUSTOM, "lat": 0}})
    assert compare.status_code == 422
    assert compare.json()["detail"] == f"scenarioB: {OUTSIDE_DEM_DETAIL}"
    monkeypatch.setenv("LUNAR_DEM_PATH", str(tmp_path / "missing.bin"))
    for endpoint, body in [
        ("schedule-shock", SCHEDULE), ("compare", {"scenarioA": CUSTOM, "scenarioB": SITE}),
    ]:
        response = client.post(f"/api/skyview/{endpoint}", json=body)
        assert response.status_code == 503
        assert "Measured DEM unavailable" in response.json()["detail"]


@pytest.mark.parametrize("exception,status", [
    (SkyViewUnavailable("SPICE unavailable, no fallback"), 503),
    (TerrainUnavailable("measured terrain unavailable"), 422),
])
def test_schedule_runtime_failure_returns_no_partial(client, fake_engine, monkeypatch, exception, status):
    engine = api.compute_skyview

    def fail_second(*args):
        if fake_engine:
            raise exception
        return engine(*args)

    monkeypatch.setattr(api, "compute_skyview", fail_second)
    response = client.post("/api/skyview/schedule-shock", json=SCHEDULE)
    assert response.status_code == status
    assert "results" not in response.json()


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_real_compare_equals_existing_routes_and_schedule(client):
    series = client.post("/api/skyview/series", json=SITE)
    custom = client.post("/api/skyview/custom", json=CUSTOM)
    comparison = client.post("/api/skyview/compare", json={"scenarioA": SITE, "scenarioB": CUSTOM})
    for response in (series, custom, comparison):
        assert response.status_code == 200, response.text
    assert comparison.json()["scenarioA"] == series.json()
    assert comparison.json()["scenarioB"] == custom.json()
    schedule = client.post("/api/skyview/schedule-shock", json=SCHEDULE)
    assert schedule.status_code == 200, schedule.text
    rows = schedule.json()["results"]
    assert len(rows) == 2
    for row in rows:
        raw = client.post("/api/skyview/custom", json={**COORDS, "start_utc": row["start_utc"], "end_utc": row["end_utc"]})
        assert raw.status_code == 200, raw.text
        expected = visibility_summary(raw.json(), row["delay_days"])
        # Coverage is reported once in batch metadata, unlike /custom provenance.
        expected["provenance"].pop("coordinate_coverage")
        assert row == expected
        assert 0 <= row["sunlight_percentage"] <= 100
        assert 0 <= row["earth_visible_percentage"] <= 100
        assert math.isfinite(row["total_sunlight_hours"])
        assert len(row["provenance"]["kernels"]) == 4


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_real_schedule_and_compare_planning_match_changing_series_with_partial_endpoint(client):
    # 31 days plus 420.123456 seconds produces an actual, non-hour-aligned endpoint.
    duration_days = 31 + 420.123456 / 86400
    schedule = client.post("/api/skyview/schedule-shock", json={
        "lat": -88.679, "lon": -68.1, "base_date": "2027-01-01T00:00:00.123456Z",
        "duration_days": duration_days, "delay_days": [0], "step_seconds": 3600,
    })
    assert schedule.status_code == 200, schedule.text
    row = schedule.json()["results"][0]
    assert row["start_utc"] == "2027-01-01T00:00:00.123456Z"
    assert row["end_utc"] == "2027-02-01T00:07:00.246912Z"
    scenario_a = {"lat": -88.679, "lon": -68.1, "start_utc": row["start_utc"],
                  "end_utc": row["end_utc"], "step_seconds": 3600}
    scenario_b = {**scenario_a, "lat": -89, "lon": -137}
    comparison = client.post("/api/skyview/compare-planning", json={
        "scenarioA": scenario_a, "scenarioB": scenario_b,
    })
    assert comparison.status_code == 200, comparison.text
    a, b = comparison.json()["scenarioA"], comparison.json()["scenarioB"]
    for series in (a, b):
        assert series["points"][0]["time_utc"] == row["start_utc"]
        assert series["points"][-1]["time_utc"] == row["end_utc"]
        last_step = parse_utc(series["points"][-1]["time_utc"]) - parse_utc(series["points"][-2]["time_utc"])
        assert last_step.total_seconds() == pytest.approx(420.123456)
        summary = series["planning_summary"]
        for body, total in (("sun", "total_sunlight_hours"), ("earth", "total_earth_visible_hours")):
            assert summary[total] == pytest.approx(series["visibility_intervals"][body]["total_visible_hours"])
    assert row["total_sunlight_hours"] == a["planning_summary"]["total_sunlight_hours"]
    assert row["total_earth_visible_hours"] == a["planning_summary"]["total_earth_visible_hours"]
    assert row["total_sunlight_hours"] == 708.5
    assert row["total_earth_visible_hours"] == 351
    assert b["planning_summary"]["total_sunlight_hours"] == pytest.approx(206.11670096)
    assert b["planning_summary"]["total_earth_visible_hours"] == 0
    for body in ("sun", "earth"):
        states = [point[body]["center_visible"] for point in a["points"]]
        assert any(states) and not all(states)
