import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { setLanguage } from '../../i18n';
import type { SkySeries } from '../../services/skyview';
import ObservationDock from './ObservationDock';
import VisibilityCard from './VisibilityCard';

const start = '2026-11-15T00:00:00Z';
const end = '2026-11-16T00:00:00Z';
// Only API fields consumed by these presentational components are needed here.
const series = {
  site: { lat_deg: -89, lon_deg: 0 }, start_utc: start, end_utc: end, step_seconds: 1800,
  points: [start, end].map(time_utc => ({
    time_utc, hours_until_sunset: 7.25, hours_until_earthset: null,
    sun: { elevation_deg: 2.25, center_visible: true, next_transition: { after_utc: start, by_utc: end, becomes_visible: false } },
    earth: { elevation_deg: -1.5, center_visible: false, next_transition: null },
  })),
  visibility_intervals: {
    sun: { total_visible_hours: 12.25, intervals: [{ start_utc: start, end_utc: end, start_bracket: { after_utc: start, by_utc: start }, end_bracket: null, clipped_start: true, clipped_end: true }] },
    earth: { total_visible_hours: 0, intervals: [] }, resolution_seconds: 1800,
  },
} as unknown as SkySeries;

beforeEach(() => setLanguage('en'));
afterEach(() => setLanguage('en'));

test('visibility readouts, timelines, interval labels and formatting follow live language changes', () => {
  const onSelectTime = jest.fn();
  render(<VisibilityCard series={series} index={0} loading={false} onOpenMetrics={jest.fn()} onSelectTime={onSelectTime} />);
  const sun = within(screen.getByRole('region', { name: 'Sun visibility' }));
  expect(sun.getByText('12.25 h')).toBeInTheDocument();
  expect(sun.getByText('7.25 h')).toBeInTheDocument();
  expect(sun.getByText('(51%)')).toBeInTheDocument();
  expect(screen.getByText('not detected in window')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Timelines' }));
  const interval = screen.getByRole('button', { name: /Sun visible interval 1:.*clipped at window start; clipped at window end/ });
  fireEvent.click(interval);
  expect(onSelectTime).toHaveBeenCalledWith(start);
  expect(screen.getByText('No visible intervals in this window.')).toBeInTheDocument();
  expect(screen.getByText(/Appearance bracket:/)).toBeInTheDocument();
  act(() => setLanguage('tr'));
  expect(screen.getByRole('region', { name: 'Güneş görünürlüğü' })).toBeInTheDocument();
  expect(screen.getByText('12,25 sa')).toBeInTheDocument();
  expect(screen.getByText('7,25 sa')).toBeInTheDocument();
  expect(screen.getByText('(%51)')).toBeInTheDocument();
  expect(screen.getByText('Bu pencerede görünür aralık yok.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Güneş görünür aralık 1:.*pencere başında kırpıldı; pencere sonunda kırpıldı/ })).toBeInTheDocument();
});

test('dock localizes UTC dates, controls and sampling without changing sample values', () => {
  const onIndexChange = jest.fn();
  render(<ObservationDock series={series} index={0} playing={false} loading={false} onIndexChange={onIndexChange} onTogglePlay={jest.fn()} onOpenSettings={jest.fn()} onPlaybackSpeedChange={jest.fn()} />);
  expect(screen.getByRole('button', { name: /Nov 15, 2026.*Open date and time settings/ })).toBeInTheDocument();
  expect(screen.getByText('Sampling · 30 min · 1/2')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Playback speed' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next sample' }));
  expect(onIndexChange).toHaveBeenCalledWith(1);
  act(() => setLanguage('tr'));
  expect(screen.getByRole('button', { name: /15 Kas 2026.*Tarih ve saat ayarlarını aç/ })).toBeInTheDocument();
  expect(screen.getByText('Örnekleme · 30 dk · 1/2')).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'Gözlem örneği' })).toHaveAttribute('aria-valuetext', `${start} · UTC`);
});

test('empty and loading messages follow the current language', () => {
  const props = { series: null, index: 0, loading: false, onOpenMetrics: jest.fn(), onSelectTime: jest.fn() };
  const { rerender } = render(<VisibilityCard {...props} />);
  expect(screen.getByText('No visibility data. Select an observation site and time window.')).toBeInTheDocument();
  rerender(<VisibilityCard {...props} loading />);
  expect(screen.getByRole('status')).toHaveTextContent('Calculating visibility…');
  act(() => setLanguage('tr'));
  expect(screen.getByRole('status')).toHaveTextContent('Görünürlük hesaplanıyor…');
});
