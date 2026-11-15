import React, { useId, useState } from 'react';
import type { SkyBody, SkySeries, SkyVisibilityIntervals, VisibilityInterval } from '../../services/skyview';
import { useI18n, type Language } from '../../i18n';
import './VisibilityCard.css';

type Bracket = VisibilityInterval['start_bracket'];
type BodyIntervals = SkyVisibilityIntervals['sun'];

interface VisibilityCardProps {
  series: SkySeries | null;
  index: number;
  loading: boolean;
  onOpenMetrics: () => void;
  onSelectTime: (timeUtc: string) => void;
}

function utc(value: string) {
  return value.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
}

function hours(intervals: BodyIntervals | undefined, language: Language) {
  return intervals && Number.isFinite(intervals.total_visible_hours)
    ? `${intervals.total_visible_hours.toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 2 })} ${language === 'tr' ? 'sa' : 'h'}`
    : language === 'tr' ? 'veri yok' : 'no data';
}

function boundary(time: string, bracket: Bracket | null) {
  return bracket ? (Date.parse(bracket.after_utc) + Date.parse(bracket.by_utc)) / 2 : Date.parse(time);
}

function untilSet(value: number | null | undefined, language: Language) {
  if (value === null) return language === 'tr' ? 'aralıkta saptanmadı' : 'not detected in window';
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 2 })} ${language === 'tr' ? 'sa' : 'h'}`
    : language === 'tr' ? 'veri yok' : 'no data';
}

function BodyReadout({ name, kind, body, intervals, setHours, windowHours }: { name: string; kind: 'sun' | 'earth'; body: SkyBody; intervals?: BodyIntervals; setHours?: number | null; windowHours?: number }) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  const transition = body.next_transition;
  const pctValue = windowHours && windowHours > 0 && intervals && typeof intervals.total_visible_hours === 'number'
    ? Math.min(100, Math.max(0, (intervals.total_visible_hours / windowHours) * 100)).toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 1 })
    : '';
  const pct = pctValue ? (language === 'tr' ? ` (%${pctValue})` : ` (${pctValue}%)`) : '';
  return <section className={`sv-visibility-body sv-visibility-${kind}`} aria-label={text(`${name} görünürlüğü`, `${name} visibility`)}>
    <div className="sv-visibility-body-title">
      <span className="sv-visibility-name"><i aria-hidden="true" />{name}</span>
      <strong>{text('Seçili an:', 'Selected moment:')} {body.center_visible ? text('Görünür', 'Visible') : text('Arazi arkasında', 'Behind terrain')}</strong>
    </div>
    <div className="sv-visibility-values">
      <span>{text('Yükseklik', 'Elevation')} <b>{language === 'tr' ? body.elevation_deg.toFixed(2) : body.elevation_deg.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}°</b></span>
      <span>{text('Aralık toplamı', 'Window total')} <b>{hours(intervals, language)}</b>{pct ? <small style={{ opacity: 0.85, marginLeft: 4 }}>{pct}</small> : null}</span>
      <span>{text('Sonraki batışa kalan', 'Time until next set')} <b>{untilSet(setHours, language)}</b></span>
    </div>
    <p className="sv-visibility-next">{transition ? <>
      <span>{text(`Sonraki ${transition.becomes_visible ? 'görünme' : 'kaybolma'} aralığı · UTC`, `Next ${transition.becomes_visible ? 'appearance' : 'disappearance'} interval · UTC`)}</span>
      <time dateTime={transition.after_utc}>{utc(transition.after_utc)}</time>{' – '}<time dateTime={transition.by_utc}>{utc(transition.by_utc)}</time>
    </> : text('Sonraki geçiş bu aralıkta saptanmadı; aralık dışı bilinmiyor.', 'No next transition detected in this window; conditions outside it are unknown.')}</p>
  </section>;
}

function IntervalTrack({ name, kind, data, start, end, selectedTime, onSelectTime }: {
  name: string; kind: 'sun' | 'earth'; data: BodyIntervals; start: number; end: number;
  selectedTime: string; onSelectTime: (timeUtc: string) => void;
}) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  const duration = end - start;
  const percent = (time: number) => Math.max(0, Math.min(100, (time - start) / duration * 100));
  return <section className={`sv-visibility-track-section sv-visibility-${kind}`} aria-label={text(`${name} görünürlük zaman çizelgesi`, `${name} visibility timeline`)}>
    <div className="sv-visibility-track-title"><span>{name}</span><span>{data.intervals.length} {text('görünür aralık', data.intervals.length === 1 ? 'visible interval' : 'visible intervals')}</span></div>
    <div className="sv-visibility-track">
      {duration > 0 && data.intervals.map((interval, i) => {
        const left = percent(boundary(interval.start_utc, interval.start_bracket));
        const right = percent(boundary(interval.end_utc, interval.end_bracket));
        const label = `${name} ${text('görünür aralık', 'visible interval')} ${i + 1}: ${utc(interval.start_utc)} – ${utc(interval.end_utc)} UTC${interval.clipped_start ? text('; pencere başında kırpıldı', '; clipped at window start') : ''}${interval.clipped_end ? text('; pencere sonunda kırpıldı', '; clipped at window end') : ''}`;
        return <button key={`${interval.start_utc}-${i}`} type="button" className="sv-visibility-interval" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} aria-label={label} title={label} onClick={() => onSelectTime(interval.start_bracket?.by_utc || interval.start_utc)}><span /></button>;
      })}
      {duration > 0 && <i className="sv-visibility-cursor" aria-hidden="true" style={{ left: `${percent(Date.parse(selectedTime))}%` }} />}
    </div>
    {data.intervals.length === 0 ? <p>{text('Bu pencerede görünür aralık yok.', 'No visible intervals in this window.')}</p> : <ul className="sv-visibility-interval-list">{data.intervals.map((interval, i) => <li key={`${interval.start_utc}-${i}`}>
      <button type="button" onClick={() => onSelectTime(interval.start_bracket?.by_utc || interval.start_utc)}>
        <span>{utc(interval.start_utc)} → {utc(interval.end_utc)} UTC</span>
        {interval.start_bracket && <small>{text('Görünme parantezi:', 'Appearance bracket:')} {utc(interval.start_bracket.after_utc)} – {utc(interval.start_bracket.by_utc)} UTC</small>}
        {interval.end_bracket && <small>{text('Kaybolma parantezi:', 'Disappearance bracket:')} {utc(interval.end_bracket.after_utc)} – {utc(interval.end_bracket.by_utc)} UTC</small>}
        {(interval.clipped_start || interval.clipped_end) && <small>{[interval.clipped_start && text('Pencere başında kırpıldı', 'Clipped at window start'), interval.clipped_end && text('Pencere sonunda kırpıldı', 'Clipped at window end')].filter(Boolean).join(' · ')}</small>}
      </button>
    </li>)}</ul>}
  </section>;
}

export default function VisibilityCard({ series, index, loading, onOpenMetrics, onSelectTime }: VisibilityCardProps) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  const sunName = text('Güneş', 'Sun');
  const earthName = text('Dünya', 'Earth');
  const [expanded, setExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const id = useId();
  const rawIntervals = series?.visibility_intervals;
  const validBody = (data?: BodyIntervals) => data && Number.isFinite(data.total_visible_hours) && Array.isArray(data.intervals) ? data : undefined;
  const sunIntervals = validBody(rawIntervals?.sun);
  const earthIntervals = validBody(rawIntervals?.earth);
  const intervals = sunIntervals && earthIntervals ? rawIntervals : undefined;
  const point = !loading ? series?.points[index] : undefined;
  const coordText = (val: number) => Number.isInteger(val) ? String(val) : val.toFixed(4);
  return <aside className={`sv-visibility-card${mobileOpen ? ' is-mobile-open' : ''}`} aria-label={text('Güneş ve Dünya görünürlük saatleri', 'Sun and Earth visibility hours')} aria-busy={loading}>
    <button type="button" className="sv-visibility-mobile-toggle" aria-label={text('Güneş ve Dünya saatlerini aç', 'Open Sun and Earth hours')} aria-expanded={mobileOpen} aria-controls={`${id}-content`} onClick={() => setMobileOpen(value => !value)}><span className="sv-visibility-preview">{loading ? <b>{text('Görünürlük hesaplanıyor…', 'Calculating visibility…')}</b> : series && point ? <><b>{sunName} {hours(intervals?.sun, language)} · {earthName} {hours(intervals?.earth, language)}</b><small>{coordText(series.site.lat_deg)}°, {coordText(series.site.lon_deg)}° · UTC</small><small>{utc(series.start_utc)} – {utc(series.end_utc)}</small></> : <b>{text('Güneş / Dünya saatleri · veri yok', 'Sun / Earth hours · no data')}</b>}</span><span aria-hidden="true">{mobileOpen ? '−' : '+'}</span></button>
    <div id={`${id}-content`} className="sv-visibility-content">
    <h2 id={`${id}-title`}>{text('Güneş / Dünya görünürlük saatleri', 'Sun / Earth visibility hours')}</h2>
    {loading ? <p role="status" className="sv-visibility-empty">{text('Görünürlük hesaplanıyor…', 'Calculating visibility…')}</p> : !series || !point ? <p className="sv-visibility-empty">{text('Görünürlük verisi yok. Bir gözlem noktası ve zaman penceresi seçin.', 'No visibility data. Select an observation site and time window.')}</p> : <>
      <p className="sv-visibility-coordinates">
        <span>{coordText(series.site.lat_deg)}° {text('enlem', 'latitude')} · {coordText(series.site.lon_deg)}° {text('doğu boylamı', 'east longitude')}</span>
        {series.site.surface_elevation_m !== undefined && <span> · {text('Yüzey', 'Surface')} {series.site.surface_elevation_m.toFixed(1)} m</span>}
        {series.local_slope?.slope_deg !== undefined && series.local_slope?.slope_deg !== null && <span> · {text('Eğim', 'Slope')} {series.local_slope.slope_deg.toFixed(1)}°</span>}
      </p>
      <p className="sv-visibility-window"><span>{text('Hesaplanmış aralık · UTC', 'Calculated window · UTC')}</span><time dateTime={series.start_utc}>{utc(series.start_utc)}</time>{' → '}<time dateTime={series.end_utc}>{utc(series.end_utc)}</time></p>
      <p className="sv-visibility-selected">{text('Seçili an', 'Selected moment')} · {utc(point.time_utc)} UTC</p>
      <BodyReadout name={sunName} kind="sun" body={point.sun} intervals={intervals?.sun} setHours={point.hours_until_sunset} windowHours={(Date.parse(series.end_utc) - Date.parse(series.start_utc)) / 3600000} />
      <BodyReadout name={earthName} kind="earth" body={point.earth} intervals={intervals?.earth} setHours={point.hours_until_earthset} windowHours={(Date.parse(series.end_utc) - Date.parse(series.start_utc)) / 3600000} />
      <p className="sv-visibility-definition">{text('Cisim merkezi / yerel DEM ufku; Güneş saati enerji üretimi değildir. Batışa kalan süre ilk görünmez örneğe kadardır; kesin geçiş anı değildir. Aralıkta batış saptanmaması sürekli görünürlük anlamına gelmez.', 'Body center / local DEM horizon; Sun-visible hours are not energy generation. Time until set runs to the first invisible sample, not an exact transition time. No detected set in the window does not imply continuous visibility.')}</p>
      {!intervals && <p role="status" className="sv-visibility-unavailable">{text('Görünürlük aralıkları mevcut değil; toplam süre hesaplanmadı.', 'Visibility intervals unavailable; total duration was not calculated.')}</p>}
      <button type="button" className="sv-visibility-expand" aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>{text('Zaman çizelgeleri', 'Timelines')} <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
      {expanded && <div id={`${id}-details`} className="sv-visibility-details">
        {intervals ? <>
          <IntervalTrack name={sunName} kind="sun" data={intervals.sun} start={Date.parse(series.start_utc)} end={Date.parse(series.end_utc)} selectedTime={point.time_utc} onSelectTime={onSelectTime} />
          <IntervalTrack name={earthName} kind="earth" data={intervals.earth} start={Date.parse(series.start_utc)} end={Date.parse(series.end_utc)} selectedTime={point.time_utc} onSelectTime={onSelectTime} />
          <p>{text('Çizgiler geçiş parantezlerinin orta noktalarını kullanır; kesin geçiş anları değildir. Çözünürlük:', 'Tracks use transition-bracket midpoints, not exact transition times. Resolution:')} {intervals.resolution_seconds} {text('sn.', 's.')}</p>
        </> : <p>{text('Sunucu görünürlük aralıklarını sağlamadı. Örneklerden aralık türetilmez.', 'The server did not supply visibility intervals. Intervals are not derived from samples.')}</p>}
        <p>{text('Seçili noktanın bu penceredeki örneklenmiş cisim merkezi görünürlüğüdür; yıllık sıralama, tam disk aydınlanması veya tüm Ay ufku garantisi değildir.', 'This is sampled body-center visibility for the selected site and window, not an annual ranking or a guarantee of full-disk illumination or visibility across the entire lunar horizon.')}</p>
      </div>}
      <button type="button" className="sv-visibility-metrics" onClick={onOpenMetrics}>{text('Ölçümler ve sınırlar', 'Metrics and limitations')} <span aria-hidden="true">↗</span></button>
    </>}
    </div>
  </aside>;
}
