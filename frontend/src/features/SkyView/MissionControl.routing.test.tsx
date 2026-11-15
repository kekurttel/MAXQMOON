import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MissionControl from './MissionControl';
import { fetchSkySites, fetchSkySeries, fetchCustomSkySeries } from '../../services/skyview';
import type { SkySeries } from '../../services/skyview';

jest.mock('../../services/skyview', () => ({ fetchSkySites: jest.fn(), fetchSkySeries: jest.fn(), fetchCustomSkySeries: jest.fn() }));
jest.mock('./SkyViewGraph', () => () => <div>Graph</div>);
jest.mock('./ComparePlanner', () => ({ initialScenarioA, currentDateUtc }: { initialScenarioA?: { start_utc: string }; currentDateUtc?: string }) => <div>Planner A: {initialScenarioA?.start_utc} · Search: {currentDateUtc}</div>);
jest.mock('./CompassView', () => ({ series, point }: { series: SkySeries; point: SkySeries['points'][number] }) => <div>Compass {series.site.lat_deg}, {series.site.lon_deg} · {point.time_utc}</div>);
jest.mock('./SystemView', () => ({ __esModule: true, default: ({ onEnterPanorama, onRejectLocation }: any) => <>
  <button onClick={() => onRejectLocation({ lat: 12.34567, lon: -99.12345 }, 'Bu konum için arazi verisi yok.')}>Apply unsupported point</button>
  <button onClick={() => onEnterPanorama({ lat: -88, lon: -180 })}>Enter B without ID</button>
  <button onClick={() => onEnterPanorama({ lat: -88.12345, lon: 12.34567 })}>Observe exact draft</button>
</> }));
const sites = [{ id: 'a', name: 'Ready A', lat: -89, lon: 12 }, { id: 'b', name: 'Ready B', lat: -88, lon: 180 }];
const series: SkySeries = {
  frame: 'MOON_ME_DE421',
  site: { lat_deg: -89, lon_deg: 12, surface_elevation_m: 0, observer_height_m: 2 },
  start_utc: '2026-11-15T00:00:00Z', end_utc: '2026-11-18T00:00:00Z', step_seconds: 600,
  points: [{
    time_utc: '2026-11-15T00:00:00Z',
    sun: { azimuth_deg: 90, elevation_deg: 1, distance_km: 149600000, horizon_elevation_deg: 0, clearance_deg: 1, center_visible: true, next_transition: null },
    earth: { azimuth_deg: 180, elevation_deg: 2, distance_km: 384400, horizon_elevation_deg: 0, clearance_deg: 2, center_visible: true, next_transition: null },
  }],
  horizon: {
    frame: 'MOON_ME_DE421', geodetic: 'planetocentric', azimuths_deg: [0], elevations_deg: [0], surface_elevation_m: 0, observer_height_m: 2,
    coverage: {
      kind: 'local_dem', requested_max_distance_m: 1000, distance_step_m: 100, near_sample_distances_m: [],
      azimuth_step_deg: 1, truncated: true, complete_within_requested_radius: false, rays: [], per_ray_max_distance_m: [],
      whole_moon_horizon_certified: false, beyond_sampled_extent: 'unknown', limitations: ['Local DEM only'],
    },
    provenance: {
      file: 'test-dem', sha256: 'test', packaged_sha256: 'test', matches_packaged_asset: true, hash_meaning: 'fixture',
      frame: 'MOON_ME_DE421', geodetic: 'planetocentric', longitude_convention: 'east', reference_radius_m: 1737400,
      height_datum: 'reference sphere', projection: 'polar', source_product: 'test', source_label_url: null,
      source_coordinate_system_name: null, nodata_policy: 'reject', rows: 1, cols: 1, spacing_m: 100,
      line0: 0, sample0: 0, scale_m: 1, bounds_projected_m: { x_min: 0, x_max: 100, y_min: 0, y_max: 100 },
    },
  },
  provenance: { engine: 'SPICE', frame: 'MOON_ME_DE421', time_input: 'UTC', aberration_correction: 'NONE', coordinates: 'topocentric', kernels: [], visibility_definition: 'center above local horizon', limits: ['Sampled center'] },
};

beforeEach(() => {
  jest.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  (fetchSkySites as jest.Mock).mockResolvedValue(sites);
  (fetchSkySeries as jest.Mock).mockResolvedValue(series);
  (fetchCustomSkySeries as jest.Mock).mockResolvedValue(series);
});

test.each([
  ['-88', '-180', 'catalog'],
  ['-88.0001', '12.3456', 'custom'],
])('typed coordinates %s / %s preserve routing through date change', async (lat, lon, kind) => {
  render(<MissionControl />);
  await screen.findByText('Graph');
  fireEvent.click(screen.getByRole('button', { name: /Gözlem noktası/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Özel koordinat' }));
  fireEvent.change(screen.getByLabelText('Enlem'), { target: { value: lat } });
  fireEvent.change(screen.getByLabelText('Boylam'), { target: { value: lon } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Bu noktayı gözle/ })); });
  const api = kind === 'catalog' ? fetchSkySeries : fetchCustomSkySeries;
  const location = kind === 'catalog' ? { site_id: 'b' } : { lat: Number(lat), lon: Number(lon) };
  await waitFor(() => expect(api).toHaveBeenLastCalledWith(expect.objectContaining(location), expect.anything()));
  if (kind === 'catalog') expect(fetchCustomSkySeries).not.toHaveBeenCalled();
  await screen.findByText('Graph');
  fireEvent.click(screen.getByRole('button', { name: /2 Zaman aralığı/ }));
  fireEvent.change(screen.getByLabelText('Başlangıç · UTC'), { target: { value: '2027-01-02' } });
  fireEvent.change(screen.getByLabelText('Saat · UTC'), { target: { value: '12:30' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Gözlemi hesapla/ })); });
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ ...location, start_utc: '2027-01-02T12:30:00.000Z' }), expect.anything());
});

test('SystemView panorama callback resolves wrapped ready location without metadata', async () => {
  render(<MissionControl />);
  await screen.findByText('Graph');
  fireEvent.click(screen.getByRole('button', { name: /1 Nokta seç/ }));
  await screen.findByRole('button', { name: 'Enter B without ID' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enter B without ID' })); });
  expect(fetchSkySeries).toHaveBeenLastCalledWith(expect.objectContaining({ site_id: 'b' }), expect.anything());
  expect(fetchCustomSkySeries).not.toHaveBeenCalled();
});

test('applying an unsupported global location clears previous data, retains exact context, never snaps', async () => {
  render(<MissionControl />);
  await screen.findByText('Graph');
  fireEvent.click(screen.getByRole('button', { name: /1 Nokta seç/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Apply unsupported point' }));
  expect(screen.queryByText('Graph')).toBeNull();
  expect(screen.queryByText('Compass')).toBeNull();
  expect(screen.getAllByText('Bu konum için arazi verisi yok.').length).toBeGreaterThan(0);
  expect(screen.getAllByText('12.34567°, -99.12345°').length).toBeGreaterThan(0);
  expect(fetchSkySeries).toHaveBeenCalledTimes(1);
  expect(fetchCustomSkySeries).not.toHaveBeenCalled();
});

test('speed changes actual sample advancement and survives view switch; unmount clears timer', async () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({ ...series.points[0], time_utc: `2026-11-15T0${i}:00:00Z` }));
  (fetchSkySeries as jest.Mock).mockResolvedValue({ ...series, points: samples });
  const page = render(<MissionControl />);
  await screen.findByText('Graph');
  jest.useFakeTimers();
  try {
    fireEvent.change(screen.getByLabelText('Oynatma hızı'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Oynat' }));
    act(() => { jest.advanceTimersByTime(180); });
    expect((screen.getByLabelText('Gözlem örneği') as HTMLInputElement).value).toBe('0');
    act(() => { jest.advanceTimersByTime(180); });
    expect((screen.getByLabelText('Gözlem örneği') as HTMLInputElement).value).toBe('1');
    fireEvent.change(screen.getByLabelText('Oynatma hızı'), { target: { value: '4' } });
    act(() => { jest.advanceTimersByTime(45); });
    expect((screen.getByLabelText('Gözlem örneği') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: '3D Pusula' }));
    expect((screen.getByLabelText('Oynatma hızı') as HTMLSelectElement).value).toBe('4');
    act(() => { jest.advanceTimersByTime(45); });
    expect((screen.getByLabelText('Gözlem örneği') as HTMLInputElement).value).toBe('3');
    page.unmount();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('planner search starts at observed sample, not an unapplied time draft; A retains series range', async () => {
  (fetchSkySeries as jest.Mock).mockResolvedValue({ ...series, points: [series.points[0], { ...series.points[0], time_utc: '2026-11-15T03:00:00Z' }] });
  render(<MissionControl />);
  await screen.findByText('Graph');
  fireEvent.change(screen.getByLabelText('Gözlem örneği'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: /2 Zaman aralığı/ }));
  fireEvent.change(screen.getByLabelText('Başlangıç · UTC'), { target: { value: '2027-01-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pencereyi kapat' }));
  fireEvent.click(screen.getByRole('button', { name: /3 Koşullar/ }));
  expect(screen.getByText('Planner A: 2026-11-15T00:00:00Z · Search: 2026-11-15T03:00:00Z')).toBeTruthy();
});

test('applying a new draft clears previous data until exact requested location returns', async () => {
  let complete!: (value: SkySeries) => void;
  (fetchCustomSkySeries as jest.Mock).mockImplementation(() => new Promise<SkySeries>(resolve => { complete = resolve; }));
  render(<MissionControl />);
  await screen.findByText('Graph');
  fireEvent.click(screen.getByRole('button', { name: /1 Nokta seç/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Observe exact draft' }));
  expect(fetchCustomSkySeries).toHaveBeenCalledWith(expect.objectContaining({ lat: -88.12345, lon: 12.34567 }), expect.anything());
  expect(screen.queryByText('Graph')).toBeNull();
  expect(screen.queryByText(/Compass/)).toBeNull();
  expect(screen.getAllByText('-88.12345°, 12.34567°').length).toBeGreaterThan(0);
  await act(async () => { complete({ ...series, site: { ...series.site, lat_deg: -88.12345, lon_deg: 12.34567 } }); });
  expect(await screen.findByText('Compass -88.12345, 12.34567 · 2026-11-15T00:00:00Z')).toBeTruthy();
});
