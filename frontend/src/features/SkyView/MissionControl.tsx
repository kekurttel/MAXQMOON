import GitHubLink from './GitHubLink';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchSkySites, fetchSkySeries, fetchCustomSkySeries, SkySite, SkySeries, SkyBody } from '../../services/skyview';
import SkyViewGraph from './SkyViewGraph';
import type { LunarLocation } from './lunarLocation';
import { observationForLocation, observationFromPlanner, observationStartUtc, observationWindow } from './observationSelection';
import ObservationDock from './ObservationDock';
import VisibilityCard from './VisibilityCard';
import type { PlannerObservation } from '../../services/skyviewPlanning';
import type { ObservationRequest } from './observationSelection';
import ComparePlanner from './ComparePlanner';
import './SkyView.css';
import { useI18n } from '../../i18n';

const CompassView = lazy(() => import('./CompassView'));
const SystemView = lazy(() => import('./SystemView'));

// Keep source messages stable in state so changing language never restarts a request.
const messages: Record<string, string> = {
  'Gökyüzü hesaplanıyor': 'Calculating sky positions',
  'Gerçek SPICE konumları ve ölçülmüş DEM ufku hazırlanıyor.': 'Preparing real SPICE positions and the measured DEM horizon.',
  'SPICE / LOLA · canlı hesap': 'SPICE / LOLA · live calculation',
  'Animasyon dekoratiftir; hesap ilerleme yüzdesi değildir.': 'The animation is decorative; it does not indicate calculation progress.',
  'Görünür': 'Visible', 'Arazi arkasında': 'Behind terrain', 'Yükselim': 'Elevation', 'Azimut': 'Azimuth', 'Arazi ufku': 'Terrain horizon', 'Ufuktan fark': 'Horizon clearance',
  'Sonraki görünme': 'Next appearance', 'Sonraki örtülme': 'Next disappearance', 'Sonraki geçiş': 'Next transition',
  'Seçili zaman aralığında bulunmadı.': 'Not found in the selected time range.',
  'Örnekler arasındaki aralık; kesin olay saati değil.': 'Interval between samples; not an exact event time.',
  'Gözlem noktaları': 'Observation sites', 'Anlık metrikler': 'Instantaneous metrics', 'Gözlem zamanı': 'Observation time', 'Veri ve hesap sınırları': 'Data and calculation limits', 'Karşılaştır ve planla': 'Compare and plan',
  'MAXQMOON / Gözlem konsolu': 'MAXQMOON / Observation console', 'Pencereyi kapat': 'Close dialog',
  'Nokta listesi alınamadı.': 'Could not load the site list.', 'UTC aralığı geçersiz.': 'Invalid UTC range.', 'Gökyüzü hesabı alınamadı.': 'Could not load the sky calculation.',
  'Gökyüzü API hatası:': 'Sky API error:',
  'Enlem −90° ile +90°, boylam −180° ile +180° arasında olmalı.': 'Latitude must be between −90° and +90°, longitude between −180° and +180°.',
  'Önce bir gözlem noktası seçin.': 'Select an observation site first.', 'Plan açılamadı.': 'Could not open the plan.',
  'Geçerli UTC başlangıç zamanı seçin.': 'Select a valid UTC start time.',
  'Geçerli UTC başlangıç ve bitiş zamanı seçin.': 'Select valid UTC start and end times.',
  'En çok 2049 örnek hesaplanabilir. Aralığı kısaltın veya örnek adımını büyütün.': 'At most 2049 samples can be calculated. Shorten the range or increase the sampling interval.',
  'Planlayıcı UTC aralığı geçersiz.': 'Invalid planner UTC range.', 'Planlayıcı koordinatı geçersiz.': 'Invalid planner coordinates.',
  'Seçilen nokta': 'Selected site', 'Özel Koordinat': 'Custom Coordinates',
  'Hesaplanıyor': 'Calculating', 'Veri hatası': 'Data error', 'Gerçek veri': 'Real data', 'Bağlanıyor': 'Connecting',
  'MAXQMOON ana sayfa': 'MAXQMOON home page', 'Yüzey gözlem konsolu': 'Surface observation console', 'Gökyüzü gözlemi': 'Sky observation',
  'Ay’ın güney kutbu / ': 'Lunar south pole / ', '2D gözlem': '2D observation', 'Yüzey panoraması': 'Surface panorama', 'Gökyüzü': 'Sky', 'Pusula': 'Compass',
  'Gözlem görünümü': 'Observation view', '2D Gökyüzü': '2D Sky', '3D Pusula': '3D Compass',
  '3D yüzey motoru yükleniyor…': 'Loading the 3D surface engine…', 'Tam ekran 3D görünüm açık.': 'Full-screen 3D view is open.',
  'Gözlem verisi alınamadı': 'Could not load observation data', 'Ufka bağlanılıyor': 'Connecting to the horizon',
  'Gerçek SPICE konumları ve DEM ufuk profili hazırlanıyor.': 'Preparing real SPICE positions and the DEM horizon profile.',
  'Gözlem noktaları yükleniyor.': 'Loading observation sites.', 'Tekrar dene': 'Retry',
  'Eksik veride yapay ufuk veya örnek sonuç gösterilmez.': 'No artificial horizon or sample results are shown when data is missing.',
  'Etkin gözlem bağlamı': 'Active observation context', 'Ölçülmüş arazi ufku · cisim merkezleri': 'Measured terrain horizon · body centers',
  'Gözlem araçları': 'Observation tools', 'Gözlem noktası': 'Observation site', 'Nokta seçin': 'Select a site', 'Katalog ve özel koordinat': 'Catalog and custom coordinates',
  'Nokta seç': 'Select site', 'Zaman aralığı': 'Time range', 'Koşullar / A·B (İki noktayı karşılaştır)': 'Conditions / A·B (Compare two sites)', 'Veri kaynağı ve hesap sınırları': 'Data source and calculation limits',
  'Tam ekran üç boyutlu gözlem': 'Full-screen three-dimensional observation', '3D görünüm': '3D view', 'Yüzey / Arazi': 'Surface / Terrain', 'Ay küresi / Sistem': 'Lunar sphere / System', 'Araçlar': 'Tools',
  '⌖ Nokta seç': '⌖ Select site', '◷ Tarih / saat': '◷ Date / time', 'A/B karşılaştır · Gelecek ara ↗': 'Compare A/B · Search future windows ↗',
  'Açık tema': 'Light theme', 'Koyu tema': 'Dark theme', '3D görünümü kapat': 'Close 3D view',
  'Ay küresi hazırlanıyor': 'Preparing the lunar sphere', 'Ölçülmüş alan ve nokta seçim araçları yükleniyor.': 'Loading measured coverage and site selection tools.', 'Yüzey motoru hazırlanıyor': 'Preparing the surface engine',
  'Bu gözlem hesaplanamadı': 'This observation could not be calculated', 'Bir gözlem noktası seçin': 'Select an observation site',
  'Ölçülmüş güney kutbu alanından bir nokta ve UTC aralığı seçin.': 'Select a site within the measured south polar area and a UTC range.',
  'Eksik veride arazi veya görünürlük üretilmez. Küreye dönüp geçerli başka bir nokta seçebilirsiniz.': 'Terrain or visibility is not generated when data is missing. Return to the sphere to select another valid site.',
  'Ay küresinden yeniden seç ↗': 'Select again on the lunar sphere ↗', 'Zaman aralığını değiştir': 'Change time range', '3D gözlem bağlamı': '3D observation context',
  'Ay küresinden nokta seç ↗': 'Select a site on the lunar sphere ↗', '⚖ İki noktayı karşılaştır (A / B) ↗': '⚖ Compare two sites (A / B) ↗',
  'Kürede bir nokta seçin; koordinatı kontrol edip “Bu noktayı gözle” ile onaylayın.': 'Select a site on the sphere; check its coordinates and confirm with “Observe this site”.',
  'Katalog': 'Catalog', 'Özel koordinat': 'Custom coordinates',
  'Koordinatı olduğu gibi gözlemleyin. Arazi verisi yalnız güney kutbundaki sınırlı alanlarda mevcut.': 'Observe the exact coordinates. Terrain data is only available in limited south polar areas.',
  'Enlem': 'Latitude', 'Boylam': 'Longitude', ' gün. Kapsam dışı koordinatlar hesaplanmaz.': ' days. Coordinates outside coverage are not calculated.',
  'Bu noktayı gözle': 'Observe this site', 'Gözlem noktası ara': 'Search observation sites', 'İsim veya kimlik ile ara…': 'Search by name or ID…',
  'Tekrar bağlan': 'Reconnect', 'Noktalar yükleniyor…': 'Loading sites…', ' · DEM kapsamı dışı': ' · Outside DEM coverage', 'Aramanızla eşleşen nokta yok.': 'No sites match your search.',
  'UTC başlangıç ve bitişini seçin. Nokta ve zaman aynı hesapta kullanılır; koşullu pencere araması için A/B planlayıcıya geçin.': 'Select UTC start and end times. Site and time are used in the same calculation; use the A/B planner to search for windows matching conditions.',
  'Başlangıç · UTC': 'Start · UTC', 'Saat · UTC': 'Time · UTC', 'Hızlı süre': 'Quick duration', 'Özel bitiş zamanı': 'Custom end time', '24 saat': '24 hours', '3 gün': '3 days', '7 gün': '7 days', '14 gün': '14 days',
  'Bitiş · UTC (isteğe bağlı)': 'End · UTC (optional)', 'Örnek adımı': 'Sampling interval', ' dakika': ' minutes', 'Konum: ': 'Location: ', 'Henüz seçilmedi': 'Not yet selected',
  ' · en çok 2049 örnek. Bitiş boşsa hızlı süre uygulanır.': ' · at most 2049 samples. Quick duration applies if no end time is set.',
  'Gözlemi hesapla ↗': 'Calculate observation ↗', 'Koşullarıma uygun pencere ara / A·B': 'Find a window matching my conditions / A·B',
  'UTC / hesaplanan örnek': 'UTC / calculated sample', 'Güneş': 'Sun', 'Dünya': 'Earth', 'Arazi ve eğim ölçümleri': 'Terrain and slope measurements',
  'Arazi ve Yerel Eğim': 'Terrain and Local Slope', 'Yüzey Yüksekliği': 'Surface Elevation', 'Yerel Eğim': 'Local Slope', 'Ölçülemiyor': 'Unavailable', 'Düzlem Uyum RMS': 'Plane Fit RMS', 'DEM Çözünürlüğü': 'DEM Resolution',
  'Pencere güneşlenme ve aydınlanma': 'Window sunlight and illumination', 'Güneşlenme / Aydınlanma': 'Sunlight / Illumination', 'Toplam Güneş Saati': 'Total Sun-visible Hours', ' sa': ' h', 'Hesaplanmadı': 'Not calculated', 'Pencere Güneş Oranı': 'Window Sun-visible Fraction', 'Dünya Görünürlük Saati': 'Earth-visible Hours', 'Ufuk Tarama Yarıçapı': 'Horizon Scan Radius',
  'Metrikler yalnızca başarılı API yanıtından gösterilir.': 'Metrics are shown only after a successful API response.',
  'Cisim merkezi, o azimuttaki arazi ufkunun üstündeyse görünür. Geçişler örnekler arasındaki aralıktır; kesin olay saati değildir.': 'A body is visible when its center is above the terrain horizon at that azimuth. Transitions are intervals between samples, not exact event times.',
  'MOON_ME_DE421 · geometrik cisim merkezleri · atmosfer ve disk örtülmesi modellenmez. Görünürlük örneklenmiş arazi ufkuna göredir; tüm Ay için kesin görüş garantisi değildir.': 'MOON_ME_DE421 · geometric body centers · atmosphere and disk occultation are not modeled. Visibility is relative to the sampled terrain horizon; it is not a guarantee of visibility across the entire Moon.',
  'DEM ürünü': 'DEM product', 'Ufuk taraması': 'Horizon scan', 'Örnekleme': 'Sampling', '° azimut / ': '° azimuth / ', ' m mesafe': ' m distance', 'Bazı yönlerde tarama DEM sınırında kesildi.': 'The scan was truncated at the DEM boundary in some directions.',
  'SHA-256 dosyayı tanımlar; bilimsel doğrulama sertifikası değildir.': 'SHA-256 identifies the file; it is not a certificate of scientific validation.',
  '3D pusula aynı koordinatı, zamanı ve SPICE yönlerini kullanır. 200 m DEM üzerinde 1:1 arazi ve Ay eğriliği gösterilir. Görsel gölge çözümü yaklaşık; merkez görünürlüğünde API ufuk hesabı esas alınır.': 'The 3D compass uses the same coordinates, time and SPICE directions. It shows 1:1 terrain and lunar curvature using a 200 m DEM. Visual shadows are approximate; body-center visibility uses the API horizon calculation.',
  'Ay dokusu: NASA / GSFC / Arizona State University, LROC 4K. Dünya dokusu: Three.js örneklerinin earth_atmos_2048 haritası; doku yönelimi temsili, güncel bulut ve SPICE Dünya yönelimi değildir. Yıldızlar eklenirse dekoratiftir; katalog ölçümü değildir.': 'Moon texture: NASA / GSFC / Arizona State University, LROC 4K. Earth texture: the earth_atmos_2048 map from the Three.js examples; texture orientation is illustrative, not current clouds or SPICE Earth orientation. Any added stars are decorative, not catalog measurements.',
};

function useMissionText() {
  const { language } = useI18n();
  return (text: string) => {
    if (language === 'tr') return text;
    if (messages[text]) return messages[text];
    // Preserve server detail and HTTP status; only the service's own fallback prefix is UI copy.
    return text.replace(/^Gökyüzü API hatası:/, messages['Gökyüzü API hatası:']);
  };
}

const utc = (value: string, language: 'en' | 'tr') => new Date(value).toLocaleString(language === 'en' ? 'en-GB' : 'tr-TR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const angle = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}°`;
type Panel = 'sites' | 'metrics' | 'settings' | 'sources' | 'planner' | null;

function PanelPortal({ target, children }: { target: HTMLElement | null; children: React.ReactNode }) {
  return target ? createPortal(children, target) : <>{children}</>;
}

function StarLoading({ title = 'Gökyüzü hesaplanıyor', detail = 'Gerçek SPICE konumları ve ölçülmüş DEM ufku hazırlanıyor.' }: { title?: string; detail?: string }) {
  const text = useMissionText();
  return <div className="sv-loading" role="status"><div className="sv-loading-sky" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ '--star-x': `${(i * 37 + 11) % 100}%`, '--star-y': `${(i * 23 + 7) % 100}%`, '--star-delay': `${i * -0.19}s` } as React.CSSProperties} />)}<span className="sv-loading-orbit" /></div><span className="sv-eyebrow">{text('SPICE / LOLA · canlı hesap')}</span><h2>{text(title)}</h2><p>{text(detail)}</p><small>{text('Animasyon dekoratiftir; hesap ilerleme yüzdesi değildir.')}</small></div>;
}

function BodyMetrics({ body, name }: { body: SkyBody; name: string }) {
  const text = useMissionText();
  const { language } = useI18n();
  const event = body.next_transition;
  return <section className="sv-body">
    <div className="sv-body-heading"><h3>{text(name)}</h3><span className={body.center_visible ? 'sv-visible' : 'sv-blocked'}>{text(body.center_visible ? 'Görünür' : 'Arazi arkasında')}</span></div>
    <div className="sv-elevation">{angle(body.elevation_deg)}<small>{text('Yükselim')}</small></div>
    <dl className="sv-metric-pairs"><div><dt>{text('Azimut')}</dt><dd>{body.azimuth_deg.toFixed(2)}°</dd></div><div><dt>{text('Arazi ufku')}</dt><dd>{angle(body.horizon_elevation_deg)}</dd></div><div><dt>{text('Ufuktan fark')}</dt><dd>{angle(body.clearance_deg)}</dd></div></dl>
    <div className="sv-next"><span>{text(event ? (event.becomes_visible ? 'Sonraki görünme' : 'Sonraki örtülme') : 'Sonraki geçiş')}</span><p>{event ? <>{utc(event.after_utc, language)} – {utc(event.by_utc, language)} UTC</> : text('Seçili zaman aralığında bulunmadı.')}</p>{event && <small>{text('Örnekler arasındaki aralık; kesin olay saati değil.')}</small>}</div>
  </section>;
}

function FrostDialog({ panel, close, children, embedded = false }: { panel: Exclude<Panel, null>; close: () => void; children: React.ReactNode; embedded?: boolean }) {
  const text = useMissionText();
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const titles = { sites: 'Gözlem noktaları', metrics: 'Anlık metrikler', settings: 'Gözlem zamanı', sources: 'Veri ve hesap sınırları', planner: 'Karşılaştır ve planla' };
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const siblings = embedded && dialog?.parentElement ? Array.from(dialog.parentElement.children).filter(node => node !== dialog) as HTMLElement[] : [];
    siblings.forEach(node => { node.inert = true; });
    if (embedded) { dialog?.show(); dialog?.querySelector<HTMLButtonElement>('button')?.focus(); } else dialog?.showModal();
    const escape = (event: KeyboardEvent) => {
      if (!embedded) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key === 'Tab' && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')).filter(node => {
          if (node.matches(':disabled, input[type="hidden"]')) return false;
          const defaultSummary = node.tagName === 'SUMMARY' && node.parentElement?.tagName === 'DETAILS' && Array.from(node.parentElement.children).find(child => child.tagName === 'SUMMARY') === node;
          if (node.tabIndex < 0 && (node.hasAttribute('tabindex') || !defaultSummary)) return false;
          for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (ancestor.hidden || ancestor.inert || ancestor.hasAttribute('inert') || style.display === 'none') return false;
            if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open')) {
              const summary = Array.from(ancestor.children).find(child => child.tagName === 'SUMMARY');
              if (!summary?.contains(node)) return false;
            }
          }
          const style = getComputedStyle(node);
          return style.visibility !== 'hidden' && style.visibility !== 'collapse';
        }).sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    dialog?.addEventListener('keydown', escape);
    return () => { dialog?.removeEventListener('keydown', escape); siblings.forEach(node => { node.inert = false; }); dialog?.close(); previous?.focus(); };
  }, [embedded]);
  return <dialog ref={ref} className={`sv-dialog sv-dialog-${panel}${embedded ? ' sv-dialog-embedded' : ''}`} aria-labelledby="sv-dialog-title" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) { const box = e.currentTarget.getBoundingClientRect(); if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close(); } }}>
    <header className="sv-dialog-heading"><div><span className="sv-eyebrow">{text('MAXQMOON / Gözlem konsolu')}</span><h2 id="sv-dialog-title">{text(titles[panel])}</h2></div><button className="sv-icon-button" onClick={close} aria-label={text('Pencereyi kapat')}>×</button></header>
    <div className="sv-dialog-content">{children}</div>
  </dialog>;
}

export default function MissionControl() {
  const { t, language, setLanguage } = useI18n();
  const text = useMissionText();
  const [sites, setSites] = useState<SkySite[]>([]);
  const [siteId, setSiteId] = useState('');
  const [search, setSearch] = useState('');
  const [rejectedLocation, setRejectedLocation] = useState<LunarLocation | null>(null);
  const [rejectedUtc, setRejectedUtc] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(3);
  const [time, setTime] = useState('00:00');
  const [endUtc, setEndUtc] = useState('');
  const [stepSeconds, setStepSeconds] = useState(600);
  const [request, setRequest] = useState<ObservationRequest | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customLat, setCustomLat] = useState('');
  const [customLon, setCustomLon] = useState('');
  const [coordinateError, setCoordinateError] = useState('');
  const [series, setSeries] = useState<SkySeries | null>(null);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [plannerPickTarget, setPlannerPickTarget] = useState<'A' | 'B' | null>(null);
  const [plannerCustomA, setPlannerCustomA] = useState<PlannerObservation | undefined>(undefined);
  const [plannerCustomB, setPlannerCustomB] = useState<PlannerObservation | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>(null);
  const [view, setView] = useState<'sky' | 'compass'>('sky');
  const [spatialMode, setSpatialMode] = useState<'compass' | 'system'>('compass');
  const spatialDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (view !== 'compass') return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = spatialDialog.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, [view]);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => { try { return localStorage.getItem('lunarsight-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } });

  useEffect(() => { try { localStorage.setItem('lunarsight-theme', theme); } catch { /* Theme still works without storage. */ } }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError('');
    fetchSkySites(controller.signal).then(list => {
      if (controller.signal.aborted) return;
      setSites(list);
      if (list.length) { setSiteId(previous => previous || list[0].id); setRequest(previous => previous || { kind: 'catalog', siteId: list[0].id, date: new Date().toISOString().slice(0, 10), time: '00:00', days: 3 }); }
    }).catch(err => { if (!controller.signal.aborted) setCatalogError(err.message || 'Nokta listesi alınamadı.'); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setSeries(null); setIndex(0); setPlaying(false);
    let params: ReturnType<typeof observationWindow>;
    try { params = observationWindow(request); }
    catch (err) { setError(err instanceof Error ? err.message : 'UTC aralığı geçersiz.'); setLoading(false); return () => controller.abort(); }
    const calculation = request.kind === 'custom'
      ? fetchCustomSkySeries({ ...params, lat: request.lat, lon: request.lon }, controller.signal)
      : fetchSkySeries({ ...params, site_id: request.siteId, observer_height_m: 2 }, controller.signal);
    calculation.then(data => { if (!controller.signal.aborted) setSeries(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message || 'Gökyüzü hesabı alınamadı.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request]);

  useEffect(() => {
    if (!playing || !series) return;
    const timer = window.setInterval(() => setIndex(current => {
      if (current >= series.points.length - 1) { setPlaying(false); return current; }
      return current + 1;
    }), Math.max(45, 180 / playbackSpeed));
    return () => window.clearInterval(timer);
  }, [playing, series, playbackSpeed]);

  const selected = sites.find(site => site.id === (request?.kind === 'catalog' ? request.siteId : siteId));
  const point = series?.points[index];
  const filtered = sites.filter(site => `${site.name} ${site.id}`.toLocaleLowerCase('tr').includes(search.toLocaleLowerCase('tr')));
  const observeLocation = (location: LunarLocation) => {
    const next = observationForLocation(location, sites, { date, time, days, ...(endUtc ? { endUtc } : {}), stepSeconds });
    try { observationWindow(next); }
    catch (err) { setCoordinateError(err instanceof Error ? err.message : 'UTC aralığı geçersiz.'); setPanel('settings'); return false; }
    setCoordinateError(''); setRejectedLocation(null);
    setCustomMode(next.kind === 'custom');
    if (next.kind === 'catalog') setSiteId(next.siteId);
    else { setCustomLat(String(next.lat)); setCustomLon(String(next.lon)); }
    // Clear old measurements immediately; never label previous-site data as this selection.
    setSeries(null); setIndex(0); setPlaying(false); setError(''); setLoading(true);
    setRequest(next);
    return true;
  };
  const submit = () => {
    if (!date) return;
    if (customMode) {
      const lat = Number(customLat), lon = Number(customLon);
      if (!customLat.trim() || !customLon.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        setCoordinateError('Enlem −90° ile +90°, boylam −180° ile +180° arasında olmalı.');
        return;
      }
      if (!observeLocation({ lat, lon })) return;
    } else {
      const catalog = sites.find(site => site.id === siteId);
      if (!catalog) return;
      if (!observeLocation(catalog)) return;
    }
    setPanel(null);
  };
  const submitWindow = () => {
    const location = rejectedLocation || (request?.kind === 'custom' ? { lat: request.lat, lon: request.lon } : sites.find(site => site.id === (request?.kind === 'catalog' ? request.siteId : siteId)));
    if (!location) { setCoordinateError('Önce bir gözlem noktası seçin.'); return; }
    if (observeLocation(location)) setPanel(null);
  };
  const enterPanorama = (location: LunarLocation) => {
    if (!observeLocation(location)) return;
    setPanel(null); setPlaying(false); setView('compass'); setSpatialMode('compass');
  };
  const openGlobe = () => { setPanel(null); setSpatialMode('system'); setView('compass'); };
  const selectObservation = (scenario: PlannerObservation) => {
    try {
      const next = observationFromPlanner(scenario);
      setDate(next.date); setTime(next.time || '00:00'); setDays(next.days);
      setEndUtc(next.endUtc || ''); setStepSeconds(next.stepSeconds || 600);
      setCustomMode(next.kind === 'custom');
      if (next.kind === 'catalog') setSiteId(next.siteId);
      else { setCustomLat(String(next.lat)); setCustomLon(String(next.lon)); }
      setSeries(null); setIndex(0); setPlaying(false); setError(''); setLoading(true); setCoordinateError('');
      setRejectedLocation(null); setRequest(next); setPanel(null); setSpatialMode('compass');
    } catch (err) { setCoordinateError(err instanceof Error ? err.message : 'Plan açılamadı.'); }
  };
  const rejectLocation = (location: LunarLocation, message: string) => {
    setRequest(null); setSeries(null); setIndex(0); setPlaying(false); setLoading(false);
    setRejectedLocation(location);
    try { setRejectedUtc(observationStartUtc({ date, time })); } catch { setRejectedUtc(''); }
    setError(message);
    setPanel(null); setSpatialMode('compass');
  };
  const customSelected = request?.kind === 'custom';
  const locationName = rejectedLocation ? text('Seçilen nokta') : customSelected ? text('Özel Koordinat') : request ? selected?.name : undefined;
  const coordinates = rejectedLocation || (customSelected ? { lat: request.lat, lon: request.lon } : request ? selected : undefined);
  const plannerInitial = series && request ? { ...(request.kind === 'catalog' ? { site_id: request.siteId } : { lat: request.lat, lon: request.lon }), start_utc: series.start_utc, end_utc: series.end_utc, step_seconds: series.step_seconds } : undefined;
  const plannerDate = point?.time_utc || (request ? observationWindow(request).start_utc : undefined);
  const togglePlay = () => {
    if (!series) return;
    if (index === series.points.length - 1) setIndex(0);
    setPlaying(value => !value);
  };
  const changeIndex = (next: number) => { setPlaying(false); setIndex(next); };
  const selectTime = (value: string) => {
    if (!series) return;
    const target = Date.parse(value);
    if (!Number.isFinite(target)) return;
    const nearest = series.points.reduce((best, sample, i) => Math.abs(Date.parse(sample.time_utc) - target) < Math.abs(Date.parse(series.points[best].time_utc) - target) ? i : best, 0);
    changeIndex(nearest);
  };
  const sharedControls = <><VisibilityCard series={series} index={index} loading={loading} onOpenMetrics={() => setPanel('metrics')} onSelectTime={selectTime} /><ObservationDock series={series} index={index} playing={playing} playbackSpeed={playbackSpeed} onPlaybackSpeedChange={setPlaybackSpeed} loading={loading} onIndexChange={changeIndex} onTogglePlay={togglePlay} onOpenSettings={() => setPanel('settings')} /></>;
  const status = loading ? text('Hesaplanıyor') : error || catalogError ? text('Veri hatası') : point ? text('Gerçek veri') : text('Bağlanıyor');

  return <div className="sv-app" data-theme={theme}>
    <header className="sv-header">
      <a className="sv-brand" href="/" aria-label={text('MAXQMOON ana sayfa')}><img className="sv-brand-logo" src={`${process.env.PUBLIC_URL}/lunarsight-logo.jpg`} width="44" height="44" alt="" /><span>MAXQMOON<small>{text('Yüzey gözlem konsolu')}</small></span></a>
      <div className="sv-header-actions"><GitHubLink /><span className="sv-engine">SPICE / LOLA</span><button className="sv-help-toggle" aria-label={t('languageLabel')} title={t('languageLabel')} onClick={() => setLanguage(language === 'tr' ? 'en' : 'tr')}>{language === 'tr' ? 'EN' : 'TR'}</button><button className="sv-theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? t('switchToLight') : t('switchToDark')}><span aria-hidden="true">{theme === 'dark' ? '◐' : '◑'}</span><span>{theme === 'dark' ? t('themeLightText') : t('themeDarkText')}</span></button></div>
    </header>

    <main className={`sv-stage ${view === 'compass' ? 'sv-stage-compass' : ''}`} aria-label={text('Gökyüzü gözlemi')}>
      <div className="sv-stage-heading"><div><p className="sv-eyebrow">{text('Ay’ın güney kutbu / ')}{view === 'sky' ? text('2D gözlem') : text('Yüzey panoraması')}</p><h1>{view === 'sky' ? text('Gökyüzü') : text('Pusula')}<span>.</span></h1></div><div className="sv-view-switch" role="group" aria-label={text('Gözlem görünümü')}><button aria-pressed={view === 'sky'} onClick={() => setView('sky')}>{text('2D Gökyüzü')}</button><button aria-pressed={view === 'compass'} onClick={() => setView('compass')}>{text('3D Pusula')}</button></div><div className="sv-stage-status" role="status"><i className={error || catalogError ? 'is-error' : ''} />{status}</div></div>
      <div className="sv-chart-area" aria-busy={loading}>{series && point ? view === 'sky' ? <SkyViewGraph series={series} point={point} /> : <Suspense fallback={<div className="sv-empty" role="status">{text('3D yüzey motoru yükleniyor…')}</div>}><div className="sv-empty">{text('Tam ekran 3D görünüm açık.')}</div></Suspense> : loading ? <StarLoading /> : <div className="sv-empty" role={error || catalogError ? 'alert' : 'status'}><span className="sv-empty-reticle" aria-hidden="true">+</span><h2>{loading ? text('Gökyüzü hesaplanıyor') : error || catalogError ? text('Gözlem verisi alınamadı') : text('Ufka bağlanılıyor')}</h2><p>{text(error || catalogError) || (loading ? text('Gerçek SPICE konumları ve DEM ufuk profili hazırlanıyor.') : text('Gözlem noktaları yükleniyor.'))}</p>{(error || catalogError) && <button onClick={() => catalogError ? setRetry(value => value + 1) : request && setRequest({ ...request })}>{text('Tekrar dene')}</button>}<small>{text('Eksik veride yapay ufuk veya örnek sonuç gösterilmez.')}</small></div>}</div>
      <div className="sv-observation-context" aria-label={text('Etkin gözlem bağlamı')}>{coordinates && <span>{coordinates.lat.toFixed(5)}°, {coordinates.lon.toFixed(5)}°</span>}<time>{point?.time_utc || (request ? observationWindow(request).start_utc : rejectedUtc)} {request || point || rejectedUtc ? 'UTC' : ''}</time></div>
      <div className="sv-stage-footnote"><span>MOON_ME_DE421</span><span>{text('Ölçülmüş arazi ufku · cisim merkezleri')}</span></div>
    </main>

    <nav className="sv-corner-tools" aria-label={text('Gözlem araçları')}>
      <button className="sv-location-button sv-glass" onClick={() => setPanel('sites')} aria-haspopup="dialog"><span className="sv-tool-icon" aria-hidden="true">⌖</span><span><small>{text('Gözlem noktası')}</small><strong>{locationName || text('Nokta seçin')}</strong><em>{coordinates ? `${coordinates.lat.toFixed(4)}° / ${coordinates.lon.toFixed(4)}°` : text('Katalog ve özel koordinat')}</em></span><span aria-hidden="true">↗</span></button>
      <div className="sv-tool-cluster sv-glass"><button onClick={openGlobe}><span className="sv-step-number">1</span>{' '}{text('Nokta seç')}</button><button onClick={() => setPanel('settings')} aria-haspopup="dialog"><span className="sv-step-number">2</span>{' '}{text('Zaman aralığı')}</button><button onClick={() => setPanel('planner')} aria-haspopup="dialog"><span className="sv-step-number">3</span>{' '}{text('Koşullar / A·B (İki noktayı karşılaştır)')}</button><button onClick={() => setPanel('sources')} aria-haspopup="dialog" aria-label={text('Veri kaynağı ve hesap sınırları')}>ⓘ</button></div>

    </nav>

    {view === 'sky' && sharedControls}

    {view === 'compass' && <dialog ref={spatialDialog} className="sv-spatial-dialog" aria-label={text('Tam ekran üç boyutlu gözlem')} onCancel={e => { e.preventDefault(); if (panel) setPanel(null); else setView('sky'); }}>
      <header className="sv-spatial-toolbar sv-glass"><div className="sv-view-switch" role="group" aria-label={text('3D görünüm')}><button aria-pressed={spatialMode === 'compass'} onClick={() => setSpatialMode('compass')}>{text('Yüzey / Arazi')}</button><button aria-pressed={spatialMode === 'system'} onClick={() => setSpatialMode('system')}>{text('Ay küresi / Sistem')}</button></div><details className="sv-spatial-options"><summary>{text('Araçlar')}</summary><div className="sv-spatial-options-menu sv-glass"><button onClick={() => setPanel('sites')}>{text('⌖ Nokta seç')}</button><button onClick={() => setPanel('settings')}>{text('◷ Tarih / saat')}</button><button onClick={() => setPanel('planner')}>{text('A/B karşılaştır · Gelecek ara ↗')}</button><button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? text('Açık tema') : text('Koyu tema')}</button></div></details><button className="sv-icon-button" aria-label={text('3D görünümü kapat')} onClick={() => setView('sky')}>×</button></header>

      <div className="sv-spatial-content">{spatialMode === 'system' ? <Suspense fallback={<StarLoading title={text('Ay küresi hazırlanıyor')} detail={text('Ölçülmüş alan ve nokta seçim araçları yükleniyor.')} />}><SystemView series={series} point={point || null} onSurface={() => setSpatialMode('compass')} catalogSites={sites} selectedLocation={rejectedLocation || undefined} onRejectLocation={rejectLocation} onEnterPanorama={enterPanorama} selectionTarget={plannerPickTarget} onSelectForPlanner={(target, loc) => {
        const startUtc = date ? `${date}T${time}:00.000Z` : new Date().toISOString();
        const obs: PlannerObservation = {
          lat: loc.lat,
          lon: loc.lon,
          start_utc: startUtc,
          end_utc: new Date(Date.parse(startUtc) + 86400000).toISOString(),
          step_seconds: stepSeconds,
        };
        if (target === 'A') setPlannerCustomA(obs);
        else setPlannerCustomB(obs);
        setPlannerPickTarget(null);
        setPanel('planner');
      }} onCancelPlannerPick={() => {
        setPlannerPickTarget(null);
        setPanel('planner');
      }} /></Suspense> : series && point ? <Suspense fallback={<StarLoading title={text('Yüzey motoru hazırlanıyor')} />}><CompassView key={`${series.site.lat_deg}:${series.site.lon_deg}:${series.start_utc}`} series={series} point={point} /></Suspense> : loading ? <StarLoading /> : <div className="sv-empty" role={error ? 'alert' : 'status'}><h2>{error ? text('Bu gözlem hesaplanamadı') : text('Bir gözlem noktası seçin')}</h2><p>{text(error) || text('Ölçülmüş güney kutbu alanından bir nokta ve UTC aralığı seçin.')}</p><p>{text('Eksik veride arazi veya görünürlük üretilmez. Küreye dönüp geçerli başka bir nokta seçebilirsiniz.')}</p><div className="sv-recovery-actions"><button className="sv-primary" onClick={() => setSpatialMode('system')}>{text('Ay küresinden yeniden seç ↗')}</button><button onClick={() => setPanel('settings')}>{text('Zaman aralığını değiştir')}</button>{error && <button onClick={() => request && setRequest({ ...request })}>{text('Tekrar dene')}</button>}</div></div>}</div>
      {!series && <div className="sv-spatial-context" aria-label={text('3D gözlem bağlamı')}>{coordinates && <span>{coordinates.lat.toFixed(5)}°, {coordinates.lon.toFixed(5)}°</span>}<time>{point?.time_utc || (request ? observationWindow(request).start_utc : rejectedUtc)} {request || point || rejectedUtc ? 'UTC' : ''}</time></div>}
      {sharedControls}
    </dialog>}
    {panel && <PanelPortal target={view === 'compass' ? spatialDialog.current : null}><FrostDialog key={panel} panel={panel} embedded={view === 'compass'} close={() => setPanel(null)}>
      {panel === 'sites' && <><div style={{ display: 'flex', gap: 8, marginBottom: 8 }}><button className="sv-primary" style={{ flex: 1 }} onClick={openGlobe}>{text('Ay küresinden nokta seç ↗')}</button><button className="sv-secondary" style={{ flex: 1 }} onClick={() => setPanel('planner')}>{text('⚖ İki noktayı karşılaştır (A / B) ↗')}</button></div><p className="sv-muted">{text('Kürede bir nokta seçin; koordinatı kontrol edip “Bu noktayı gözle” ile onaylayın.')}</p><div className="sv-tabs"><button aria-pressed={!customMode} onClick={() => setCustomMode(false)}>{text('Katalog')}{' '}<span>{sites.length}</span></button><button aria-pressed={customMode} onClick={() => setCustomMode(true)}>{text('Özel koordinat')}</button></div>{customMode ? <form className="sv-custom-form" onSubmit={e => { e.preventDefault(); submit(); }}><p className="sv-muted">{text('Koordinatı olduğu gibi gözlemleyin. Arazi verisi yalnız güney kutbundaki sınırlı alanlarda mevcut.')}</p><div className="sv-form-row"><label>{text('Enlem')}<input type="number" step="any" min="-90" max="90" required placeholder="-89.4395" value={customLat} onChange={e => setCustomLat(e.target.value)} /></label><label>{text('Boylam')}<input type="number" step="any" min="-180" max="180" required placeholder="-137.1934" value={customLon} onChange={e => setCustomLon(e.target.value)} /></label></div><p className="sv-muted">{date} UTC · {days}{text(' gün. Kapsam dışı koordinatlar hesaplanmaz.')}</p>{coordinateError && <p className="sv-coordinate-error" role="alert">{text(coordinateError)}</p>}<button className="sv-primary" type="submit" disabled={loading || !date}>{text('Bu noktayı gözle')}</button></form> : <><label className="sv-search"><span aria-hidden="true">⌕</span><input aria-label={text('Gözlem noktası ara')} placeholder={text('İsim veya kimlik ile ara…')} value={search} onChange={e => setSearch(e.target.value)} /></label><div className="sv-list">{catalogError ? <div role="alert"><p>{text(catalogError)}</p><button onClick={() => setRetry(value => value + 1)}>{text('Tekrar bağlan')}</button></div> : !sites.length ? <p>{text('Noktalar yükleniyor…')}</p> : filtered.length ? filtered.map((site, number) => <button key={site.id} className="sv-site" aria-pressed={!customSelected && site.id === siteId} onClick={() => { if (observeLocation(site)) setPanel(null); }}><span className="sv-site-number">{String(number + 1).padStart(2, '0')}</span><span><strong>{site.name}</strong><small>{site.lat.toFixed(4)}° / {site.lon.toFixed(4)}°{site.dem_covered === false ? text(' · DEM kapsamı dışı') : ''}</small></span><span aria-hidden="true">{!customSelected && site.id === siteId ? '●' : '↗'}</span></button>) : <p className="sv-muted">{text('Aramanızla eşleşen nokta yok.')}</p>}</div></>}</>}
      {panel === 'settings' && <form className="sv-settings-form" onSubmit={e => { e.preventDefault(); submitWindow(); }}><p className="sv-muted">{text('UTC başlangıç ve bitişini seçin. Nokta ve zaman aynı hesapta kullanılır; koşullu pencere araması için A/B planlayıcıya geçin.')}</p><div className="sv-form-row"><label>{text('Başlangıç · UTC')}<input type="date" required value={date} onChange={e => { setDate(e.target.value); setCoordinateError(''); }} /></label><label>{text('Saat · UTC')}<input type="time" required step="0.001" value={time} onChange={e => { setTime(e.target.value); setCoordinateError(''); }} /></label><label>{text('Hızlı süre')}<select value={endUtc ? 'exact' : String(days)} onChange={e => { setDays(Number(e.target.value)); setEndUtc(''); }}><option value="exact" disabled>{text('Özel bitiş zamanı')}</option><option value="1">{text('24 saat')}</option><option value="3">{text('3 gün')}</option><option value="7">{text('7 gün')}</option><option value="14">{text('14 gün')}</option></select></label></div><div className="sv-form-row"><label>{text('Bitiş · UTC (isteğe bağlı)')}<input type="datetime-local" step="0.001" value={endUtc ? endUtc.replace(/Z$/, '') : ''} onChange={e => { setEndUtc(e.target.value ? `${e.target.value}Z` : ''); setCoordinateError(''); }} /></label><label>{text('Örnek adımı')}<select value={stepSeconds} onChange={e => setStepSeconds(Number(e.target.value))}>{Array.from(new Set([600, 1800, 3600, 21600, stepSeconds])).sort((a, b) => a - b).map(step => <option key={step} value={step}>{step / 60}{text(' dakika')}</option>)}</select></label></div><p className="sv-muted">{text('Konum: ')}{locationName || text('Henüz seçilmedi')}{text(' · en çok 2049 örnek. Bitiş boşsa hızlı süre uygulanır.')}</p>{coordinateError && <p role="alert">{text(coordinateError)}</p>}<div className="sv-recovery-actions"><button className="sv-primary" type="submit" disabled={(!customMode && !siteId) || !date || loading}>{text('Gözlemi hesapla ↗')}</button><button type="button" onClick={() => setPanel('planner')}>{text('Koşullarıma uygun pencere ara / A·B')}</button></div></form>}
      {panel === 'planner' && <ComparePlanner catalog={sites} initialScenarioA={plannerCustomA || plannerInitial} initialScenarioB={plannerCustomB} selectedSiteId={request?.kind === 'catalog' ? request.siteId : siteId} currentDateUtc={plannerDate} onSelectObservation={selectObservation} onOpenGlobeToPick={(target) => {
        setPlannerPickTarget(target);
        setPanel(null);
        setSpatialMode('system');
        setView('compass');
      }} />}
      {panel === 'metrics' && <>{point ? <><div className="sv-time-stamp">{utc(point.time_utc, language)} <span>{text('UTC / hesaplanan örnek')}</span></div><div className="sv-metrics-grid"><BodyMetrics body={point.sun} name="Güneş" /><BodyMetrics body={point.earth} name="Dünya" /></div>{series && <div className="sv-metrics-grid" style={{ marginTop: 12 }}><section className="sv-metric-card" aria-label={text('Arazi ve eğim ölçümleri')}><h3>{text('Arazi ve Yerel Eğim')}</h3><dl><div><dt>{text('Yüzey Yüksekliği')}</dt><dd>{series.site.surface_elevation_m.toFixed(1)} m</dd></div><div><dt>{text('Yerel Eğim')}</dt><dd>{series.local_slope?.slope_deg !== undefined && series.local_slope?.slope_deg !== null ? `${series.local_slope.slope_deg.toFixed(2)}°` : text('Ölçülemiyor')}</dd></div>{series.local_slope?.fit_rms_m !== undefined && <div><dt>{text('Düzlem Uyum RMS')}</dt><dd>{series.local_slope.fit_rms_m.toFixed(2)} m</dd></div>}{series.local_slope?.grid_spacing_m !== undefined && <div><dt>{text('DEM Çözünürlüğü')}</dt><dd>{series.local_slope.grid_spacing_m.toFixed(0)} m</dd></div>}</dl></section><section className="sv-metric-card" aria-label={text('Pencere güneşlenme ve aydınlanma')}><h3>{text('Güneşlenme / Aydınlanma')}</h3><dl><div><dt>{text('Toplam Güneş Saati')}</dt><dd>{series.visibility_intervals?.sun?.total_visible_hours !== undefined ? `${series.visibility_intervals.sun.total_visible_hours.toFixed(2)}${text(' sa')}` : text('Hesaplanmadı')}</dd></div><div><dt>{text('Pencere Güneş Oranı')}</dt><dd>{series.visibility_intervals?.sun?.total_visible_hours !== undefined ? `%${Math.min(100, Math.max(0, (series.visibility_intervals.sun.total_visible_hours / Math.max(0.001, (Date.parse(series.end_utc) - Date.parse(series.start_utc)) / 3600000))) * 100).toFixed(1)}` : '—'}</dd></div><div><dt>{text('Dünya Görünürlük Saati')}</dt><dd>{series.visibility_intervals?.earth?.total_visible_hours !== undefined ? `${series.visibility_intervals.earth.total_visible_hours.toFixed(2)}${text(' sa')}` : text('Hesaplanmadı')}</dd></div><div><dt>{text('Ufuk Tarama Yarıçapı')}</dt><dd>{series.horizon.coverage.requested_max_distance_m / 1000} km</dd></div></dl></section></div>}</> : <p>{text('Metrikler yalnızca başarılı API yanıtından gösterilir.')}</p>}<p className="sv-definition">{text('Cisim merkezi, o azimuttaki arazi ufkunun üstündeyse görünür. Geçişler örnekler arasındaki aralıktır; kesin olay saati değildir.')}</p></>}
      {panel === 'sources' && <div className="sv-provenance"><p>NAIF SPICE + NASA LOLA DEM</p><p>{text('MOON_ME_DE421 · geometrik cisim merkezleri · atmosfer ve disk örtülmesi modellenmez. Görünürlük örneklenmiş arazi ufkuna göredir; tüm Ay için kesin görüş garantisi değildir.')}</p>{series && <><dl className="sv-source-list"><div><dt>{text('DEM ürünü')}</dt><dd>{series.horizon.provenance.source_product}</dd></div><div><dt>{text('Ufuk taraması')}</dt><dd>{series.horizon.coverage.requested_max_distance_m / 1000} km</dd></div><div><dt>{text('Örnekleme')}</dt><dd>{series.horizon.coverage.azimuth_step_deg}{text('° azimut / ')}{series.horizon.coverage.distance_step_m}{text(' m mesafe')}</dd></div></dl>{series.horizon.coverage.truncated && <p>{text('Bazı yönlerde tarama DEM sınırında kesildi.')}</p>}<p className="sv-hash">DEM SHA-256: {series.horizon.provenance.sha256}</p><small>{text('SHA-256 dosyayı tanımlar; bilimsel doğrulama sertifikası değildir.')}</small></>}<p>{text('3D pusula aynı koordinatı, zamanı ve SPICE yönlerini kullanır. 200 m DEM üzerinde 1:1 arazi ve Ay eğriliği gösterilir. Görsel gölge çözümü yaklaşık; merkez görünürlüğünde API ufuk hesabı esas alınır.')}</p><p>{text('Ay dokusu: NASA / GSFC / Arizona State University, LROC 4K. Dünya dokusu: Three.js örneklerinin earth_atmos_2048 haritası; doku yönelimi temsili, güncel bulut ve SPICE Dünya yönelimi değildir. Yıldızlar eklenirse dekoratiftir; katalog ölçümü değildir.')}</p></div>}
    </FrostDialog></PanelPortal>}
  </div>;
}
