import React from 'react';
import type { SkySeries } from '../../services/skyview';
import { useI18n, type Language } from '../../i18n';
import './ObservationDock.css';

export interface ObservationDockProps {
  series: SkySeries | null;
  index: number;
  playing: boolean;
  loading: boolean;
  onIndexChange: (index: number) => void;
  onTogglePlay: () => void;
  onOpenSettings: () => void;
  playbackSpeed?: number;
  onPlaybackSpeedChange?: (speed: number) => void;
}

function formatUtc(value: string, language: Language): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return `${value} UTC`;
  return `${new Intl.DateTimeFormat(language === 'tr' ? 'tr-TR' : 'en-US', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date)} · ${date.toISOString().slice(11, 19)} UTC`;
}

function samplingLabel(seconds: number, language: Language): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ${language === 'tr' ? 'sa' : 'h'}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${language === 'tr' ? 'dk' : 'min'}`;
  return `${seconds} ${language === 'tr' ? 'sn' : 's'}`;
}

function DockIcon({ kind }: { kind: 'previous' | 'next' | 'play' | 'pause' | 'chevron' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {kind === 'previous' && <path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'next' && <path d="m10 6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'chevron' && <path d="m8 10 4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'play' && <path d="m9 5 11 7-11 7V5Z" fill="currentColor" />}
      {kind === 'pause' && <path d="M7 5h4v14H7zM14 5h4v14h-4z" fill="currentColor" />}
    </svg>
  );
}

/** A controlled, view-independent transport for actual API observation samples. */
export function ObservationDock({
  series, index, playing, loading, onIndexChange, onTogglePlay, onOpenSettings,
  playbackSpeed = 1, onPlaybackSpeedChange,
}: ObservationDockProps) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  // A pending request must not label a new observation with the previous response.
  const points = loading ? [] : series?.points ?? [];
  const lastIndex = Math.max(0, points.length - 1);
  const selectedIndex = Number.isFinite(index) ? Math.max(0, Math.min(lastIndex, Math.trunc(index))) : 0;
  const point = points[selectedIndex];
  const canScrub = points.length > 1;
  const dateLabel = point ? formatUtc(point.time_utc, language) : loading ? text('Hesaplanıyor', 'Calculating') : text('Tarih / saat seç', 'Select date / time');

  return (
    <section className="sv-observation-dock" aria-label={text('Gözlem zamanı', 'Observation time')} aria-busy={loading}>
      <button className="sv-observation-dock__date" type="button" onClick={onOpenSettings}
        aria-label={`${dateLabel} — ${text('Tarih ve saat ayarlarını aç', 'Open date and time settings')}`} aria-haspopup="dialog">
        <span className="sv-observation-dock__eyebrow">{text('Gözlem zamanı · UTC', 'Observation time · UTC')}</span>
        <span className="sv-observation-dock__date-value">{dateLabel}</span>
        <DockIcon kind="chevron" />
      </button>

      <div className="sv-observation-dock__transport" role="group" aria-label={text('Örnek oynatma', 'Sample playback')}>
        <button type="button" className="sv-observation-dock__icon" aria-label={text('Önceki örnek', 'Previous sample')}
          disabled={!canScrub || selectedIndex === 0} onClick={() => onIndexChange(selectedIndex - 1)}>
          <DockIcon kind="previous" />
        </button>
        <button type="button" className="sv-observation-dock__icon sv-observation-dock__play"
          aria-label={playing && canScrub ? text('Duraklat', 'Pause') : text('Oynat', 'Play')} disabled={!canScrub} onClick={onTogglePlay}>
          <DockIcon kind={playing && canScrub ? 'pause' : 'play'} />
        </button>
        <button type="button" className="sv-observation-dock__icon" aria-label={text('Sonraki örnek', 'Next sample')}
          disabled={!canScrub || selectedIndex === lastIndex} onClick={() => onIndexChange(selectedIndex + 1)}>
          <DockIcon kind="next" />
        </button>
        {onPlaybackSpeedChange && <label className="sv-observation-dock__speed">
          <span className="sv-observation-dock__speed-label">{text('Oynatma hızı', 'Playback speed')}</span>
          <select aria-label={text('Oynatma hızı', 'Playback speed')} value={playbackSpeed} disabled={!canScrub}
            onChange={event => onPlaybackSpeedChange(Number(event.target.value))}>
            {[0.5, 1, 2, 4].map(speed => <option key={speed} value={speed}>{speed}×</option>)}
          </select>
        </label>}
      </div>

      <div className="sv-observation-dock__timeline">
        <input type="range" aria-label={text('Gözlem örneği', 'Observation sample')} min={0} max={lastIndex} step={1}
          value={selectedIndex} disabled={!canScrub}
          aria-valuetext={point ? `${point.time_utc} · UTC` : loading ? text('Hesaplanıyor', 'Calculating') : text('Gözlem verisi yok', 'No observation data')}
          onChange={event => {
            if (canScrub) onIndexChange(Math.max(0, Math.min(lastIndex, Number(event.target.value))));
          }} />
        <span className="sv-observation-dock__sampling">
          {point && series ? `${text('Örnekleme', 'Sampling')} · ${samplingLabel(series.step_seconds, language)} · ${selectedIndex + 1}/${points.length}` : `${text('Örnekleme', 'Sampling')} · —`}
        </span>
      </div>
    </section>
  );
}

export default ObservationDock;
