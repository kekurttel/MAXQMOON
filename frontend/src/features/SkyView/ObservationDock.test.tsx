import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SkySeries } from '../../services/skyview';
import ObservationDock, { ObservationDockProps } from './ObservationDock';

// Only the API fields consumed by this presentational control are relevant here.
const series = {
  start_utc: '2026-11-15T12:00:00Z',
  end_utc: '2026-11-15T15:00:00Z',
  step_seconds: 1800,
  points: [
    { time_utc: '2026-11-15T12:03:17Z' },
    { time_utc: '2026-11-15T12:33:17Z' },
    { time_utc: '2026-11-15T13:03:17Z' },
  ],
} as SkySeries;

function props(overrides: Partial<ObservationDockProps> = {}): ObservationDockProps {
  return {
    series, index: 1, playing: false, loading: false,
    onIndexChange: jest.fn(), onTogglePlay: jest.fn(), onOpenSettings: jest.fn(),
    ...overrides,
  };
}

it('shows the selected actual UTC point rather than deriving time from the request bounds', () => {
  render(<ObservationDock {...props()} />);
  expect(screen.getByRole('button', { name: /12:33:17 UTC/ })).toBeTruthy();
  expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('2026-11-15T12:33:17Z · UTC');
  expect(screen.getByText('Örnekleme · 30 dk · 2/3')).toBeTruthy();
});

it('dispatches settings, previous, next, play, and slider callbacks', () => {
  const callbacks = props();
  render(<ObservationDock {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: /Tarih ve saat ayarlarını aç/ }));
  expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Önceki örnek' }));
  expect(callbacks.onIndexChange).toHaveBeenLastCalledWith(0);
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki örnek' }));
  expect(callbacks.onIndexChange).toHaveBeenLastCalledWith(2);
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(callbacks.onIndexChange).toHaveBeenLastCalledWith(0);
  fireEvent.click(screen.getByRole('button', { name: 'Oynat' }));
  expect(callbacks.onTogglePlay).toHaveBeenCalledTimes(1);
});

it('disables previous and next at the sample boundaries', () => {
  const callbacks = props({ index: 0 });
  const { rerender } = render(<ObservationDock {...callbacks} />);
  expect((screen.getByRole('button', { name: 'Önceki örnek' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Önceki örnek' }));
  expect(callbacks.onIndexChange).not.toHaveBeenCalled();
  rerender(<ObservationDock {...callbacks} index={2} />);
  expect((screen.getByRole('button', { name: 'Sonraki örnek' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki örnek' }));
  expect(callbacks.onIndexChange).not.toHaveBeenCalled();
});

it('renders the pause action while playing', () => {
  const callbacks = props({ playing: true });
  render(<ObservationDock {...callbacks} />);
  fireEvent.click(screen.getByRole('button', { name: 'Duraklat' }));
  expect(callbacks.onTogglePlay).toHaveBeenCalledTimes(1);
});

it.each([
  { series: null, loading: false, label: 'Tarih / saat seç' },
  { series, loading: true, label: 'Hesaplanıyor' },
  { series: { ...series, points: [] }, loading: false, label: 'Tarih / saat seç' },
])('keeps settings available without showing stale data: $label', ({ series: value, loading, label }) => {
  const callbacks = props({ series: value, loading });
  render(<ObservationDock {...callbacks} />);
  const settings = screen.getByRole('button', { name: new RegExp(label.replace('/', '\\/')) });
  expect((settings as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(settings);
  expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/12:33:17/)).toBeNull();
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
  for (const name of ['Önceki örnek', 'Oynat', 'Sonraki örnek']) {
    const button = screen.getByRole('button', { name });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(callbacks.onTogglePlay).not.toHaveBeenCalled();
  expect(callbacks.onIndexChange).not.toHaveBeenCalled();
});

it('changes controlled playback speed without changing the selected UTC sample', () => {
  const onPlaybackSpeedChange = jest.fn();
  const callbacks = props({ playbackSpeed: 2, onPlaybackSpeedChange });
  const { rerender } = render(<ObservationDock {...callbacks} />);
  expect((screen.getByRole('combobox', { name: 'Oynatma hızı' }) as HTMLSelectElement).value).toBe('2');
  fireEvent.change(screen.getByRole('combobox', { name: 'Oynatma hızı' }), { target: { value: '4' } });
  expect(onPlaybackSpeedChange).toHaveBeenCalledWith(4);
  expect(callbacks.onIndexChange).not.toHaveBeenCalled();
  expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('2026-11-15T12:33:17Z · UTC');
  rerender(<ObservationDock {...callbacks} loading />);
  expect((screen.getByRole('combobox', { name: 'Oynatma hızı' }) as HTMLSelectElement).disabled).toBe(true);
});

it('clamps an obsolete index to the available actual points', () => {
  render(<ObservationDock {...props({ index: 100 })} />);
  expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('2');
  expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('2026-11-15T13:03:17Z · UTC');
});

it('shows a single sample but disables transport without a second point', () => {
  render(<ObservationDock {...props({ series: { ...series, points: series.points.slice(0, 1) } })} />);
  expect(screen.getByRole('button', { name: /12:03:17 UTC/ })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Oynat' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
});
