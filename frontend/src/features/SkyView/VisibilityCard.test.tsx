import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SkyBody, SkySeries, SkyVisibilityIntervals } from '../../services/skyview';
import VisibilityCard from './VisibilityCard';

const start = '2026-11-15T00:00:00Z';
const end = '2026-11-16T00:00:00Z';
const sun: SkyBody = {
  azimuth_deg: 94, elevation_deg: 2.25, distance_km: 149600000,
  horizon_elevation_deg: 1, clearance_deg: 1.25, center_visible: true,
  next_transition: { after_utc: '2026-11-15T18:00:00Z', by_utc: '2026-11-15T20:00:00Z', becomes_visible: false },
};
const earth: SkyBody = {
  azimuth_deg: 190, elevation_deg: -1.5, distance_km: 384400,
  horizon_elevation_deg: 0, clearance_deg: -1.5, center_visible: false, next_transition: null,
};
// API-shaped test fixture only: no fallback data is shipped by the component.
const series: SkySeries = {
  frame: 'IAU_MOON', site: { lat_deg: -89, lon_deg: 0, surface_elevation_m: 0, observer_height_m: 2 },
  start_utc: start, end_utc: end, step_seconds: 7200,
  points: [{ time_utc: '2026-11-15T12:00:00Z', sun, earth }],
  horizon: {
    frame: 'IAU_MOON', geodetic: 'planetocentric', azimuths_deg: [0], elevations_deg: [0], surface_elevation_m: 0, observer_height_m: 2,
    coverage: {
      kind: 'local_dem', requested_max_distance_m: 1000, distance_step_m: 100, near_sample_distances_m: [],
      azimuth_step_deg: 1, truncated: true, complete_within_requested_radius: false, rays: [], per_ray_max_distance_m: [],
      whole_moon_horizon_certified: false, beyond_sampled_extent: 'unknown', limitations: ['Local DEM only'],
    },
    provenance: {
      file: 'test-dem', sha256: 'test', packaged_sha256: 'test', matches_packaged_asset: true, hash_meaning: 'fixture',
      frame: 'IAU_MOON', geodetic: 'planetocentric', longitude_convention: 'east', reference_radius_m: 1737400,
      height_datum: 'reference sphere', projection: 'polar', source_product: 'test', source_label_url: null,
      source_coordinate_system_name: null, nodata_policy: 'reject', rows: 1, cols: 1, spacing_m: 100,
      line0: 0, sample0: 0, scale_m: 1, bounds_projected_m: { x_min: 0, x_max: 100, y_min: 0, y_max: 100 },
    },
  },
  provenance: { engine: 'SPICE', frame: 'IAU_MOON', time_input: 'UTC', aberration_correction: 'NONE', coordinates: 'topocentric', kernels: [], visibility_definition: 'center above local horizon', limits: ['Sampled center'] },
};
const withIntervals: SkySeries & { visibility_intervals: SkyVisibilityIntervals } = {
  ...series,
  visibility_intervals: {
    sun: { total_visible_hours: 12, intervals: [{
      start_utc: '2026-11-15T07:00:00Z', end_utc: '2026-11-15T19:00:00Z',
      start_bracket: { after_utc: '2026-11-15T06:00:00Z', by_utc: '2026-11-15T08:00:00Z' },
      end_bracket: { after_utc: '2026-11-15T18:00:00Z', by_utc: '2026-11-15T20:00:00Z' },
      clipped_start: false, clipped_end: false,
    }] },
    earth: { total_visible_hours: 12, intervals: [
      { start_utc: start, end_utc: '2026-11-15T06:00:00Z', start_bracket: null, end_bracket: { after_utc: '2026-11-15T05:00:00Z', by_utc: '2026-11-15T07:00:00Z' }, clipped_start: true, clipped_end: false },
      { start_utc: '2026-11-15T18:00:00Z', end_utc: end, start_bracket: { after_utc: '2026-11-15T17:00:00Z', by_utc: '2026-11-15T19:00:00Z' }, end_bracket: null, clipped_start: false, clipped_end: true },
    ] },
    method: 'sampled-center-visibility-midpoint', resolution_seconds: 7200,
  },
};
const callbacks = () => ({ onOpenMetrics: jest.fn(), onSelectTime: jest.fn() });

test('reports current center visibility, elevation, transition bracket and UTC window', () => {
  render(<VisibilityCard series={withIntervals} index={0} loading={false} {...callbacks()} />);
  const sunReadout = within(screen.getByRole('region', { name: 'Güneş görünürlüğü' }));
  expect(sunReadout.getByText('Seçili an: Görünür')).toBeTruthy();
  expect(sunReadout.getByText('2.25°')).toBeTruthy();
  expect(sunReadout.getByText('12 sa')).toBeTruthy();
  expect(sunReadout.getByText('2026-11-15 18:00:00')).toBeTruthy();
  expect(sunReadout.getByText('2026-11-15 20:00:00')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Dünya görünürlüğü' })).getByText('Seçili an: Arazi arkasında')).toBeTruthy();
  expect(screen.getByText('2026-11-16 00:00:00')).toBeTruthy();
});

test('null or pending data never shows old measurements', () => {
  const { rerender } = render(<VisibilityCard series={null} index={0} loading={false} {...callbacks()} />);
  expect(screen.getByText(/Görünürlük verisi yok/)).toBeTruthy();
  rerender(<VisibilityCard series={withIntervals} index={0} loading {...callbacks()} />);
  expect(screen.getByRole('status').textContent).toBe('Görünürlük hesaplanıyor…');
  expect(screen.queryByText('2.25°')).toBeNull();
  expect(screen.queryByText('12 sa')).toBeNull();
  expect(screen.queryByText('2026-11-16 00:00:00')).toBeNull();
});

test('missing intervals are explicit, not reconstructed from points', () => {
  render(<VisibilityCard series={series} index={0} loading={false} {...callbacks()} />);
  expect(screen.getByText(/Görünürlük aralıkları mevcut değil/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Zaman çizelgeleri' }));
  expect(screen.getByText(/Örneklerden aralık türetilmez/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Güneş görünürlük zaman çizelgesi' })).toBeNull();
});

test('expanded tracks use actual UTC duration and bracket midpoints, with clipping and selection callbacks', () => {
  const actions = callbacks();
  render(<VisibilityCard series={withIntervals} index={0} loading={false} {...actions} />);
  const expand = screen.getByRole('button', { name: 'Zaman çizelgeleri' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(expand);
  expect(expand.getAttribute('aria-expanded')).toBe('true');
  const sunInterval = screen.getByRole('button', { name: /^Güneş görünür aralık 1:/ });
  expect(parseFloat(sunInterval.style.width)).toBeCloseTo(50);
  expect(parseFloat(sunInterval.style.left)).toBeCloseTo(29.16667);
  fireEvent.click(sunInterval);
  expect(actions.onSelectTime).toHaveBeenCalledWith('2026-11-15T08:00:00Z');
  fireEvent.click(screen.getByRole('button', { name: /2026-11-15 07:00:00 → 2026-11-15 19:00:00 UTC/ }));
  expect(actions.onSelectTime).toHaveBeenLastCalledWith('2026-11-15T08:00:00Z');
  fireEvent.click(screen.getByRole('button', { name: /^Dünya görünür aralık 1:/ }));
  expect(actions.onSelectTime).toHaveBeenLastCalledWith(start);
  expect(screen.getByText('Pencere başında kırpıldı')).toBeTruthy();
  expect(screen.getByText('Pencere sonunda kırpıldı')).toBeTruthy();
  expect(screen.getByText(/yıllık sıralama/)).toBeTruthy();
  expect(screen.getByText('Görünme parantezi: 2026-11-15 06:00:00 – 2026-11-15 08:00:00 UTC')).toBeTruthy();
  expect(screen.getByText('Kaybolma parantezi: 2026-11-15 18:00:00 – 2026-11-15 20:00:00 UTC')).toBeTruthy();
  expect(screen.getByText(/Sonraki geçiş bu aralıkta saptanmadı; aralık dışı bilinmiyor/)).toBeTruthy();
  expect(screen.getByText(/Güneş saati enerji üretimi değildir/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ölçümler ve sınırlar' }));
  expect(actions.onOpenMetrics).toHaveBeenCalledTimes(1);
});

test('mobile disclosure opens without changing the selected observation', () => {
  const actions = callbacks();
  render(<VisibilityCard series={withIntervals} index={0} loading={false} {...actions} />);
  const toggle = screen.getByRole('button', { name: 'Güneş ve Dünya saatlerini aç' });
  expect(toggle).toHaveTextContent('Güneş 12 sa · Dünya 12 sa');
  expect(toggle).toHaveTextContent('-89°, 0° · UTC');
  expect(toggle).toHaveTextContent('2026-11-15 00:00:00 – 2026-11-16 00:00:00');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.closest('aside')?.classList.contains('is-mobile-open')).toBe(true);
  expect(actions.onSelectTime).not.toHaveBeenCalled();
});

test('set countdown uses root API fields, not the next rise or the window total', () => {
  const data = { ...withIntervals, points: [{ ...series.points[0], hours_until_sunset: 7.25, hours_until_earthset: null }] };
  const { rerender } = render(<VisibilityCard series={data} index={0} loading={false} {...callbacks()} />);
  expect(within(screen.getByRole('region', { name: 'Güneş görünürlüğü' })).getByText('7,25 sa')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Dünya görünürlüğü' })).getByText('aralıkta saptanmadı')).toBeTruthy();
  rerender(<VisibilityCard series={withIntervals} index={0} loading={false} {...callbacks()} />);
  expect(within(screen.getByRole('region', { name: 'Güneş görünürlüğü' })).getByText('veri yok')).toBeTruthy();
  rerender(<VisibilityCard series={data} index={0} loading {...callbacks()} />);
  expect(screen.queryByText('7,25 sa')).toBeNull();
});

test('empty backend interval sets remain empty', () => {
  const empty = { ...withIntervals, visibility_intervals: { ...withIntervals.visibility_intervals, sun: { total_visible_hours: 0, intervals: [] } } };
  render(<VisibilityCard series={empty} index={0} loading={false} {...callbacks()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Zaman çizelgeleri' }));
  expect(screen.getByText('Bu pencerede görünür aralık yok.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Güneş görünür aralık 1:/ })).toBeNull();
});
