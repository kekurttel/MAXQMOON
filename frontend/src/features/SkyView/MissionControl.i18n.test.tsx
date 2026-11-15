import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import MissionControl from './MissionControl';
import { setLanguage } from '../../i18n';
import { fetchSkySites, fetchSkySeries } from '../../services/skyview';
import type { SkyBody, SkySeries } from '../../services/skyview';

jest.mock('../../services/skyview', () => ({ fetchSkySites: jest.fn(), fetchSkySeries: jest.fn(), fetchCustomSkySeries: jest.fn() }));
jest.mock('./SkyViewGraph', () => () => <div>Graph</div>);
jest.mock('./ObservationDock', () => () => null);
jest.mock('./VisibilityCard', () => ({ onOpenMetrics }: { onOpenMetrics: () => void }) => <button onClick={onOpenMetrics}>Open metrics</button>);
jest.mock('./CompassView', () => () => null);
jest.mock('./SystemView', () => () => null);
jest.mock('./ComparePlanner', () => () => null);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  jest.clearAllMocks();
  setLanguage('en');
  (fetchSkySites as jest.Mock).mockResolvedValue([{ id: 'a', name: 'Catalog A', lat: -89, lon: 0, dem_covered: false }]);
  (fetchSkySeries as jest.Mock).mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { act(() => setLanguage('tr')); });

function switchLanguage() {
  fireEvent.click(screen.getByRole('button', { name: 'Switch language' }));
}

test('pending calculation and navigation switch language without refetching', async () => {
  render(<MissionControl />);
  expect(await screen.findByText('Calculating sky positions')).toBeInTheDocument();
  expect(screen.getByRole('main', { name: 'Sky observation' })).toBeInTheDocument();
  switchLanguage();
  expect(screen.getByText('Gökyüzü hesaplanıyor')).toBeInTheDocument();
  expect(screen.getByText('Animasyon dekoratiftir; hesap ilerleme yüzdesi değildir.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /2 Zaman aralığı/ })).toBeInTheDocument();
  expect(fetchSkySites).toHaveBeenCalledTimes(1);
  expect(fetchSkySeries).toHaveBeenCalledTimes(1);
});

test('catalog fallback is translated at display time without another request', async () => {
  (fetchSkySites as jest.Mock).mockRejectedValue(new Error(''));
  render(<MissionControl />);
  expect(await screen.findByText('Could not load the site list.')).toBeInTheDocument();
  switchLanguage();
  expect(screen.getByText('Nokta listesi alınamadı.')).toBeInTheDocument();
  expect(fetchSkySites).toHaveBeenCalledTimes(1);
});

test('metrics and transition dates switch between en-GB and tr-TR without refetching', async () => {
  const timestamp = '2026-11-15T00:00:00Z';
  const body: SkyBody = { azimuth_deg: 90, elevation_deg: 1, distance_km: 1000, horizon_elevation_deg: 0, clearance_deg: 1, center_visible: true, next_transition: { after_utc: timestamp, by_utc: '2026-11-15T00:10:00Z', becomes_visible: false } };
  const series = {
    start_utc: timestamp, end_utc: '2026-11-18T00:00:00Z', step_seconds: 600,
    site: { lat_deg: -89, lon_deg: 0, surface_elevation_m: 10, observer_height_m: 2 },
    points: [{ time_utc: timestamp, sun: body, earth: { ...body, center_visible: false } }],
    horizon: { coverage: { requested_max_distance_m: 1000 } },
  } as SkySeries;
  (fetchSkySeries as jest.Mock).mockResolvedValue(series);
  render(<MissionControl />);
  await screen.findByText('Graph');
  fireEvent.click(screen.getByRole('button', { name: 'Open metrics' }));
  expect(screen.getByRole('heading', { name: 'Sun' })).toBeInTheDocument();
  expect(screen.getByText('Behind terrain')).toBeInTheDocument();
  expect(screen.getAllByText('Next disappearance')).toHaveLength(2);
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  const englishDate = new Date(timestamp).toLocaleString('en-GB', options);
  expect(screen.getByText(englishDate, { exact: false, selector: '.sv-time-stamp' })).toBeInTheDocument();
  switchLanguage();
  expect(screen.getByRole('heading', { name: 'Güneş' })).toBeInTheDocument();
  expect(screen.getAllByText('Sonraki örtülme')).toHaveLength(2);
  const turkishDate = new Date(timestamp).toLocaleString('tr-TR', options);
  expect(screen.getByText(turkishDate, { exact: false, selector: '.sv-time-stamp' })).toBeInTheDocument();
  expect(fetchSkySeries).toHaveBeenCalledTimes(1);
});

test('sites, settings and sources have English copy and accessible names', async () => {
  (fetchSkySeries as jest.Mock).mockRejectedValue(new Error(''));
  render(<MissionControl />);
  await screen.findByText('Could not load the sky calculation.');
  fireEvent.click(screen.getByRole('button', { name: /Observation site/ }));
  expect(screen.getByRole('dialog', { name: 'Observation sites' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Search observation sites' })).toHaveAttribute('placeholder', 'Search by name or ID…');
  expect(screen.getByText(/Outside DEM coverage/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Custom coordinates' }));
  expect(screen.getByLabelText('Latitude')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: /2 Time range/ }));
  expect(screen.getByLabelText('Start · UTC')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: '3 days' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(screen.getByRole('button', { name: 'Data source and calculation limits' }));
  expect(screen.getByRole('dialog', { name: 'Data and calculation limits' })).toBeInTheDocument();
  expect(screen.getByText(/The 3D compass uses the same coordinates/)).toBeInTheDocument();
  switchLanguage();
  expect(screen.getByRole('dialog', { name: 'Veri ve hesap sınırları' })).toBeInTheDocument();
  expect(fetchSkySeries).toHaveBeenCalledTimes(1);
});
