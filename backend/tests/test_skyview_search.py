"""Offline, deterministic planning tests; no network or kernel dependency."""
import math

from fastapi import FastAPI
from fastapi.testclient import TestClient
import numpy as np
import pytest
from pydantic import ValidationError

from app import skyview_router as api
from app import skyview_slope as slope_module
from app.horizon import _DEM, TerrainUnavailable
from app.skyview import iso_utc, sample_times
from app.skyview_planning import visibility_summary
from app.skyview_search import SearchRequest, search_windows

START = "2027-01-01T00:00:00Z"
END = "2027-01-03T00:00:00Z"
BASE = dict(site_ids=["shackleton_ridge"], start_utc=START, end_utc=END)


@pytest.mark.parametrize("change", [dict(site_ids=[]), dict(site_ids=['a', 'a']), dict(step_seconds=True), dict(min_sunlight_fraction=1.1), dict(max_slope_deg=float('nan')), dict(cadence_hours=0), dict(max_results=51), dict(extra=1)])
def test_schema(change):
    with pytest.raises(ValidationError):
        SearchRequest(**{**BASE, **change})


def test_windows_and_budget():
    assert len(search_windows(SearchRequest(**BASE))) == 2
    for change in [dict(end_utc="2028-01-01T00:00:00Z"), dict(duration_hours=72), dict(cadence_hours=1, end_utc="2027-01-10T00:00:00Z"), dict(start_utc="2027-01-01T00:00:00+01:00")]:
        with pytest.raises(ValueError):
            search_windows(SearchRequest(**{**BASE, **change}))


def test_irregular_sunlight_numeric_integration():
    result = dict(start_utc=START, end_utc="2027-01-01T03:00:00Z", provenance={}, points=[
        dict(time_utc=START, sun=dict(center_visible=False), earth=dict(center_visible=True)),
        dict(time_utc="2027-01-01T01:00:00Z", sun=dict(center_visible=True), earth=dict(center_visible=True)),
        dict(time_utc="2027-01-01T03:00:00Z", sun=dict(center_visible=True), earth=dict(center_visible=False))])
    summary = visibility_summary(result, 0)
    assert summary['total_sunlight_hours'] == 2.5
    assert summary['total_earth_visible_hours'] == 2
    assert summary['sunlight_percentage'] == pytest.approx(100 * 2.5 / 3)
    assert summary['visibility_hour_bounds']['sunlight'] == dict(lower_hours=2, upper_hours=3)


def test_slope_measured_plane(monkeypatch):
    # 200 m cells; z increases 20 m each column, no procedural runtime data.
    values = np.tile(np.arange(9, dtype=np.int16) * 20, (9, 1))
    dem = _DEM(values, 200, 4, 4, 1, 'fixture', 'test-hash')
    monkeypatch.setattr(slope_module, '_load_dem', lambda: dem)
    result = slope_module.local_slope(-90, 0)
    assert result['slope_deg'] == pytest.approx(math.degrees(math.atan(.1)), abs=.001)
    assert result['neighborhood_projected_width_m'] == 400
    assert result['sample_count'] == 9
    with pytest.raises(TerrainUnavailable):
        slope_module.local_slope(-89, 0)


@pytest.fixture
def client(monkeypatch):
    app = FastAPI(); app.include_router(api.router)
    monkeypatch.setattr(api, 'local_slope', lambda lat, lon: dict(slope_deg=5, grid_spacing_m=200))
    monkeypatch.setattr(api, 'validate_dem_coverage', lambda lat, lon: dict(grid_spacing_m=200, lat=lat, lon=lon))
    def compute(lat, lon, start, end, step):
        return dict(site=dict(lat_deg=lat, lon_deg=lon), start_utc=start, end_utc=end,
                    points=[dict(time_utc=iso_utc(t), sun=dict(center_visible=True), earth=dict(center_visible=False)) for t in sample_times(start, end, step)],
                    horizon=dict(coverage={'truncated': True}, provenance={'sha256': 'test'}), provenance={'kernels': []})
    monkeypatch.setattr(api, 'compute_skyview', compute)
    return TestClient(app)


def test_search_metrics_filter_metadata(client):
    response = client.post('/api/skyview/search', json={**BASE, 'min_sunlight_fraction': 1, 'max_results': 1})
    assert response.status_code == 200
    data = response.json()
    assert data['metadata']['evaluated_windows'] == 2
    assert data['metadata']['matched_windows'] == 2
    assert len(data['results']) == 1
    assert data['results'][0]['summary']['total_sunlight_hours'] == 24
    assert data['results'][0]['horizon_coverage']['truncated']
    assert client.post('/api/skyview/search', json={**BASE, 'min_earth_fraction': .01}).json()['results'] == []
    assert client.post('/api/skyview/search', json={**BASE, 'max_slope_deg': 4}).json()['results'] == []


def test_search_missing_terrain_is_explicit(client, monkeypatch):
    def absent(*args):
        raise TerrainUnavailable('fixture missing terrain')
    monkeypatch.setattr(api, 'local_slope', absent)
    data = client.post('/api/skyview/search', json=BASE).json()
    assert data['results'] == []
    assert data['metadata']['rejected_sites'][0]['reason'] == 'fixture missing terrain'


def test_search_preflight_and_kernel_failure(client, monkeypatch):
    from app.skyview import SkyViewUnavailable
    calls = []
    def unavailable(*args):
        calls.append(args)
        raise SkyViewUnavailable('fixture kernel date coverage missing')
    monkeypatch.setattr(api, 'compute_skyview', unavailable)
    assert client.post('/api/skyview/search', json={**BASE, 'site_ids': ['missing']}).status_code == 404
    assert client.post('/api/skyview/search', json={**BASE, 'end_utc': '2028-01-01T00:00:00Z'}).status_code == 422
    assert calls == []
    response = client.post('/api/skyview/search', json=BASE)
    assert response.status_code == 503
    assert 'results' not in response.json()


def test_planning_compare_measured_summary(client):
    window = dict(site_id='shackleton_ridge', start_utc=START, end_utc=END, step_seconds=3600)
    response = client.post('/api/skyview/compare-planning', json=dict(scenarioA=window, scenarioB=window))
    assert response.status_code == 200
    a = response.json()['scenarioA']
    assert a['planning_summary']['total_sunlight_hours'] == 48
    assert a['local_slope']['slope_deg'] == 5


def test_planning_compare_reuses_raw_guard(client, monkeypatch):
    from app.dem_coverage import DEMCoverageUnavailable
    def absent(*args):
        raise DEMCoverageUnavailable('raw DEM missing')
    monkeypatch.setattr(api, 'validate_dem_coverage', absent)
    window = dict(start_utc=START, end_utc=END)
    response = client.post('/api/skyview/compare-planning', json=dict(scenarioA=dict(site_id='shackleton_ridge', **window), scenarioB=dict(lat=-89, lon=0, **window)))
    assert response.status_code == 503
    assert 'scenarioB' in response.text


CUSTOM = dict(lat=-89.321, lon=17.123, name='Custom A')


def coordinate_request(locations=None, **changes):
    return dict(start_utc=START, end_utc=END,
                locations=[CUSTOM] if locations is None else locations, **changes)


@pytest.mark.parametrize('payload', [
    dict(start_utc=START, end_utc=END),
    {**BASE, 'locations': [CUSTOM]},
    {**BASE, 'locations': None},
    coordinate_request([]),
    coordinate_request([CUSTOM] * 9),
    coordinate_request([dict(site_id='shackleton_ridge', **CUSTOM)]),
    coordinate_request([dict(lat=-89)]),
    coordinate_request([dict(lat=-89, lon=0, extra=True)]),
    coordinate_request([dict(lat='-89', lon=0)]),
    coordinate_request([dict(lat=True, lon=0)]),
    coordinate_request([dict(lat=-91, lon=0)]),
    coordinate_request([dict(lat=-89, lon=181)]),
    coordinate_request([dict(lat=float('nan'), lon=0)]),
    coordinate_request([dict(lat=-89, lon=float('inf'))]),
    coordinate_request([dict(lat=-89, lon=0, name=123)]),
    coordinate_request([dict(lat=-89, lon=0, name=None)]),
    coordinate_request([dict(lat=-89, lon=0, name='')]),
    coordinate_request([CUSTOM, {**CUSTOM, 'name': 'duplicate renamed'}]),
    coordinate_request([dict(lat=-89, lon=-180), dict(lat=-89, lon=180)]),
    coordinate_request([dict(lat=-90, lon=0), dict(lat=-90, lon=90)]),
    coordinate_request([dict(site_id='x'), dict(site_id='x')]),
])
def test_custom_schema_is_exclusive_strict_and_unique(payload):
    with pytest.raises(ValidationError):
        SearchRequest(**payload)


@pytest.mark.parametrize('locations', [
    [CUSTOM],
    [CUSTOM, dict(lat=-89.456, lon=-12.25, name='Custom B')],
    [dict(site_id='shackleton_ridge'), CUSTOM],
])
def test_search_custom_and_mixed_coordinates(client, monkeypatch, locations):
    calls, coverage_calls = [], []
    original = api.compute_skyview
    def compute(*args):
        calls.append(args)
        return original(*args)
    def coverage(lat, lon):
        coverage_calls.append((lat, lon))
        return dict(grid_spacing_m=200)
    monkeypatch.setattr(api, 'compute_skyview', compute)
    monkeypatch.setattr(api, 'validate_dem_coverage', coverage)
    payload = coordinate_request(locations, duration_hours=25.5, step_seconds=7200)
    response = client.post('/api/skyview/search', json=payload)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['metadata']['evaluated_windows'] == len(locations)
    custom = next(row for row in data['results'] if row['site']['lat'] == CUSTOM['lat'])
    assert custom['site'] == dict(id=None, site_id=None, **CUSTOM)
    assert custom['step_seconds'] == 7200
    assert custom['summary']['end_utc'] == '2027-01-02T01:30:00.000Z'
    assert custom['summary']['provenance']['coordinate_coverage']['grid_spacing_m'] == 200
    assert (-89.321, 17.123, '2027-01-01T00:00:00.000Z', '2027-01-02T01:30:00.000Z', 7200) in calls
    assert (-89.321, 17.123) in coverage_calls
    assert 'nearest-site substitution' in data['metadata']['coverage']


@pytest.mark.parametrize('failure,status', [(TerrainUnavailable('outside measured calculation DEM'), 422)])
def test_custom_coverage_preflight_is_atomic(client, monkeypatch, failure, status):
    calls = []
    def coverage(lat, lon):
        if lon == 40:
            raise failure
        return dict(grid_spacing_m=200)
    monkeypatch.setattr(api, 'validate_dem_coverage', coverage)
    monkeypatch.setattr(api, 'compute_skyview', lambda *args: calls.append(args))
    payload = coordinate_request([CUSTOM, dict(lat=-89, lon=40)])
    response = client.post('/api/skyview/search', json=payload)
    assert response.status_code == status
    assert 'locations[1]' in response.text
    assert calls == []


def test_custom_calculation_grid_missing_is_503(client, monkeypatch):
    from app.dem_coverage import DEMCoverageUnavailable
    def missing(*args):
        raise DEMCoverageUnavailable('calculation grid missing; no raw fallback')
    monkeypatch.setattr(api, 'validate_dem_coverage', missing)
    response = client.post('/api/skyview/search', json=coordinate_request())
    assert response.status_code == 503
    assert 'locations[0]' in response.text
    assert 'no raw fallback' in response.text


def test_all_slopes_preflight_before_any_compute(client, monkeypatch):
    events = []
    original = api.compute_skyview
    def slope(lat, lon):
        events.append(('slope', lat, lon))
        if lon == 40:
            raise TerrainUnavailable('3x3 neighborhood extends outside measured grid')
        return dict(slope_deg=5, grid_spacing_m=200)
    def compute(*args):
        events.append(('compute', *args))
        return original(*args)
    monkeypatch.setattr(api, 'local_slope', slope)
    monkeypatch.setattr(api, 'compute_skyview', compute)
    response = client.post('/api/skyview/search', json=coordinate_request([CUSTOM, dict(lat=-89, lon=40)]))
    assert response.status_code == 200
    data = response.json()
    assert [event[0] for event in events[:3]] == ['slope', 'slope', 'compute']
    rejected = data['metadata']['rejected_sites'][0]
    assert rejected['site_id'] is None
    assert rejected['location_index'] == 1
    assert rejected['lat'] == -89
    assert 'locations[1]: slope neighborhood unavailable' in rejected['reason']
    assert '3x3' in rejected['reason']


def test_resolved_catalog_custom_duplicates_rejected_before_compute(client, monkeypatch):
    site = api.site_by_id('shackleton_ridge')
    calls = []
    monkeypatch.setattr(api, 'compute_skyview', lambda *args: calls.append(args))
    response = client.post('/api/skyview/search', json=coordinate_request([
        dict(site_id=site['id']), dict(lat=site['lat'], lon=site['lon'])]))
    assert response.status_code == 422
    assert 'locations[1]' in response.text
    assert calls == []


def test_custom_thresholds_are_same_sampled_metrics(client):
    assert client.post('/api/skyview/search', json=coordinate_request(min_sunlight_hours=24, min_sunlight_fraction=1)).json()['results']
    for criteria in [dict(min_sunlight_hours=24.01), dict(min_earth_hours=.01),
                     dict(min_earth_fraction=.01), dict(max_slope_deg=4)]:
        assert client.post('/api/skyview/search', json=coordinate_request(**criteria)).json()['results'] == []


@pytest.mark.parametrize('changes', [
    dict(end_utc='2028-01-01T00:00:00Z'),
    dict(duration_hours=72),
    dict(cadence_hours=1, end_utc='2027-01-10T00:00:00Z'),
    dict(duration_hours=168, cadence_hours=168, step_seconds=600,
         end_utc='2027-01-29T00:00:00Z'),
])
def test_custom_windows_and_budget_preflight_before_compute(client, monkeypatch, changes):
    calls = []
    monkeypatch.setattr(api, 'compute_skyview', lambda *args: calls.append(args))
    payload = {**coordinate_request([dict(lat=-89, lon=i) for i in range(8)]), **changes}
    assert client.post('/api/skyview/search', json=payload).status_code == 422
    assert calls == []


def test_invalid_later_window_preflight_before_compute(client, monkeypatch):
    calls = []
    original = api.sample_times
    # search_windows uses its own import: fail on the second window, not first.
    from app import skyview_search
    def sample(first, last, step):
        if first.startswith('2027-01-02'):
            raise ValueError('fixture later window rejected')
        return original(first, last, step)
    monkeypatch.setattr(skyview_search, 'sample_times', sample)
    monkeypatch.setattr(api, 'compute_skyview', lambda *args: calls.append(args))
    response = client.post('/api/skyview/search', json=coordinate_request())
    assert response.status_code == 422
    assert 'later window rejected' in response.text
    assert calls == []
