import React, { useState, useRef, useEffect } from 'react';
import {
  discoverCandidates,
  DiscoveryCandidate,
  DiscoveryResponse,
  DiscoveryWindow,
} from '../../services/skyviewDiscovery';
import { PlannerObservation } from '../../services/skyviewPlanning';
import './CandidateDiscovery.css';
import { useI18n } from '../../i18n';

export interface CandidateDiscoveryProps {
  initialDateUtc?: string;
  onSelectObservation?: (observation: PlannerObservation) => void;
  onApplyToA?: (candidate: DiscoveryCandidate, window: DiscoveryWindow) => void;
  onApplyToB?: (candidate: DiscoveryCandidate, window: DiscoveryWindow) => void;
  onComparePair?: (candidateA: DiscoveryCandidate, candidateB: DiscoveryCandidate) => void;
}

const utcInput = (value: string) => {
  try {
    return new Date(value).toISOString().slice(0, 16);
  } catch {
    return new Date().toISOString().slice(0, 16);
  }
};

const toUtc = (value: string): string => {
  const d = new Date(`${value}Z`);
  if (!Number.isFinite(d.getTime())) {
    throw new Error('Geçerli bir UTC tarihi seçin.');
  }
  return d.toISOString();
};

export default function CandidateDiscovery({
  initialDateUtc,
  onSelectObservation,
  onApplyToA,
  onApplyToB,
  onComparePair,
}: CandidateDiscoveryProps) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  // Retain the existing fixed-decimal Turkish display; use English percent order in EN.
  const percent = (value: number, digits: number) => text(`%${value.toFixed(digits)}`, `${value.toFixed(digits)}%`);
  const errorText = (message: string) => {
    if (message === 'Geçerli bir UTC tarihi seçin.') return text(message, 'Choose a valid UTC date.');
    if (message === 'Aday keşfi başarısız oldu.') return text(message, 'Candidate discovery failed.');
    if (message === 'Bilimsel veri kullanılamıyor: SPICE çekirdeklerini ve ölçülmüş hesaplama DEM dosyasını kontrol edin.') return text(message, 'Scientific data is unavailable: check the SPICE kernels and measured computation DEM file.');
    if (message === 'Aday keşfi parametreleri geçersiz. Tarih aralığını, süre ve eğim limitlerini kontrol edin.') return text(message, 'Candidate discovery parameters are invalid. Check the date range, duration and slope limits.');
    return language === 'tr' ? message : message.replace(/^Aday keşfi başarısız \(HTTP (\d+)\)\.$/, 'Candidate discovery failed (HTTP $1).');
  };
  const baseDate = useRef(initialDateUtc || '2026-01-01T00:00:00Z').current;

  const [startUtc, setStartUtc] = useState(() => utcInput(baseDate));
  const [endUtc, setEndUtc] = useState(() =>
    utcInput(new Date(Date.parse(baseDate) + 7 * 86400000).toISOString())
  );
  const [durationHours, setDurationHours] = useState(24);
  const [cadenceHours, setCadenceHours] = useState(24);
  const [stepSeconds, setStepSeconds] = useState(3600);
  const [minSunPercent, setMinSunPercent] = useState(30);
  const [minEarthPercent, setMinEarthPercent] = useState(30);
  const [maxSlopeDeg, setMaxSlopeDeg] = useState(15);
  const [spatialResKm, setSpatialResKm] = useState(20);
  const [maxResults, setMaxResults] = useState(5);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<DiscoveryResponse | null>(null);

  const activeAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      activeAbort.current?.abort();
    };
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    activeAbort.current?.abort();
    const controller = new AbortController();
    activeAbort.current = controller;

    setLoading(true);
    setError(null);

    try {
      const start = toUtc(startUtc);
      const end = toUtc(endUtc);

      const res = await discoverCandidates(
        {
          start_utc: start,
          end_utc: end,
          duration_hours: durationHours,
          cadence_hours: cadenceHours,
          step_seconds: stepSeconds,
          min_sunlight_fraction: minSunPercent / 100,
          min_earth_fraction: minEarthPercent / 100,
          max_slope_deg: maxSlopeDeg,
          spatial_resolution_m: spatialResKm * 1000,
          max_results: maxResults,
        },
        controller.signal
      );

      if (!controller.signal.aborted) {
        setResponse(res);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Aday keşfi başarısız oldu.');
      }
    } finally {
      if (activeAbort.current === controller) {
        activeAbort.current = null;
        setLoading(false);
      }
    }
  };

  const cancelSearch = () => {
    activeAbort.current?.abort();
    activeAbort.current = null;
    setLoading(false);
  };

  const handleSelectObservation = (c: DiscoveryCandidate, w: DiscoveryWindow) => {
    onSelectObservation?.({
      lat: c.lat,
      lon: c.lon,
      start_utc: w.start_utc,
      end_utc: w.end_utc,
      step_seconds: stepSeconds,
    });
  };

  return (
    <section className="candidate-discovery" aria-label={text('Otomatik aday iniş yeri keşfi', 'Automatic candidate landing site discovery')}>
      <header className="cd-header">
        <h3>{text('🌟 Kriterlere Göre Otomatik Yer Keşfet', '🌟 Automatically Discover Sites by Criteria')}</h3>
        <p>
          {text('Herhangi bir A veya B noktası seçmenize gerek yoktur. İstenen güneşlenme, dünya görünürlüğü, maksimum eğim ve tarih aralığını belirleyin; NASA LOLA DEM ve SPICE yörünge mekaniğiyle en uygun iniş yerleri taranıp puanlansın.', 'No need to select a point A or B. Set the desired sunlight, Earth visibility, maximum slope and date range; suitable landing sites will be scanned and scored using NASA LOLA DEM and SPICE orbital mechanics.')}
        </p>
      </header>

      <form className="cd-form" onSubmit={handleSearch}>
        <fieldset className="cd-fieldset">
          <legend>{text('Zaman Aralığı ve Örnekleme', 'Time Range and Sampling')}</legend>
          <div className="cd-grid">
            <label className="cd-label">
              {text('Arama Başlangıcı (UTC)', 'Search Start (UTC)')}
              <input
                type="datetime-local"
                value={startUtc}
                onChange={(e) => setStartUtc(e.target.value)}
                required
              />
            </label>
            <label className="cd-label">
              {text('Arama Bitişi (UTC)', 'Search End (UTC)')}
              <input
                type="datetime-local"
                value={endUtc}
                onChange={(e) => setEndUtc(e.target.value)}
                required
              />
            </label>
            <label className="cd-label">
              {text('Pencere Süresi (Saat)', 'Window Duration (Hours)')}
              <input
                type="number"
                min="1"
                max="168"
                value={durationHours}
                onChange={(e) => setDurationHours(Number(e.target.value))}
                required
              />
            </label>
            <label className="cd-label">
              {text('Örnek Adımı', 'Sample Step')}
              <select
                value={stepSeconds}
                onChange={(e) => setStepSeconds(Number(e.target.value))}
              >
                <option value="1800">{text('30 dakika', '30 minutes')}</option>
                <option value="3600">{text('1 saat', '1 hour')}</option>
                <option value="7200">{text('2 saat', '2 hours')}</option>
                <option value="21600">{text('6 saat', '6 hours')}</option>
              </select>
            </label>
            <label className="cd-label">
              {text('Başlangıç Adımı (Saat)', 'Start Cadence (Hours)')}
              <input
                type="number"
                min="1"
                max="168"
                value={cadenceHours}
                onChange={(e) => setCadenceHours(Number(e.target.value))}
              />
            </label>
            <label className="cd-label">
              {text('Sonuç Sayısı', 'Result Count')}
              <input
                type="number"
                min="1"
                max="20"
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value))}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="cd-fieldset">
          <legend>{text('İstenen Koşullar ve Toleranslar', 'Desired Conditions and Tolerances')}</legend>
          <div className="cd-grid">
            <label className="cd-label">
              {text('En Az Güneş Görünürlüğü (%)', 'Minimum Sun Visibility (%)')}
              <input
                type="number"
                min="0"
                max="100"
                value={minSunPercent}
                onChange={(e) => setMinSunPercent(Number(e.target.value))}
                required
              />
            </label>
            <label className="cd-label">
              {text('En Az Dünya Görünürlüğü (%)', 'Minimum Earth Visibility (%)')}
              <input
                type="number"
                min="0"
                max="100"
                value={minEarthPercent}
                onChange={(e) => setMinEarthPercent(Number(e.target.value))}
                required
              />
            </label>
            <label className="cd-label">
              {text('En Fazla Arazi Eğimi (°)', 'Maximum Terrain Slope (°)')}
              <input
                type="number"
                min="0"
                max="90"
                step="0.5"
                value={maxSlopeDeg}
                onChange={(e) => setMaxSlopeDeg(Number(e.target.value))}
                required
              />
            </label>
            <label className="cd-label">
              {text('Taranacak Izgara Çözünürlüğü (km)', 'Scan Grid Resolution (km)')}
              <select
                value={spatialResKm}
                onChange={(e) => setSpatialResKm(Number(e.target.value))}
              >
                <option value="10">{text('10 km (Ayrıntılı)', '10 km (Detailed)')}</option>
                <option value="20">{text('20 km (Standart)', '20 km (Standard)')}</option>
                <option value="50">{text('50 km (Hızlı Tarama)', '50 km (Quick Scan)')}</option>
              </select>
            </label>
          </div>
        </fieldset>

        <div className="cd-actions">
          <button className="cd-primary-button" type="submit" disabled={loading}>
            {loading ? text('Ay Yüzeyi Taranıyor…', 'Scanning the Lunar Surface…') : text('Ay Yüzeyinde Uygun Yerleri Keşfet', 'Discover Suitable Sites on the Lunar Surface')}
          </button>
          {loading && (
            <button className="cd-cancel-button" type="button" onClick={cancelSearch}>
              {text('İptal Et', 'Cancel')}
            </button>
          )}
        </div>
      </form>

      {loading && (
        <div className="cd-status" role="status">
          {text('NASA LOLA 60°S DEM arazi modeli ve NAIF SPICE çekirdekleri üzerinde koşullara uygun iniş bölgeleri taranıyor…', 'Scanning for landing regions matching your conditions using the NASA LOLA 60°S DEM terrain model and NAIF SPICE kernels…')}
        </div>
      )}

      {error && (
        <div className="cd-error" role="alert">
          {errorText(error)}
        </div>
      )}

      {response && (
        <div className="cd-results" aria-live="polite">
          <div className="cd-results-toolbar">
            <span className="cd-results-count">
              <strong>{response.results.length}</strong> {text('aday iniş bölgesi bulundu (', 'candidate landing regions found (')}
              {response.metadata.evaluated_candidates} {text('nokta ve', 'points and')}{' '}
              {response.metadata.evaluated_windows} {text('pencere tarandı)', 'windows scanned)')}
            </span>
            {response.results.length >= 2 && onComparePair && (
              <button
                className="cd-primary-button"
                style={{ fontSize: 13, padding: '8px 14px', minHeight: 36 }}
                type="button"
                onClick={() => onComparePair(response.results[0], response.results[1])}
              >
                {text('⚖ En İyi 2 Adayı Karşılaştır (A vs B)', '⚖ Compare the Best 2 Candidates (A vs B)')}
              </button>
            )}
          </div>

          {response.results.length === 0 ? (
            <p className="cd-empty">
              {text('Belirtilen koşulları sağlayan aday bölge bulunamadı. Eğim sınırını artırabilir veya güneş/dünya görünürlük yüzdesini azaltarak yeniden deneyebilirsiniz.', 'No candidate regions satisfy the specified conditions. Try increasing the slope limit or reducing the Sun/Earth visibility percentage.')}
            </p>
          ) : (
            response.results.map((candidate, idx) => {
              const bestWin = candidate.windows[0];
              return (
                <article key={candidate.region_id} className="cd-candidate-card">
                  <div className="cd-card-top">
                    <div className="cd-rank-title">
                      <span className="cd-rank-badge">#{idx + 1}</span>
                      <div>
                        <strong>{candidate.region_id}</strong>
                        <div style={{ fontSize: 12, color: 'var(--sv-muted, #a6a9b0)' }}>
                          {candidate.lat.toFixed(4)}° {text('enlem', 'latitude')} · {candidate.lon.toFixed(4)}° {text('boylam', 'longitude')}
                        </div>
                      </div>
                    </div>
                    <span className="cd-score-badge">
                      {text('Uygunluk:', 'Suitability:')} {percent(candidate.score, 1)}
                    </span>
                  </div>

                  <dl className="cd-metrics-grid">
                    <div>
                      <dt>{text('Yerel Eğim', 'Local Slope')}</dt>
                      <dd>
                        {candidate.local_slope.slope_deg !== null
                          ? `${candidate.local_slope.slope_deg.toFixed(2)}°`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>{text('Yüzey Kotu', 'Surface Elevation')}</dt>
                      <dd>{candidate.horizon_coverage.surface_elevation_m.toFixed(0)} m</dd>
                    </div>
                    {bestWin && (
                      <>
                        <div>
                          <dt>{text('Güneşlenme', 'Sunlight')}</dt>
                          <dd>
                            {percent(bestWin.sun.sunlight_percentage, 0)} (
                            {bestWin.sun.total_sunlight_hours.toFixed(1)} {text('sa', 'h')})
                          </dd>
                        </div>
                        <div>
                          <dt>{text('Dünya Görünürlüğü', 'Earth Visibility')}</dt>
                          <dd>
                            {percent(bestWin.earth.earth_visible_percentage, 0)} (
                            {bestWin.earth.total_earth_visible_hours.toFixed(1)} {text('sa', 'h')})
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>

                  {bestWin && (
                    <div style={{ fontSize: 11, fontFamily: 'IBM Plex Mono, monospace', color: 'var(--sv-muted, #a6a9b0)' }}>
                      {text('En İyi Pencere:', 'Best Window:')} {bestWin.start_utc.slice(0, 16)} → {bestWin.end_utc.slice(0, 16)} UTC
                    </div>
                  )}

                  <div className="cd-card-actions">
                    {bestWin && (
                      <button
                        className="cd-btn-observe"
                        type="button"
                        onClick={() => handleSelectObservation(candidate, bestWin)}
                      >
                        {text('🔭 Bu Konumu Gözlemle', '🔭 Observe This Location')}
                      </button>
                    )}
                    {bestWin && onApplyToA && (
                      <button type="button" onClick={() => onApplyToA(candidate, bestWin)}>
                        {text('A Noktası Yap', 'Set as Point A')}
                      </button>
                    )}
                    {bestWin && onApplyToB && (
                      <button type="button" onClick={() => onApplyToB(candidate, bestWin)}>
                        {text('B Noktası Yap', 'Set as Point B')}
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
