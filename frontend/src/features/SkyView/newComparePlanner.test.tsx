import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ComparePlanner from './ComparePlanner';
import { compareSites, PlannerObservation, PlanningComparison, PlanningSeries, searchSites, SearchResult } from '../../services/skyviewPlanning';

jest.mock('../../services/skyviewPlanning', () => ({ compareSites: jest.fn(), searchSites: jest.fn() }));
const sites = [{ id: 'one', name: 'Katalog Bir', lat: -89, lon: 10 }, { id: 'two', name: 'Katalog İki', lat: -88, lon: 20 }];
const start = '2026-11-15T00:00:00.000Z', end = '2026-11-16T00:00:00.000Z';
const a: PlannerObservation = { lat: -89.11, lon: 14.12, start_utc: start, end_utc: end, step_seconds: 3600 };
const b: PlannerObservation = { lat: -88.22, lon: -23.45, start_utc: '2026-12-01T12:30:45.000Z', end_utc: '2026-12-03T12:30:45.000Z', step_seconds: 3600 };
function series(scenario: PlannerObservation): PlanningSeries {
  const coords = 'lat' in scenario ? { lat_deg: scenario.lat, lon_deg: scenario.lon } : { lat_deg: -89, lon_deg: 10 };
  return {
    ...scenario, site: { ...coords, surface_elevation_m: 123 }, frame: 'MOON_ME_DE421',
    provenance: { kernels: [] }, horizon: { provenance: { spacing_m: 200, sha256: 'dem' }, coverage: { truncated: false } },
    local_slope: { slope_deg: 2 },
    planning_summary: { start_utc: scenario.start_utc, end_utc: scenario.end_utc, total_sunlight_hours: 12, sunlight_percentage: 50, total_earth_visible_hours: 18, earth_visible_percentage: 75, visibility_hour_bounds: {}, provenance: { kernels: [] } },
  } as unknown as PlanningSeries;
}
const comparison = (): PlanningComparison => ({ scenarioA: series(a), scenarioB: series(b) });
const emptySearch: SearchResult = { results: [], metadata: { evaluated_windows: 14, matched_windows: 0, rejected_sites: [] } };
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function showSearch() { fireEvent.click(screen.getByRole('button', { name: '2 · Koşullara göre pencere ara' })); }
beforeEach(() => {
  jest.clearAllMocks();
  (compareSites as jest.Mock).mockResolvedValue(comparison());
  (searchSites as jest.Mock).mockResolvedValue(emptySearch);
});

test('independent A/B custom coordinates, exact UTC seconds and B apply remain intact', async () => {
  const apply = jest.fn();
  render(<ComparePlanner catalog={sites} initialScenarioA={a} initialScenarioB={b} onSelectObservation={apply} />);
  expect(screen.getByLabelText('A başlangıç (UTC)')).toHaveValue('2026-11-15T00:00');
  expect(screen.getByLabelText('B başlangıç (UTC)')).toHaveValue('2026-12-01T12:30:45.000');
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  await screen.findByRole('heading', { name: 'A / B karşılaştırma sonuçları' });
  expect(compareSites).toHaveBeenCalledWith(a, b, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button', { name: 'B gözlemini aç' }));
  expect(apply).toHaveBeenCalledWith(b);
  expect(screen.getAllByText('12 saat · %50')).toHaveLength(2);
});

test('editable independent end dates and catalog legacy apply', async () => {
  const legacy = jest.fn();
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} onSelectResult={legacy} />);
  change('B başlangıç (UTC)', '2026-11-20T01:02:03');
  change('B bitiş (UTC)', '2026-11-22T04:05:06');
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  await screen.findByRole('button', { name: 'B gözlemini aç' });
  expect(compareSites).toHaveBeenCalledWith(expect.objectContaining({ site_id: 'one', start_utc: start, end_utc: end }), expect.objectContaining({ site_id: 'two', start_utc: '2026-11-20T01:02:03.000Z', end_utc: '2026-11-22T04:05:06.000Z' }), expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button', { name: 'B gözlemini aç' }));
  expect(legacy).toHaveBeenCalledWith('two', '2026-11-20T01:02:03.000Z');
});

test('custom A/B window search sends both exact locations and all specification constraints', async () => {
  render(<ComparePlanner catalog={sites} initialScenarioA={a} initialScenarioB={b} />);
  showSearch();
  change('Arama başlangıcı (UTC)', '2027-01-01T00:00:00');
  change('Arama bitişi (UTC)', '2027-01-04T00:00:00');
  change('Pencere süresi (saat)', '12'); change('Başlangıçlar arası (saat)', '6');
  change('En az Güneş görünürlüğü (%)', '60'); change('En az Dünya görünürlüğü (%)', '70');
  change('En az Güneş görünürlüğü (saat)', '5'); change('En az Dünya görünürlüğü (saat)', '6');
  change('En yüksek eğim (°, isteğe bağlı)', '8.5');
  fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  await screen.findByRole('heading', { name: 'Arama sonuçları' });
  expect(searchSites).toHaveBeenCalledWith({ locations: [{ lat: -89.11, lon: 14.12 }, { lat: -88.22, lon: -23.45 }], start_utc: '2027-01-01T00:00:00.000Z', end_utc: '2027-01-04T00:00:00.000Z', duration_hours: 12, cadence_hours: 6, step_seconds: 3600, min_sunlight_hours: 5, min_sunlight_fraction: .6, min_earth_hours: 6, min_earth_fraction: .7, max_slope_deg: 8.5, max_results: 10 }, expect.any(AbortSignal));
});

test('mixed catalog/custom result applies exact custom coordinates and complete UTC window', async () => {
  const apply = jest.fn();
  (searchSites as jest.Mock).mockResolvedValue({ results: [{ site: { site_id: null, id: null, name: 'Özel B', lat: -88.22, lon: -23.45 }, summary: series(b).planning_summary, local_slope: { slope_deg: 2 }, dem_provenance: { sha256: 'dem', spacing_m: 200 }, horizon_coverage: { truncated: false } }], metadata: { evaluated_windows: 14, matched_windows: 1, rejected_sites: [] } });
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={b} currentDateUtc={start} onSelectObservation={apply} />);
  showSearch(); fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Bu pencereyi aç' }));
  expect(searchSites).toHaveBeenCalledWith(expect.objectContaining({ locations: [{ site_id: 'one' }, { lat: -88.22, lon: -23.45 }] }), expect.anything());
  expect(apply).toHaveBeenCalledWith(b);
});

test('form edit aborts pending request and ignores a late response even if transport ignores abort', async () => {
  let resolve!: (result: PlanningComparison) => void;
  (compareSites as jest.Mock).mockImplementation(() => new Promise<PlanningComparison>(done => { resolve = done; }));
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  const signal = (compareSites as jest.Mock).mock.calls[0][2] as AbortSignal;
  change('A bitiş (UTC)', '2026-11-17T00:00:00');
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(comparison()); });
  expect(screen.queryByRole('heading', { name: 'A / B karşılaştırma sonuçları' })).not.toBeInTheDocument();
});

test('completed results are cleared when criteria change', async () => {
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  showSearch(); fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  await screen.findByRole('heading', { name: 'Arama sonuçları' });
  change('En az Güneş görünürlüğü (%)', '20');
  expect(screen.queryByRole('heading', { name: 'Arama sonuçları' })).not.toBeInTheDocument();
});

test('cancel and unmount abort without stale results', async () => {
  (compareSites as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const { unmount } = render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  const first = (compareSites as jest.Mock).mock.calls[0][2] as AbortSignal;
  fireEvent.click(screen.getByRole('button', { name: 'İsteği iptal et' }));
  expect(first.aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  const second = (compareSites as jest.Mock).mock.calls[1][2] as AbortSignal;
  unmount(); expect(second.aborted).toBe(true);
});

test('failures expose retry and do not fabricate results', async () => {
  (compareSites as jest.Mock).mockRejectedValueOnce(new Error('Ölçülmüş DEM kullanılamıyor.'));
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Ölçülmüş DEM kullanılamıyor.');
  fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
  await screen.findByRole('heading', { name: 'A / B karşılaştırma sonuçları' });
});

test('per-scenario sample overflow is rejected before API call', async () => {
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  change('A bitiş (UTC)', '2027-03-01T00:00:00');
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('senaryo başına 2049');
  expect(compareSites).not.toHaveBeenCalled();
});

test('explicit globe transfer preserves custom coordinates, independent dates and edited drafts on rerender', async () => {
  const props = { catalog: sites, currentDateUtc: start, markedLocations: [{ lat: -89.125, lon: 18.25, name: 'İşaret A' }, { lat: -88.25, lon: -22.5, name: 'İşaret B' }] };
  const { rerender } = render(<ComparePlanner {...props} />);
  change('B başlangıç (UTC)', '2026-11-19T04:05:06');
  change('B bitiş (UTC)', '2026-11-20T04:05:06');
  fireEvent.click(screen.getByRole('button', { name: 'İşaretli noktaları kullan' }));
  expect(screen.getByLabelText('A enlem (°)')).toHaveValue(-89.125);
  expect(screen.getByLabelText('B doğu boylamı (°)')).toHaveValue(-22.5);
  rerender(<ComparePlanner {...props} markedLocations={[{ lat: -87, lon: 1, name: 'Yeni A' }, { lat: -86, lon: 2, name: 'Yeni B' }]} />);
  expect(screen.getByLabelText('A enlem (°)')).toHaveValue(-89.125);
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  await waitFor(() => expect(compareSites).toHaveBeenCalledWith(expect.objectContaining({ lat: -89.125, lon: 18.25, start_utc: start }), expect.objectContaining({ lat: -88.25, lon: -22.5, start_utc: '2026-11-19T04:05:06.000Z', end_utc: '2026-11-20T04:05:06.000Z' }), expect.anything()));
});

test('catalog and identical wrapped custom coordinates are searched once', async () => {
  const catalog = [{ id: 'pole', name: 'Kutup', lat: -89, lon: 180 }];
  render(<ComparePlanner catalog={catalog} selectedSiteId="pole" currentDateUtc={start} initialScenarioB={{ lat: -89, lon: -180, start_utc: start, end_utc: end }} />);
  showSearch(); fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  await waitFor(() => expect(searchSites).toHaveBeenCalledWith(expect.objectContaining({ locations: [{ site_id: 'pole' }] }), expect.anything()));
});

test('custom slope rejection remains visible with the point identity', async () => {
  (searchSites as jest.Mock).mockResolvedValue({ ...emptySearch, metadata: { ...emptySearch.metadata, rejected_sites: [{ site_id: null, location_index: 1, lat: -88.22, lon: -23.45, name: 'Özel B', reason: 'slope neighborhood unavailable' }] } });
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={b} currentDateUtc={start} />);
  showSearch(); fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  expect(await screen.findByText(/Özel B: ölçülmüş DEM veya eğim komşuluğu/)).toBeInTheDocument();
});

test('8192 site-time search budget overflow is rejected before API call', async () => {
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  showSearch(); change('Arama bitişi (UTC)', '2026-12-22T00:00:00');
  change('Pencere süresi (saat)', '168'); change('Başlangıçlar arası (saat)', '168');
  change('Örnek adımı (saniye)', '600');
  fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('64 pencere veya 8192');
  expect(searchSites).not.toHaveBeenCalled();
});

test('catalog loading never silently chooses A or B; exact custom selection is self-contained', async () => {
  render(<ComparePlanner catalog={sites} currentDateUtc={start} initialScenarioA={a} />);
  expect(screen.getByLabelText('B noktası')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'A / B karşılaştır' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'B: koordinat gir' }));
  expect(screen.getByLabelText('B enlem (°)')).toHaveValue(null);
  change('B enlem (°)', '-89.123456789');
  change('B doğu boylamı (°)', '12.987654321');
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  await waitFor(() => expect(compareSites).toHaveBeenCalledWith(a, expect.objectContaining({ lat: -89.123456789, lon: 12.987654321 }), expect.anything()));
});

test('copies the submitted observation explicitly, including milliseconds; parent rerenders never replace drafts', async () => {
  const observed: PlannerObservation = { lat: -89.123456789, lon: 12.987654321, start_utc: '2026-11-15T04:05:06.123Z', end_utc: '2026-11-16T04:05:06.789Z', step_seconds: 3600 };
  const { rerender } = render(<ComparePlanner catalog={sites} initialScenarioA={observed} currentDateUtc="2027-01-01T00:00:00Z" />);
  expect(screen.getByLabelText('A enlem (°)')).toHaveValue(observed.lat);
  fireEvent.click(screen.getByRole('button', { name: 'Açık gözlemi B’ya kopyala' }));
  change('B enlem (°)', '-88.7654321');
  rerender(<ComparePlanner catalog={sites} initialScenarioA={a} currentDateUtc="2028-01-01T00:00:00Z" />);
  expect(screen.getByLabelText('A enlem (°)')).toHaveValue(observed.lat);
  expect(screen.getByLabelText('B enlem (°)')).toHaveValue(-88.7654321);
  fireEvent.click(screen.getByRole('button', { name: 'A / B karşılaştır' }));
  await waitFor(() => expect(compareSites).toHaveBeenCalledWith(observed, { ...observed, lat: -88.7654321 }, expect.anything()));
});

test('64-window search budget overflow is rejected before API call', async () => {
  render(<ComparePlanner catalog={sites} selectedSiteId="one" initialScenarioB={{ site_id: 'two', start_utc: start, end_utc: end }} currentDateUtc={start} />);
  showSearch(); change('Başlangıçlar arası (saat)', '1');
  fireEvent.click(screen.getByRole('button', { name: 'Uygun nokta ve tarihleri bul' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('64 pencere veya 8192'));
  expect(searchSites).not.toHaveBeenCalled();
});
