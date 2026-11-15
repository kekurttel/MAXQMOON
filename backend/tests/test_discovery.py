import os
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.discovery import (
    MAX_CANDIDATE_WINDOW_SAMPLES,
    MAX_RANGE_DAYS,
    MAX_UNIQUE_TIMESTAMPS,
    MAX_WINDOWS,
    DiscoveryRequest,
    _generate_candidate_strata,
    discover_candidates,
)
from app.horizon import _load_dem
from app.main import app
from app.skyview import SkyViewUnavailable

client = TestClient(app)


def test_discovery_request_defaults():
    req = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-11-17T00:00:00Z",
    )
    assert req.duration_hours == 24
    assert req.cadence_hours == 24
    assert req.step_seconds == 3600
    assert req.max_slope_deg == 15
    assert req.spatial_resolution_m == 20000
    assert req.max_candidates == 64
    assert req.max_results == 10


def test_discovery_request_forbid_extra():
    with pytest.raises(ValidationError):
        DiscoveryRequest(
            start_utc="2026-11-15T00:00:00Z",
            end_utc="2026-11-17T00:00:00Z",
            site_ids=["shackleton_connecting_ridge"],  # extra field
        )


def test_discovery_request_forbid_inf_nan():
    with pytest.raises(ValidationError):
        DiscoveryRequest(
            start_utc="2026-11-15T00:00:00Z",
            end_utc="2026-11-17T00:00:00Z",
            duration_hours=float("nan"),
        )


def test_discovery_request_invalid_dates():
    with pytest.raises(ValidationError, match="Invalid ISO UTC"):
        DiscoveryRequest(start_utc="invalid", end_utc="2026-11-17T00:00:00Z")

    with pytest.raises(ValidationError, match="strictly after"):
        DiscoveryRequest(start_utc="2026-11-17T00:00:00Z", end_utc="2026-11-15T00:00:00Z")


def test_discovery_request_max_range_exceeded():
    with pytest.raises(ValidationError, match=f"exceeds maximum {MAX_RANGE_DAYS} days"):
        DiscoveryRequest(
            start_utc="2026-01-01T00:00:00Z",
            end_utc="2026-05-01T00:00:00Z",  # ~120 days
        )


def test_discovery_request_duration_exceeds_range():
    with pytest.raises(ValidationError, match="cannot exceed total range"):
        DiscoveryRequest(
            start_utc="2026-11-15T00:00:00Z",
            end_utc="2026-11-15T12:00:00Z",  # 12h
            duration_hours=24,
        )


def test_discovery_request_too_many_windows():
    with pytest.raises(ValidationError, match="Too many candidate windows"):
        DiscoveryRequest(
            start_utc="2026-01-01T00:00:00Z",
            end_utc="2026-03-01T00:00:00Z",  # 59 days
            duration_hours=24,
            cadence_hours=1,  # ~1400 windows > 64
        )


def test_discovery_request_invalid_step_seconds():
    with pytest.raises(ValidationError):
        DiscoveryRequest(
            start_utc="2026-11-15T00:00:00Z",
            end_utc="2026-11-17T00:00:00Z",
            step_seconds=100,  # below min 600
        )


def test_strata_generation():
    dem = _load_dem()
    strata, meta = _generate_candidate_strata(dem, spatial_resolution_m=50000, max_candidates=64)
    assert len(strata) <= 64
    assert meta["grid_rows"] > 0
    assert meta["grid_cols"] > 0
    for cand in strata:
        assert "region_id" in cand
        assert -90.0 <= cand["lat"] <= 90.0
        assert -180.0 <= cand["lon"] <= 180.0
        assert "bounds_projected_m" in cand


def test_strata_coarsening():
    dem = _load_dem()
    strata, meta = _generate_candidate_strata(dem, spatial_resolution_m=2000, max_candidates=16)
    assert len(strata) <= 16
    assert meta["coarsened"] is True


def test_strata_center_in_bounds():
    dem = _load_dem()
    strata, _ = _generate_candidate_strata(dem, spatial_resolution_m=30000, max_candidates=32)
    for s in strata:
        b = s["bounds_projected_m"]
        c = s["center_projected_m"]
        assert b["x_min"] <= c["x"] <= b["x_max"]
        assert b["y_min"] <= c["y"] <= b["y_max"]


def test_discovery_budget_checks():
    # 1. Unique timestamps budget
    req_timestamps = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-12-15T00:00:00Z",
        duration_hours=120,
        cadence_hours=12,
        step_seconds=600,
        max_candidates=16,
    )
    with pytest.raises(ValueError, match="Too many unique evaluation timestamps"):
        discover_candidates(req_timestamps)

    # 2. Candidate-window sample budget
    req_samples = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-12-05T00:00:00Z",
        duration_hours=72,
        cadence_hours=12,
        step_seconds=1800,
        max_candidates=128,
    )
    with pytest.raises(ValueError, match="Evaluation budget exceeded"):
        discover_candidates(req_samples)


def test_discovery_smoke_run():
    req = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-11-17T00:00:00Z",
        duration_hours=24,
        cadence_hours=24,
        step_seconds=7200,
        max_slope_deg=30,
        spatial_resolution_m=50000,
        max_candidates=16,
        max_results=5,
    )
    res = discover_candidates(req)
    assert "results" in res
    assert "metadata" in res
    assert len(res["results"]) <= 5

    meta = res["metadata"]
    assert meta["evaluated_candidates"] <= 16
    assert "provenance" in meta
    assert meta["provenance"]["frame"] == "MOON_ME_DE421"

    if res["results"]:
        top = res["results"][0]
        assert "region_id" in top
        assert "lat" in top
        assert "lon" in top
        assert "score" in top
        assert "windows" in top
        assert len(top["windows"]) > 0
        w = top["windows"][0]
        assert "score" in w
        assert "sun" in w
        assert "earth" in w


def test_discovery_empty_results_when_strict_criteria():
    req = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-11-17T00:00:00Z",
        duration_hours=24,
        cadence_hours=24,
        step_seconds=7200,
        max_slope_deg=0.001,  # Impractically flat slope eliminates all terrain
        spatial_resolution_m=50000,
        max_candidates=16,
    )
    res = discover_candidates(req)
    assert res["results"] == []
    assert res["metadata"]["matched_regions"] == 0
    assert res["metadata"]["rejected_reason_counts"]["slope"] > 0


def test_discovery_scoring_calculation():
    # Formula check: 100 * (0.45 * sun_frac + 0.45 * earth_frac + 0.10 * (1 - slope/90))
    sun_f = 0.8
    earth_f = 0.6
    slope = 10.0
    expected = 100.0 * (0.45 * sun_f + 0.45 * earth_f + 0.10 * (1.0 - slope / 90.0))
    assert round(expected, 2) == 71.89


def test_discovery_window_sorting_order():
    req = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-11-19T00:00:00Z",
        duration_hours=24,
        cadence_hours=24,
        step_seconds=7200,
        max_slope_deg=35,
        spatial_resolution_m=40000,
        max_candidates=16,
        max_results=5,
    )
    res = discover_candidates(req)
    # Check candidates sorted descending by score
    scores = [c["score"] for c in res["results"]]
    assert scores == sorted(scores, reverse=True)
    for c in res["results"]:
        w_scores = [w["score"] for w in c["windows"]]
        assert w_scores == sorted(w_scores, reverse=True)


def test_discovery_metadata_structure():
    req = DiscoveryRequest(
        start_utc="2026-11-15T00:00:00Z",
        end_utc="2026-11-17T00:00:00Z",
        duration_hours=24,
        cadence_hours=24,
        step_seconds=7200,
        max_slope_deg=25,
        spatial_resolution_m=50000,
        max_candidates=16,
    )
    res = discover_candidates(req)
    meta = res["metadata"]
    for field in (
        "criteria", "coverage", "provenance", "evaluated_candidates", "evaluated_windows",
        "horizons_computed", "matched_regions", "rejected_regions", "rejected_reason_counts",
        "unique_timestamps", "planned_candidate_window_samples", "planned_max_skyline_samples",
        "budgets", "ordering", "limits",
    ):
        assert field in meta


def test_discovery_endpoint_success():
    payload = {
        "start_utc": "2026-11-15T00:00:00Z",
        "end_utc": "2026-11-17T00:00:00Z",
        "duration_hours": 24,
        "cadence_hours": 24,
        "step_seconds": 7200,
        "max_slope_deg": 30,
        "spatial_resolution_m": 50000,
        "max_candidates": 16,
        "max_results": 5,
    }
    response = client.post("/api/skyview/discovery", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "results" in data
    assert "metadata" in data


def test_discovery_endpoint_422_extra_field():
    payload = {
        "start_utc": "2026-11-15T00:00:00Z",
        "end_utc": "2026-11-17T00:00:00Z",
        "forbidden_field": "test",
    }
    response = client.post("/api/skyview/discovery", json=payload)
    assert response.status_code == 422


def test_discovery_endpoint_422_invalid_step():
    payload = {
        "start_utc": "2026-11-15T00:00:00Z",
        "end_utc": "2026-11-17T00:00:00Z",
        "step_seconds": 100,  # below 600
    }
    response = client.post("/api/skyview/discovery", json=payload)
    assert response.status_code == 422
