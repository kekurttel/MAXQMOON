import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MissionControl from './MissionControl';
import { fetchSkySites, fetchSkySeries, fetchCustomSkySeries } from '../../services/skyview';

jest.mock('../../services/skyview', () => ({ fetchSkySites: jest.fn(), fetchSkySeries: jest.fn(), fetchCustomSkySeries: jest.fn() }));
jest.mock('./SkyViewGraph', () => () => <div>Test gökyüzü</div>);
jest.mock('./CompassView', () => () => <div>Test yüzey</div>);
jest.mock('./SystemView', () => ({ __esModule: true, default: ({ series }: { series: unknown }) => <div>Küre seçim aracı · {series ? 'veri var' : 'verisiz erişilebilir'}</div> }));
jest.mock('./ComparePlanner', () => ({ __esModule: true, default: ({ onSelectObservation, currentDateUtc }: { onSelectObservation: (value: unknown) => void; currentDateUtc?: string }) => <><span>Planlayıcı UTC: {currentDateUtc ? new Date(currentDateUtc).toISOString() : 'varsayılan'}</span><button onClick={() => onSelectObservation({ lat: -88.12345, lon: 12.34567, start_utc: '2026-11-15T12:03:17Z', end_utc: '2026-11-15T15:17:23Z', step_seconds: 1800 })}>Özel B sonucunu aç</button></> }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  jest.clearAllMocks();
  (fetchSkySites as jest.Mock).mockResolvedValue([{ id: 'a', name: 'Test nokta', lat: -89, lon: 0 }]);
  (fetchSkySeries as jest.Mock).mockRejectedValue(new Error('Girilen koordinat DEM kapsama alanı dışında.'));
  (fetchCustomSkySeries as jest.Mock).mockRejectedValue(new Error('Test sonucu hatası'));
});

test('header uses the supplied project logo', async () => {
  render(<MissionControl />);
  const brand = screen.getByRole('link', { name: 'MAXQMOON ana sayfa' });
  expect(brand.querySelector('img')?.getAttribute('src')).toBe('/lunarsight-logo.jpg');
  expect(brand.querySelector('img')?.getAttribute('alt')).toBe('');
  await screen.findByText('Girilen koordinat DEM kapsama alanı dışında.');
});

test('failed observation never prevents opening the globe to choose another point', async () => {
  render(<MissionControl />);
  await screen.findByText('Girilen koordinat DEM kapsama alanı dışında.');
  fireEvent.click(screen.getByRole('button', { name: /1 Nokta seç/ }));
  expect(await screen.findByText('Küre seçim aracı · verisiz erişilebilir')).toBeTruthy();
});

test('applying custom planner result keeps exact coordinates, end UTC and cadence', async () => {
  render(<MissionControl />);
  await screen.findByText('Girilen koordinat DEM kapsama alanı dışında.');
  fireEvent.click(screen.getByRole('button', { name: /3 Koşullar/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Özel B sonucunu aç' }));
  await waitFor(() => expect(fetchCustomSkySeries).toHaveBeenCalledWith({ lat: -88.12345, lon: 12.34567, start_utc: '2026-11-15T12:03:17.000Z', end_utc: '2026-11-15T15:17:23.000Z', step_seconds: 1800 }, expect.any(AbortSignal)));
  expect(fetchSkySeries).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /3 Koşullar/ }));
  expect(await screen.findByText('Planlayıcı UTC: 2026-11-15T12:03:17.000Z')).toBeTruthy();
});

test('invalid exact-ended draft keeps the time repair panel visible when selecting a site', async () => {
  render(<MissionControl />);
  await screen.findByText('Girilen koordinat DEM kapsama alanı dışında.');
  fireEvent.click(screen.getByRole('button', { name: /3 Koşullar/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Özel B sonucunu aç' }));
  await waitFor(() => expect(fetchCustomSkySeries).toHaveBeenCalledTimes(1));
  await screen.findByText('Test sonucu hatası');
  fireEvent.click(screen.getByRole('button', { name: /2 Zaman aralığı/ }));
  fireEvent.change(screen.getByLabelText('Başlangıç · UTC'), { target: { value: '2026-11-16' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pencereyi kapat' }));
  fireEvent.click(screen.getByRole('button', { name: /Gözlem noktası/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Katalog/ }));
  fireEvent.click(screen.getByRole('button', { name: /Test nokta/ }));
  expect(await screen.findByText('Geçerli UTC başlangıç ve bitiş zamanı seçin.')).toBeTruthy();
  expect(screen.getByLabelText('Başlangıç · UTC')).toBeTruthy();
  expect(fetchSkySeries).toHaveBeenCalledTimes(1);
});

test('loading display is driven by pending API request rather than an artificial timer', async () => {
  (fetchSkySeries as jest.Mock).mockImplementation(() => new Promise(() => {}));
  render(<MissionControl />);
  expect(await screen.findByText('Animasyon dekoratiftir; hesap ilerleme yüzdesi değildir.')).toBeTruthy();
});
