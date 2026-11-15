import React, { useEffect, useId, useRef, useState } from 'react';
import { fetchSkySites, SkySite } from '../../services/skyview';
import { compareSites, LocalSlope, PlannerObservation, PlanningComparison, PlanningSeries, Scenario, searchSites, SearchResult, VisibilitySummary } from '../../services/skyviewPlanning';
import { inverseLunarSouth, projectLunarSouth } from './lunarLocation';
import CandidateDiscovery from './CandidateDiscovery';
import { useI18n } from '../../i18n';
import './ComparePlanner.css';

export type { PlannerObservation } from '../../services/skyviewPlanning';
export interface PlannerLocation { lat: number; lon: number; name: string; siteId?: string }
export interface ComparePlannerProps {
  /** A then B. Transferred only by the explicit button, never on rerender. */
  markedLocations?: readonly PlannerLocation[];
  initialLocations?: readonly PlannerLocation[];
  initialScenarioA?: PlannerObservation;
  initialScenarioB?: PlannerObservation;
  catalog?: SkySite[];
  selectedSiteId?: string;
  currentDateUtc?: string;
  initialDate?: string;
  onSelectResult?: (siteId: string, startUtc: string) => void;
  onSelectObservation?: (scenario: PlannerObservation) => void;
  onOpenGlobeToPick?: (target: 'A' | 'B') => void;
}
interface Draft { id: string; lat: string; lon: string; start: string; end: string }
function usePlannerText() {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  const number = (value: number) => value.toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: 2 });
  const errors: Record<string, string> = {
    'Geçerli bir UTC başlangıcı ve bitişi seçin.': 'Choose a valid UTC start and end.',
    'Bir nokta seçin veya koordinat girin.': 'Select a point or enter coordinates.',
    'Enlem −90…90 (90 hariç), boylam −180…180 arasında olmalı.': 'Latitude must be −90…90 (excluding 90), longitude −180…180.',
    'Her senaryonun bitişi kendi başlangıcından sonra olmalı.': 'Each scenario must end after its own start.',
    'Kürede geçerli nokta işaretleyin.': 'Mark a valid point on the globe.',
    'Örnek adımı 600–21600 arasında tamsayı olmalı.': 'Sample step must be an integer between 600 and 21600.',
    'Örnek bütçesi aşıldı. Aralıkları kısaltın veya örnek adımını büyütün (senaryo başına 2049, toplam en çok 8192).': 'Sample budget exceeded. Shorten the ranges or increase the sample step (2049 per scenario, 8192 total maximum).',
    'Arama aralığı pozitif ve en çok 90 gün olmalı.': 'Search range must be positive and no longer than 90 days.',
    'Pencere süresi 1–168 saat olmalı ve arama aralığına sığmalı.': 'Window duration must be 1–168 hours and fit within the search range.',
    'Başlangıçlar arası adım 1–168 saat arasında tamsayı olmalı.': 'Start cadence must be an integer between 1 and 168 hours.',
    'Koşulları kontrol edin: yüzdeler 0–100, görünürlük saatleri pencere süresini aşmamalı, eğim 0–90° olmalı.': 'Check conditions: percentages must be 0–100, visibility hours must not exceed window duration, and slope must be 0–90°.',
    'Arama 64 pencere veya 8192 örnek sınırını aşıyor. Aralığı kısaltın ya da başlangıç/örnek adımını büyütün.': 'Search exceeds the 64-window or 8192-sample limit. Shorten the range or increase the start/sample step.',
    'İşlem başarısız. Yeniden deneyin.': 'Operation failed. Please try again.',
    'Bilimsel veri kullanılamıyor: SPICE çekirdeklerini ve ölçülmüş hesaplama DEM dosyasını kontrol edin.': 'Scientific data is unavailable: check the SPICE kernels and measured computation DEM file.',
    'İstek veya ölçülmüş DEM kapsamı uygun değil. Tarih aralığını, örnek bütçesini ve koordinatları kontrol edin.': 'The request or measured DEM coverage is unsuitable. Check the date range, sample budget and coordinates.',
  };
  const errorText = (message: string) => language === 'tr' ? message : errors[message] ?? message.replace(/^Planlama isteği başarısız \(HTTP (\d+)\)\.$/, 'Planning request failed (HTTP $1).');
  return { text, number, errorText };
}
const utcInput = (value: string) => {
  try {
    return new Date(value).toISOString().slice(0, -1);
  } catch {
    return new Date().toISOString().slice(0, -1);
  }
};
const hoursBetween = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 3600000;
function toUtc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value)) throw new Error('Geçerli bir UTC başlangıcı ve bitişi seçin.');
  const date = new Date(`${value}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('Geçerli bir UTC başlangıcı ve bitişi seçin.');
  return date.toISOString();
}
function Metrics({ summary: s, slope }: { summary: VisibilitySummary; slope: LocalSlope }) {
  const { text, number } = usePlannerText();
  const percent = (value: number) => text(`%${number(value)}`, `${number(value)}%`);
  return <dl className="cp-metrics">
    <dt>{text('Gözlem süresi', 'Observation duration')}</dt><dd>{number(hoursBetween(s.start_utc, s.end_utc))} {text('saat', 'hours')}</dd>
    <dt>{text('Güneş merkezi görünür', 'Sun center visible')}</dt><dd>{number(s.total_sunlight_hours)} {text('saat', 'hours')} · {percent(s.sunlight_percentage)}</dd>
    <dt>{text('Dünya merkezi görünür', 'Earth center visible')}</dt><dd>{number(s.total_earth_visible_hours)} {text('saat', 'hours')} · {percent(s.earth_visible_percentage)}</dd>
    <dt>{text('Yerel eğim', 'Local slope')}</dt><dd>{slope.slope_deg === null ? text('Ölçülemiyor', 'Not measurable') : `${number(slope.slope_deg)}°`}</dd>
    {slope.grid_spacing_m !== undefined && <><dt>{text('DEM aralığı / komşuluk', 'DEM spacing / neighborhood')}</dt><dd>{number(slope.grid_spacing_m)} / {number(slope.neighborhood_projected_width_m!)} m · {text('9 örnek', '9 samples')}</dd><dt>{text('Düzlem uyum hatası', 'Plane-fit error')}</dt><dd>{number(slope.fit_rms_m!)} m</dd></>}
    {Object.entries(s.visibility_hour_bounds).map(([key, bounds]) => <React.Fragment key={key}><dt>{key === 'sunlight' ? text('Güneş', 'Sun') : text('Dünya', 'Earth')} {text('örnek zarfı', 'sample envelope')}</dt><dd>{number(bounds.lower_hours)}–{number(bounds.upper_hours)} {text('saat', 'hours')}</dd></React.Fragment>)}
  </dl>;
}
function Provenance({ series }: { series: PlanningSeries }) {
  const { text, number } = usePlannerText();
  return <details><summary>{text('Veri kaynağı ve kapsam', 'Data source and coverage')}</summary><p>{text('Çerçeve:', 'Frame:')} {series.frame}; {text('adım:', 'step:')} {text(String(series.step_seconds), number(series.step_seconds))} {text('saniye.', 'seconds.')} DEM: {text(String(series.horizon.provenance.spacing_m), number(series.horizon.provenance.spacing_m))} m. {text('Ufuk', 'Horizon')} {series.horizon.coverage.truncated ? text('DEM sınırında kesiliyor', 'truncated at the DEM boundary') : text('istenen yarıçap içinde örneklenmiş', 'sampled within the requested radius')}.</p><p>DEM SHA-256: <code>{series.horizon.provenance.sha256}</code></p>{series.provenance.kernels.map(k => <p key={k.file}>{text('Çekirdek:', 'Kernel:')} {k.file} · <code>{k.sha256}</code></p>)}</details>;
}
function point(draft: Draft): Scenario {
  if (draft.id !== 'custom') {
    if (!draft.id) throw new Error('Bir nokta seçin veya koordinat girin.');
    return { site_id: draft.id };
  }
  const lat = Number(draft.lat), lon = Number(draft.lon);
  if (!draft.lat.trim() || !draft.lon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat >= 90 || lon < -180 || lon > 180) throw new Error('Enlem −90…90 (90 hariç), boylam −180…180 arasında olmalı.');
  return { lat, lon };
}
function observation(draft: Draft, step: number): PlannerObservation {
  const start_utc = toUtc(draft.start), end_utc = toUtc(draft.end);
  if (Date.parse(end_utc) <= Date.parse(start_utc)) throw new Error('Her senaryonun bitişi kendi başlangıcından sonra olmalı.');
  return { ...point(draft), start_utc, end_utc, step_seconds: step };
}
function samples(start: string, end: string, step: number) { return Math.ceil((Date.parse(end) - Date.parse(start)) / (step * 1000)) + 1; }

// Stereographic polar map radius in meters for 60°S boundary (approx 931 km)
const POLAR_MAP_MAX_R_M = 2 * 1737400 * Math.tan((30 * Math.PI) / 360);

export default function ComparePlanner({ catalog, selectedSiteId, currentDateUtc, initialDate, markedLocations, initialLocations, initialScenarioA, initialScenarioB, onSelectResult, onSelectObservation, onOpenGlobeToPick }: ComparePlannerProps) {
  const { text, number, errorText } = usePlannerText();
  const marked = markedLocations ?? initialLocations ?? [];
  const base = useRef(initialScenarioA?.start_utc || currentDateUtc || initialDate || new Date().toISOString()).current;
  function initialDraft(scenario: PlannerObservation | undefined, index: number): Draft {
    return {
      id: scenario ? ('site_id' in scenario ? scenario.site_id : 'custom') : (index === 0 ? selectedSiteId || '' : ''),
      lat: scenario && 'lat' in scenario ? String(scenario.lat) : '',
      lon: scenario && 'lon' in scenario ? String(scenario.lon) : '',
      start: utcInput(scenario?.start_utc || base),
      end: utcInput(scenario?.end_utc || new Date(Date.parse(base) + 86400000).toISOString()),
    };
  }
  const [sites, setSites] = useState<SkySite[]>(catalog || []);
  const [drafts, setDrafts] = useState<[Draft, Draft]>(() => [initialDraft(initialScenarioA, 0), initialDraft(initialScenarioB, 1)]);
  const [rangeStart, setRangeStart] = useState(() => utcInput(base));
  const [rangeEnd, setRangeEnd] = useState(() => utcInput(new Date(Date.parse(base) + 7 * 86400000).toISOString()));
  const [duration, setDuration] = useState(24);
  const [cadence, setCadence] = useState(24);
  const [step, setStep] = useState(initialScenarioA?.step_seconds || 3600);
  const [sun, setSun] = useState(0), [earth, setEarth] = useState(0);
  const [sunHours, setSunHours] = useState(0), [earthHours, setEarthHours] = useState(0);
  const [slope, setSlope] = useState('');
  const [comparison, setComparison] = useState<PlanningComparison>();
  const [compared, setCompared] = useState<[PlannerObservation, PlannerObservation]>();
  const [search, setSearch] = useState<SearchResult>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [lastMode, setLastMode] = useState<'compare' | 'search'>('compare');
  const [workflow, setWorkflow] = useState<'discovery' | 'compare' | 'search'>('compare');
  const [mapTarget, setMapTarget] = useState<'A' | 'B'>('A');
  const [mapNotice, setMapNotice] = useState<[string, string] | null>(null);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [catalogError, setCatalogError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mapSvgRef = useRef<SVGSVGElement | null>(null);
  const mapSvgId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError(false);
    if (catalog) setSites(catalog);
    else fetchSkySites(controller.signal).then(rows => { if (!controller.signal.aborted) setSites(rows); }).catch(() => { if (!controller.signal.aborted) setCatalogError(true); });
    return () => controller.abort();
  }, [catalog, catalogRetry]);
  useEffect(() => () => active.current?.abort(), []);

  function invalidate() {
    active.current?.abort(); active.current = null;
    setBusy(false); setComparison(undefined); setCompared(undefined); setSearch(undefined); setError('');
  }
  function update(index: number, values: Partial<Draft>) {
    setDrafts(old => old.map((draft, i) => i === index ? { ...draft, ...values } : draft) as [Draft, Draft]);
  }
  function copyObservation(index: number) {
    if (!initialScenarioA) return;
    invalidate();
    update(index, initialDraft(initialScenarioA, index));
  }
  function useMarkedLocations() {
    if (marked.length === 0 || marked.some(p => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || p.lat < -90 || p.lat >= 90 || p.lon < -180 || p.lon > 180)) {
      setError('Kürede geçerli nokta işaretleyin.'); return;
    }
    invalidate();
    const longitude = (value: number) => ((value % 360) + 360) % 360;
    marked.slice(0, 2).forEach((location, i) => {
      const exact = (site: SkySite) => site.lat === location.lat && longitude(site.lon) === longitude(location.lon);
      const site = sites.find(s => s.id === location.siteId && exact(s)) ?? sites.find(exact);
      update(i, { id: site?.id || 'custom', lat: String(location.lat), lon: String(location.lon) });
    });
  }

  // Handle click on South Polar 2D interactive map
  function handlePolarMapClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!mapSvgRef.current) return;
    const rect = mapSvgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const radiusPx = rect.width / 2 - 12; // boundary margin
    const dx = clickX - centerX;
    const dy = clickY - centerY;
    const distPx = Math.hypot(dx, dy);

    if (distPx > radiusPx) return; // outside 60°S boundary

    const x_m = (dx / radiusPx) * POLAR_MAP_MAX_R_M;
    const y_m = (-dy / radiusPx) * POLAR_MAP_MAX_R_M; // SVG y points down
    const loc = inverseLunarSouth(x_m, y_m);

    invalidate();
    const targetIdx = mapTarget === 'A' ? 0 : 1;
    update(targetIdx, {
      id: 'custom',
      lat: loc.lat.toFixed(4),
      lon: loc.lon.toFixed(4),
    });
    setMapNotice([`${mapTarget} noktası haritadan seçildi: ${loc.lat.toFixed(4)}° enlem, ${loc.lon.toFixed(4)}° boylam`, `Point ${mapTarget} selected on the map: ${loc.lat.toFixed(4)}° latitude, ${loc.lon.toFixed(4)}° longitude`]);
  }

  // Compute SVG marker coordinate for a given draft
  function getDraftMapPosition(draft: Draft): { cx: number; cy: number } | null {
    let lat: number | null = null;
    let lon: number | null = null;
    if (draft.id && draft.id !== 'custom') {
      const site = sites.find(s => s.id === draft.id);
      if (site) { lat = site.lat; lon = site.lon; }
    } else if (draft.lat && draft.lon) {
      const pLat = Number(draft.lat), pLon = Number(draft.lon);
      if (Number.isFinite(pLat) && Number.isFinite(pLon)) { lat = pLat; lon = pLon; }
    }
    if (lat === null || lon === null || lat > -60 || lat < -90) return null;
    const proj = projectLunarSouth({ lat, lon });
    if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) return null;
    const radiusPx = 135;
    const cx = 150 + (proj.x / POLAR_MAP_MAX_R_M) * radiusPx;
    const cy = 150 - (proj.y / POLAR_MAP_MAX_R_M) * radiusPx;
    return { cx, cy };
  }

  async function run(mode: 'compare' | 'search') {
    invalidate(); setLastMode(mode);
    const controller = new AbortController(); active.current = controller;
    setBusy(true);
    try {
      if (!Number.isInteger(step) || step < 600 || step > 21600) throw new Error('Örnek adımı 600–21600 arasında tamsayı olmalı.');
      if (mode === 'compare') {
        const pair: [PlannerObservation, PlannerObservation] = [observation(drafts[0], step), observation(drafts[1], step)];
        const counts = pair.map(s => samples(s.start_utc, s.end_utc, step));
        if (counts.some(n => n > 2049) || counts[0] + counts[1] > 8192) throw new Error('Örnek bütçesi aşıldı. Aralıkları kısaltın veya örnek adımını büyütün (senaryo başına 2049, toplam en çok 8192).');
        const result = await compareSites(pair[0], pair[1], controller.signal);
        if (!controller.signal.aborted && active.current === controller) { setComparison(result); setCompared(pair); }
      } else {
        const identity = (location: Scenario) => {
          const site = 'site_id' in location ? sites.find(row => row.id === location.site_id) : undefined;
          const coordinate = 'lat' in location ? location : site;
          if (!coordinate) return JSON.stringify(location);
          const lon = Math.abs(coordinate.lat) === 90 ? 0 : coordinate.lon === 180 ? -180 : coordinate.lon;
          return `${coordinate.lat},${lon}`;
        };
        const validDrafts = drafts.filter(d => !!d.id);
        // If user has not chosen A or B, scan the top DEM catalog sites automatically without throwing an error!
        const targetScenarios: Scenario[] = validDrafts.length > 0
          ? validDrafts.map(point)
          : sites.filter(s => s.dem_covered !== false).slice(0, 10).map(s => ({ site_id: s.id }));

        const locations = targetScenarios.filter((location, index, rows) => rows.findIndex(row => identity(row) === identity(location)) === index);
        const start = toUtc(rangeStart), end = toUtc(rangeEnd), hours = hoursBetween(start, end);
        if (!(hours > 0 && hours <= 90 * 24)) throw new Error('Arama aralığı pozitif ve en çok 90 gün olmalı.');
        if (!(duration >= 1 && duration <= 168 && duration <= hours)) throw new Error('Pencere süresi 1–168 saat olmalı ve arama aralığına sığmalı.');
        if (!Number.isInteger(cadence) || cadence < 1 || cadence > 168) throw new Error('Başlangıçlar arası adım 1–168 saat arasında tamsayı olmalı.');
        if (![sun, earth].every(n => Number.isFinite(n) && n >= 0 && n <= 100) || ![sunHours, earthHours].every(n => Number.isFinite(n) && n >= 0 && n <= duration) || (slope !== '' && (!Number.isFinite(Number(slope)) || Number(slope) < 0 || Number(slope) > 90))) throw new Error('Koşulları kontrol edin: yüzdeler 0–100, görünürlük saatleri pencere süresini aşmamalı, eğim 0–90° olmalı.');
        const count = Math.floor((hours - duration) / cadence) + 1;
        if (count > 64 || count * locations.length * (Math.ceil(duration * 3600 / step) + 1) > 8192) throw new Error('Arama 64 pencere veya 8192 örnek sınırını aşıyor. Aralığı kısaltın ya da başlangıç/örnek adımını büyütün.');
        const result = await searchSites({ locations, start_utc: start, end_utc: end, duration_hours: duration, cadence_hours: cadence, step_seconds: step, min_sunlight_hours: sunHours, min_sunlight_fraction: sun / 100, min_earth_hours: earthHours, min_earth_fraction: earth / 100, max_slope_deg: slope === '' ? null : Number(slope), max_results: 10 }, controller.signal);
        if (!controller.signal.aborted && active.current === controller) setSearch(result);
      }
    } catch (e) { if (!controller.signal.aborted && active.current === controller) setError(e instanceof Error ? e.message : 'İşlem başarısız. Yeniden deneyin.'); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  function resultObservation(row: SearchResult['results'][number]): PlannerObservation {
    const id = row.site.site_id ?? row.site.id;
    const location: Scenario = id ? { site_id: id } : { lat: row.site.lat, lon: row.site.lon };
    return { ...location, start_utc: row.summary.start_utc, end_utc: row.summary.end_utc, step_seconds: row.step_seconds ?? step };
  }
  function apply(scenario: PlannerObservation) {
    if (onSelectObservation) onSelectObservation(scenario);
    else if ('site_id' in scenario) onSelectResult?.(scenario.site_id, scenario.start_utc);
  }
  function dateInput(label: string, value: string, change: (value: string) => void) {
    return <label>{label}<input type="datetime-local" step="any" value={value} onChange={e => change(e.target.value)} required /></label>;
  }
  function selector(index: number) {
    const draft = drafts[index], label = index === 0 ? 'A' : 'B';
    const selectedSite = sites.find(site => site.id === draft.id);
    return <fieldset className="cp-scenario"><legend><span className="cp-letter">{label}</span> {text('Senaryo', 'Scenario')} {label}</legend>
      <div className="cp-point-actions">
        <button type="button" aria-pressed={draft.id === 'custom'} onClick={() => { invalidate(); update(index, { id: 'custom' }); }}>{label}: {text('koordinat gir', 'enter coordinates')}</button>
        <button type="button" aria-pressed={mapTarget === label} onClick={() => { setMapTarget(label); setMapNotice([`Haritadan veya küreden ${label} noktası seçebilirsiniz.`, `Select point ${label} on the map or globe.`]); }}>{text(`📍 Haritada ${label}’yı İşaretle`, `📍 Mark ${label} on the Map`)}</button>
        {onOpenGlobeToPick && <button type="button" onClick={() => onOpenGlobeToPick(label)}>{text('🌐 3D Kürede Seç', '🌐 Select on 3D Globe')}</button>}
        {initialScenarioA && <button type="button" onClick={() => copyObservation(index)}>{text(`Açık gözlemi ${label}’ya kopyala`, `Copy open observation to ${label}`)}</button>}
      </div>
      <label>{text(`${label} noktası`, `Point ${label}`)}<select value={draft.id} onChange={e => update(index, { id: e.target.value })} required><option value="" disabled>{text('Nokta seçin (veya haritadan seçin)', 'Select a point (or choose on the map)')}</option><option value="custom">{text('Özel koordinat', 'Custom coordinates')}</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      {selectedSite && <p className="cp-coordinate">{String(selectedSite.lat)}° {text('enlem', 'latitude')} · {String(selectedSite.lon)}° {text('doğu boylamı', 'east longitude')}</p>}
      {!draft.id && <p className="cp-hint">{text('Aşağıdaki haritaya tıklayarak veya küreden seçerek de belirleyebilirsiniz.', 'You can also choose by clicking the map below or selecting on the globe.')}</p>}
      {draft.id === 'custom' && <div className="cp-grid">{(['lat', 'lon'] as const).map(axis => <label key={axis}>{label} {axis === 'lat' ? text('enlem (°)', 'latitude (°)') : text('doğu boylamı (°)', 'east longitude (°)')}<input type="number" step="any" min={axis === 'lat' ? -90 : -180} max={axis === 'lat' ? 89.999999 : 180} value={draft[axis]} onChange={e => update(index, { [axis]: e.target.value })} required /></label>)}</div>}
      <div hidden={workflow !== 'compare'}>{dateInput(text(`${label} başlangıç (UTC)`, `${label} start (UTC)`), draft.start, value => update(index, { start: value }))}
      {dateInput(text(`${label} bitiş (UTC)`, `${label} end (UTC)`), draft.end, value => update(index, { end: value }))}
      <p className="cp-hint">{Number.isFinite(hoursBetween(`${draft.start}Z`, `${draft.end}Z`)) && hoursBetween(`${draft.start}Z`, `${draft.end}Z`) > 0 ? text(`${number(hoursBetween(`${draft.start}Z`, `${draft.end}Z`))} saatlik bağımsız gözlem`, `${number(hoursBetween(`${draft.start}Z`, `${draft.end}Z`))}-hour independent observation`) : text('Bitiş, başlangıçtan sonra olmalı.', 'End must be after start.')}</p></div>
    </fieldset>;
  }
  function input(label: string, value: number, setter: (n: number) => void, min: number, max: number, inputStep = 'any') {
    return <label>{label}<input type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={inputStep} onChange={e => setter(e.target.value === '' ? NaN : Number(e.target.value))} required /></label>;
  }

  const posA = getDraftMapPosition(drafts[0]);
  const posB = getDraftMapPosition(drafts[1]);

  return <section className="compare-planner" aria-label={text('İki nokta ve zaman penceresi planlayıcısı', 'Two-point and time-window planner')}>
    <header className="cp-heading">
      <h2>{text('İki gözlemi karşılaştır & yer keşfi', 'Compare two observations & discover sites')}</h2>
      <p>{text('A ve B noktalarını bağımsız karşılaştırabilir, haritadan/küreden doğrudan nokta seçebilir veya kriterlerinizi vererek Ay yüzeyinde en uygun iniş noktalarını otomatik keşfedebilirsiniz.', 'Compare points A and B independently, select points directly on the map/globe, or automatically discover suitable lunar landing sites using your criteria.')}</p>
    </header>
    {catalogError && <p role="alert">{text('Katalog alınamadı. API bağlantısını kontrol edin.', 'Could not load the catalog. Check the API connection.')} <button type="button" onClick={() => setCatalogRetry(n => n + 1)}>{text('Kataloğu yeniden yükle', 'Reload catalog')}</button></p>}
    {marked.length > 0 && <aside className="cp-transfer"><p>{text('Küre işaretleri:', 'Globe markers:')} {marked.slice(0, 2).map((p, i) => `${i === 0 ? 'A' : 'B'}: ${p.name} (${number(p.lat)}°, ${number(p.lon)}°)`).join(' · ')}</p><button type="button" onClick={useMarkedLocations}>{text('İşaretli noktaları kullan', 'Use marked points')}</button><p className="cp-hint">{text('Yalnız noktalar aktarılır; bağımsız tarih aralıklarınız korunur.', 'Only points are transferred; your independent date ranges are preserved.')}</p></aside>}
    <nav className="cp-workflows" aria-label={text('Planlama işlemi', 'Planning workflow')}>
      <button type="button" aria-pressed={workflow === 'discovery'} onClick={() => setWorkflow('discovery')}>{text('🌟 Kriterlerle Yer Keşfet (Özellik Ver, Yer Bul)', '🌟 Discover Sites by Criteria (Set Criteria, Find Sites)')}</button>
      <button type="button" aria-pressed={workflow === 'compare'} onClick={() => setWorkflow('compare')}>{text('1 · A / B karşılaştır', '1 · Compare A / B')}</button>
      <button type="button" aria-pressed={workflow === 'search'} onClick={() => setWorkflow('search')}>{text('2 · Koşullara göre pencere ara', '2 · Search windows by conditions')}</button>
    </nav>

    {workflow === 'discovery' && (
      <CandidateDiscovery
        initialDateUtc={base}
        onSelectObservation={apply}
        onApplyToA={(cand, win) => {
          invalidate();
          update(0, {
            id: 'custom',
            lat: String(cand.lat),
            lon: String(cand.lon),
            start: utcInput(win.start_utc),
            end: utcInput(win.end_utc),
          });
          setWorkflow('compare');
        }}
        onApplyToB={(cand, win) => {
          invalidate();
          update(1, {
            id: 'custom',
            lat: String(cand.lat),
            lon: String(cand.lon),
            start: utcInput(win.start_utc),
            end: utcInput(win.end_utc),
          });
          setWorkflow('compare');
        }}
        onComparePair={(candA, candB) => {
          invalidate();
          const winA = candA.windows[0];
          const winB = candB.windows[0];
          setDrafts([
            {
              id: 'custom',
              lat: String(candA.lat),
              lon: String(candA.lon),
              start: utcInput(winA.start_utc),
              end: utcInput(winA.end_utc),
            },
            {
              id: 'custom',
              lat: String(candB.lat),
              lon: String(candB.lon),
              start: utcInput(winB.start_utc),
              end: utcInput(winB.end_utc),
            },
          ]);
          setWorkflow('compare');
        }}
      />
    )}

    {/* Interactive 2D South Polar Map Picker for A / B comparison */}
    {workflow === 'compare' && (
      <div className="cp-map-picker-panel">
        <div className="cp-map-picker-header">
          <div>
            <strong>{text('🗺️ Ay Güney Kutbu Etkileşimli Harita Seçimi', '🗺️ Interactive Lunar South Pole Map Selection')}</strong>
            <p className="cp-hint">{text('Aşağıdaki haritaya tıklayarak', 'Click the map below to assign coordinates to')} <strong>{text(`${mapTarget} Noktası`, `Point ${mapTarget}`)}</strong> {text('için anında koordinat atayabilirsiniz. (60°S – 90°S LOLA DEM kapsama alanı)', 'instantly. (60°S – 90°S LOLA DEM coverage)')}</p>
          </div>
          <div className="cp-map-target-toggle">
            <button type="button" className={mapTarget === 'A' ? 'is-active' : ''} onClick={() => setMapTarget('A')}>{text('🔵 A Noktası İçin Tıkla', '🔵 Click for Point A')}</button>
            <button type="button" className={mapTarget === 'B' ? 'is-active' : ''} onClick={() => setMapTarget('B')}>{text('🟣 B Noktası İçin Tıkla', '🟣 Click for Point B')}</button>
            {onOpenGlobeToPick && <button type="button" className="cp-map-globe-btn" onClick={() => onOpenGlobeToPick(mapTarget)}>{text('🌐 3D Kürede Seç ↗', '🌐 Select on 3D Globe ↗')}</button>}
          </div>
        </div>
        {mapNotice && <p className="cp-map-notice" role="status">{text(...mapNotice)}</p>}
        <div className="cp-polar-svg-wrap">
          <svg
            ref={mapSvgRef}
            className="cp-polar-svg"
            viewBox="0 0 300 300"
            onClick={handlePolarMapClick}
            aria-label={text('Ay güney kutbu haritası: tıklayarak A veya B noktası belirleyin', 'Lunar south pole map: click to select point A or B')}
          >
            <defs>
              <radialGradient id={`polar-space-grad-${mapSvgId}`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#0d1b2a" />
                <stop offset="70%" stopColor="#070c14" />
                <stop offset="100%" stopColor="#020408" />
              </radialGradient>
            </defs>
            {/* Base lunar space disc */}
            <circle cx="150" cy="150" r="138" fill={`url(#polar-space-grad-${mapSvgId})`} stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
            
            {/* Latitude rings: 85°S, 80°S, 75°S, 70°S, 65°S */}
            {[
              { deg: '85°S', r: 23 },
              { deg: '80°S', r: 46 },
              { deg: '75°S', r: 69 },
              { deg: '70°S', r: 92 },
              { deg: '65°S', r: 115 },
              { deg: '60°S', r: 138 },
            ].map(ring => (
              <g key={ring.deg}>
                <circle cx="150" cy="150" r={ring.r} fill="none" stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                <text x="152" y={150 - ring.r + 9} fill="rgba(255,255,255,0.35)" fontSize="8" fontFamily="monospace">{ring.deg}</text>
              </g>
            ))}

            {/* Meridian axes */}
            <line x1="150" y1="12" x2="150" y2="288" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
            <line x1="12" y1="150" x2="288" y2="150" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
            <text x="154" y="24" fill="rgba(255,255,255,0.4)" fontSize="9">0° (Prime)</text>
            <text x="245" y="146" fill="rgba(255,255,255,0.4)" fontSize="9">90°E</text>
            <text x="154" y="282" fill="rgba(255,255,255,0.4)" fontSize="9">180°</text>
            <text x="18" y="146" fill="rgba(255,255,255,0.4)" fontSize="9">270°E</text>

            {/* Catalog sites */}
            {sites.map(site => {
              const proj = projectLunarSouth({ lat: site.lat, lon: site.lon });
              if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) return null;
              const cx = 150 + (proj.x / POLAR_MAP_MAX_R_M) * 135;
              const cy = 150 - (proj.y / POLAR_MAP_MAX_R_M) * 135;
              return (
                <circle
                  key={site.id}
                  cx={cx}
                  cy={cy}
                  r="3.5"
                  fill="#70a0ff"
                  opacity="0.8"
                  className="cp-catalog-pin"
                  onClick={e => {
                    e.stopPropagation();
                    const targetIdx = mapTarget === 'A' ? 0 : 1;
                    update(targetIdx, { id: site.id });
                    setMapNotice([`${mapTarget} noktası katalogdan seçildi: ${site.name}`, `Point ${mapTarget} selected from catalog: ${site.name}`]);
                  }}
                >
                  <title>{site.name} ({site.lat.toFixed(2)}°, {site.lon.toFixed(2)}°)</title>
                </circle>
              );
            })}

            {/* Pin A Marker */}
            {posA && (
              <g className="cp-marker-a">
                <circle cx={posA.cx} cy={posA.cy} r="10" fill="none" stroke="#00f0ff" strokeWidth="2" opacity="0.6" />
                <circle cx={posA.cx} cy={posA.cy} r="6" fill="#00f0ff" />
                <text x={posA.cx} y={posA.cy + 3.5} textAnchor="middle" fill="#000" fontSize="9" fontWeight="bold">A</text>
              </g>
            )}

            {/* Pin B Marker */}
            {posB && (
              <g className="cp-marker-b">
                <circle cx={posB.cx} cy={posB.cy} r="10" fill="none" stroke="#d946ef" strokeWidth="2" opacity="0.6" />
                <circle cx={posB.cx} cy={posB.cy} r="6" fill="#d946ef" />
                <text x={posB.cx} y={posB.cy + 3.5} textAnchor="middle" fill="#fff" fontSize="9" fontWeight="bold">B</text>
              </g>
            )}
          </svg>
        </div>
      </div>
    )}

    <form hidden={workflow !== 'compare'} onChange={invalidate} onSubmit={e => { e.preventDefault(); void run('compare'); }}>
      <div className="cp-grid cp-pair">{selector(0)}{selector(1)}</div>
      <div className="cp-actions">{input(text('Örnek adımı (saniye)', 'Sample step (seconds)'), step, setStep, 600, 21600, '1')}<button hidden={workflow !== 'compare'} className="cp-primary" disabled={busy || !drafts[0].id || !drafts[1].id} type="submit">{text('A / B karşılaştır', 'Compare A / B')}</button></div>
    </form>
    <form className="cp-search" hidden={workflow !== 'search'} onChange={invalidate} onSubmit={e => { e.preventDefault(); void run('search'); }}>
      <h3>{text('Koşullarıma uygun zaman pencerelerini bul', 'Find time windows matching my conditions')}</h3>
      <div className="cp-search-notice-banner">
        <strong>{text('💡 Yer Bağımsız Arama:', '💡 Location-independent Search:')}</strong>
        <p>{text('A ve B noktası seçmek zorunda değilsiniz. Doğrudan kriterlerinizi belirterek arama yapabilirsiniz; sistem tüm iniş bölgelerini otomatik tarar. Ayrıca tüm Ay yüzeyinde koordinat bulmak için yukarıdaki', 'You do not have to select points A and B. Search directly with your criteria; the system automatically scans all landing regions. To find coordinates across the lunar surface, use the')} <strong>{text('“🌟 Kriterlerle Yer Keşfet”', '“🌟 Discover Sites by Criteria”')}</strong> {text('sekmesini kullanabilirsiniz.', 'tab above.')}</p>
      </div>
      <fieldset><legend>{text('Arama aralığı ve pencere', 'Search range and window')}</legend><div className="cp-grid">
        {dateInput(text('Arama başlangıcı (UTC)', 'Search start (UTC)'), rangeStart, setRangeStart)}{dateInput(text('Arama bitişi (UTC)', 'Search end (UTC)'), rangeEnd, setRangeEnd)}
        {input(text('Pencere süresi (saat)', 'Window duration (hours)'), duration, setDuration, 1, 168)}{input(text('Başlangıçlar arası (saat)', 'Start cadence (hours)'), cadence, setCadence, 1, 168, '1')}
      </div></fieldset>
      <fieldset><legend>{text('Her pencerenin sağlaması gereken koşullar', 'Conditions each window must satisfy')}</legend><div className="cp-grid">
        {input(text('En az Güneş görünürlüğü (%)', 'Minimum Sun visibility (%)'), sun, setSun, 0, 100)}{input(text('En az Güneş görünürlüğü (saat)', 'Minimum Sun visibility (hours)'), sunHours, setSunHours, 0, duration)}
        {input(text('En az Dünya görünürlüğü (%)', 'Minimum Earth visibility (%)'), earth, setEarth, 0, 100)}{input(text('En az Dünya görünürlüğü (saat)', 'Minimum Earth visibility (hours)'), earthHours, setEarthHours, 0, duration)}
        <label>{text('En yüksek eğim (°, isteğe bağlı)', 'Maximum slope (°, optional)')}<input type="number" min="0" max="90" step="any" value={slope} placeholder={text('Sınır yok', 'No limit')} onChange={e => setSlope(e.target.value)} /></label>
      </div><p className="cp-hint">{text('Saat ve yüzde koşulları birlikte uygulanır. Arama, yukarıdaki örnek adımını kullanır.', 'Hour and percentage conditions apply together. Search uses the sample step above.')}</p></fieldset>
      <button className="cp-primary" type="submit" disabled={busy}>{text('Uygun nokta ve tarihleri bul', 'Find matching points and dates')}</button>
      <p className="cp-hint">{text('En çok 90 gün · 64 başlangıç penceresi · 8192 nokta-zaman örneği. İlk 10 eşleşme UTC sırasıyla gösterilir; küresel optimum değildir.', 'Up to 90 days · 64 start windows · 8192 point-time samples. The first 10 matches are shown in UTC order; this is not a global optimum.')}</p>
    </form>
    {busy && <p role="status">{text('Gerçek SPICE ve DEM hesaplanıyor…', 'Computing real SPICE and DEM data…')} <button type="button" onClick={invalidate}>{text('İsteği iptal et', 'Cancel request')}</button></p>}
    {error && <div role="alert"><p>{errorText(error)}</p><button type="button" onClick={() => void run(lastMode)}>{text('Yeniden dene', 'Retry')}</button></div>}
    {comparison && compared && <section aria-label={text('Karşılaştırma sonuçları', 'Comparison results')} aria-live="polite"><h3>{text('A / B karşılaştırma sonuçları', 'A / B comparison results')}</h3><p>{text('Her sütun kendi tam UTC aralığına aittir. Süreler farklıysa saatleri değil yüzdeleri de karşılaştırın; bunlar güvenlik puanı değildir.', 'Each column covers its own full UTC range. If durations differ, compare percentages as well as hours; these are not safety scores.')}</p><div className="cp-grid cp-pair">{([comparison.scenarioA, comparison.scenarioB]).map((series, index) => <article key={index} className="cp-result"><h4>{text('Senaryo', 'Scenario')} {index === 0 ? 'A' : 'B'}</h4><p>{String(series.site.lat_deg)}°, {String(series.site.lon_deg)}° · {text('yüzey', 'surface')} {number(series.site.surface_elevation_m)} m</p><p className="cp-window"><time>{series.start_utc}</time><span>→</span><time>{series.end_utc}</time></p><Metrics summary={series.planning_summary} slope={series.local_slope} /><Provenance series={series} />{(onSelectObservation || (onSelectResult && 'site_id' in compared[index])) && <button type="button" onClick={() => apply(compared[index])}>{text(`${index === 0 ? 'A' : 'B'} gözlemini aç`, `Open observation ${index === 0 ? 'A' : 'B'}`)}</button>}</article>)}</div></section>}
    {search && <section aria-label={text('Arama sonuçları', 'Search results')} aria-live="polite"><h3>{text('Arama sonuçları', 'Search results')}</h3><p>{text(`${search.metadata.evaluated_windows} nokta-pencere değerlendirildi; ${search.metadata.matched_windows} eşleşme. ${search.results.length} sonuç gösteriliyor.`, `${number(search.metadata.evaluated_windows)} point-windows evaluated; ${number(search.metadata.matched_windows)} matches. Showing ${number(search.results.length)} results.`)}</p>{search.metadata.rejected_sites.map(row => <p key={row.site_id ?? `custom-${row.location_index}`} className="cp-notice">{row.name || sites.find(s => s.id === row.site_id)?.name || (row.lat !== undefined && row.lon !== undefined ? `${number(row.lat)}°, ${number(row.lon)}°` : text('Seçili nokta', 'Selected point'))}: {text('ölçülmüş DEM veya eğim komşuluğu desteklenmiyor; taranmadı.', 'measured DEM or slope neighborhood is unsupported; not scanned.')}</p>)}{search.results.length === 0 && <p>{text('Bu örnekli koşullara uyan pencere bulunamadı. Koşulları azaltabilir veya aralığı değiştirebilirsiniz.', 'No windows match these sampled conditions. Relax the conditions or change the range.')}</p>}<div className="cp-search-results">{search.results.map(row => <article className="cp-result" key={`${row.site.site_id ?? row.site.id ?? `${row.site.lat},${row.site.lon}`}-${row.summary.start_utc}`}><h4>{row.site.name}</h4><p className="cp-window"><time>{row.summary.start_utc}</time><span>→</span><time>{row.summary.end_utc}</time></p><Metrics summary={row.summary} slope={row.local_slope} /><details><summary>{text('Kaynak ve kapsam', 'Source and coverage')}</summary><p>DEM SHA-256: <code>{row.dem_provenance.sha256}</code> · {row.dem_provenance.spacing_m} m; {text('ufuk', 'horizon')} {row.horizon_coverage.truncated ? text('sınırda kesiliyor', 'truncated at the boundary') : text('istenen yarıçap içinde örneklenmiş', 'sampled within the requested radius')}.</p>{row.summary.provenance.kernels.map(k => <p key={k.file}>{text('Çekirdek:', 'Kernel:')} {k.file} · <code>{k.sha256}</code></p>)}</details>{(onSelectObservation || (onSelectResult && (row.site.site_id ?? row.site.id))) && <button type="button" onClick={() => apply(resultObservation(row))}>{text('Bu pencereyi aç', 'Open this window')}</button>}</article>)}</div></section>}
    <details className="cp-limits"><summary>{text('Hesabın anlamı ve bilimsel sınırlar', 'Interpretation and scientific limitations')}</summary><p>{text('Güneş/Dünya merkezinin ölçülmüş DEM ufku üzerindeki görünürlüğü hesaplanır; enerji, disk aydınlanması, iletişim veya iniş güvenliği garantisi değildir. Saatler gerçek örnek aralıklarının trapez integrasyonudur; değişen uç durumlarda geçiş orta noktada varsayılır. Örnek zarfı fiziksel güven aralığı değildir; örnekler arasında görünmeyen geçişler olabilir. Eğim 3×3 DEM komşuluğuna düzlem uyumudur; küçük engelleri göstermez. İptal, tarayıcı isteğini durdurur; sunucuda başlamış hesap tamamlanabilir.', 'Visibility of the Sun/Earth center above the measured DEM horizon is calculated; this does not guarantee energy, disk illumination, communications, or landing safety. Hours use trapezoidal integration over actual sample intervals; when endpoint states differ, the transition is assumed at the midpoint. The sample envelope is not a physical confidence interval; unseen transitions may occur between samples. Slope is a plane fit to a 3×3 DEM neighborhood; it does not show small obstacles. Canceling stops the browser request; computation already started on the server may finish.')}</p></details>
  </section>;
}
