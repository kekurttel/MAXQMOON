import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import GraphBodyIcon from './GraphBodyIcon';
import { graphEarthPhase } from './graphBodyGeometry';
import './SkyViewGraph.css';
import type { SkyBody, SkyPoint, SkySeries } from '../../services/skyview';
import { useI18n } from '../../i18n';
import { autoElevationRange, azimuthToX, elevationToY, elevationTicks, FULL_ELEVATION, markerXs, skylinePath, terrainPath } from './skyGeometry';

interface SkyViewGraphProps { series: SkySeries; point: SkyPoint }
const LEFT = 64;
const TOP = 18;
const AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315, 360];
const DIRECTIONS: Record<number, { tr: string; en: string }> = { 0: { tr: 'K', en: 'N' }, 90: { tr: 'D', en: 'E' }, 180: { tr: 'G', en: 'S' }, 270: { tr: 'B', en: 'W' }, 360: { tr: 'K', en: 'N' } };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function SkyViewGraph({ series, point }: SkyViewGraphProps) {
  const { t, language } = useI18n();
  const id = useId().replace(/:/g, '');
  const plotRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1000, height: 520 });
  // Match the SVG coordinate system to its actual stage. A fixed 1000 × 520
  // viewBox letterboxes short desktop stages and shrinks every label on phones.
  useLayoutEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setViewport({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const PLOT_WIDTH = Math.max(1, viewport.width - LEFT - 24);
  const PLOT_HEIGHT = Math.max(1, viewport.height - TOP - 66);
  const [fullScale, setFullScale] = useState(false);
  const range = useMemo(() => fullScale ? FULL_ELEVATION : autoElevationRange(series.horizon, [point.sun.elevation_deg, point.earth.elevation_deg]), [fullScale, series.horizon, point.sun.elevation_deg, point.earth.elevation_deg]);
  const paths = useMemo(() => ({ skyline: skylinePath(series.horizon, PLOT_WIDTH, PLOT_HEIGHT, range), terrain: terrainPath(series.horizon, PLOT_WIDTH, PLOT_HEIGHT, range) }), [series.horizon, range, PLOT_WIDTH, PLOT_HEIGHT]);
  const earthPhase = useMemo(() => graphEarthPhase(point.sun, point.earth), [point.sun, point.earth]);
  const sunName = t('sunLabel'), earthName = t('earthLabel');
  const visibleText = t('visibleStatus'), blockedText = t('invisibleTerrainStatus');
  const bodies: { body: SkyBody; name: string; kind: 'sun' | 'earth'; color: string }[] = [
    { body: point.sun, name: sunName, kind: 'sun', color: '#f5c75e' },
    { body: point.earth, name: earthName, kind: 'earth', color: '#78b8f3' },
  ];
  return <section className="sv-graph" aria-label={t('graphAriaLabel')}>
    <header className="sv-graph-header"><div><h2>{t('graphTitle')}</h2><p>{t('graphSubtitle')}</p></div><label className="sv-scale-control"><input type="checkbox" checked={fullScale} onChange={event => setFullScale(event.target.checked)} />{t('fullScaleLabel')}</label></header>
    <div className="sv-scale-note"><span>{fullScale ? t('fullScaleLabel') : t('autoYScaleLabel')}</span><strong>{range.min}° – +{range.max}°</strong><small>{t('azimuthRange')}</small></div>
    <div ref={plotRef} className="sv-plot-scroll" role="region" aria-label={t('graphRegionLabel')} tabIndex={0}><svg className="sv-sky-svg" viewBox={`0 0 ${viewport.width} ${viewport.height}`} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>{t('graphSvgTitle')}</title>
      <desc id={`${id}-desc`}>{point.time_utc}. {t('graphYAxis')} {range.min}° – {range.max}°. {bodies.map(({ body, name }) => `${name}: ${body.elevation_deg.toFixed(2)}°, ${body.center_visible ? visibleText : blockedText}.`).join(' ')} {t('graphDashedCenter')}</desc>
      <defs>
        <clipPath id={`${id}-clip`}><rect width={PLOT_WIDTH} height={PLOT_HEIGHT} /></clipPath>
        <pattern id={`${id}-terrain`} width="12" height="12" patternUnits="userSpaceOnUse"><path d="M0 12 12 0" stroke="var(--sv-terrain-edge, #aebbc7)" strokeWidth="0.6" opacity="0.12" /></pattern>
      </defs>
      <g transform={`translate(${LEFT} ${TOP})`}>
        <g clipPath={`url(#${id}-clip)`}>
          <g aria-hidden="true" data-layer="decorative-noncatalog-stars" className="sv-graph-stars">
            {Array.from({ length: 72 }, (_, i) => <circle key={i} cx={((i * 137 + 41) % 997) / 997 * PLOT_WIDTH} cy={((i * 83 + 17) % 431) / 431 * PLOT_HEIGHT} r={i % 9 === 0 ? 1.15 : .65} opacity={i % 3 === 0 ? .6 : .28} />)}
          </g>
          {AZIMUTHS.map(tick => <line key={`x-${tick}`} x1={azimuthToX(tick, PLOT_WIDTH)} x2={azimuthToX(tick, PLOT_WIDTH)} y1="0" y2={PLOT_HEIGHT} stroke="var(--sv-grid, #25313d)" strokeDasharray={tick % 90 ? '2 6' : undefined} />)}
          {elevationTicks(range).map(tick => <line key={`y-${tick}`} x1="0" x2={PLOT_WIDTH} y1={elevationToY(tick, PLOT_HEIGHT, range)} y2={elevationToY(tick, PLOT_HEIGHT, range)} stroke={tick === 0 ? 'var(--sv-axis, #82929f)' : 'var(--sv-grid, #25313d)'} strokeDasharray={tick === 0 ? '6 5' : undefined} />)}
          <g data-layer="bodies-behind-terrain">{bodies.map(({ body, name, kind }) => <g key={name}>{markerXs(body.azimuth_deg, PLOT_WIDTH, 20).map((x, i) => <g key={i} opacity={body.center_visible ? 1 : .25}><GraphBodyIcon kind={kind} id={`${id}-${kind}-${i}`} x={x} y={elevationToY(body.elevation_deg, PLOT_HEIGHT, range)} phase={earthPhase} /></g>)}</g>)}</g>
          <path data-layer="terrain" d={paths.terrain} fill="var(--sv-terrain, #3d4852)" />
          <path d={paths.terrain} fill={`url(#${id}-terrain)`} />
          <path d={paths.skyline} fill="none" stroke="var(--sv-terrain-edge, #aebbc7)" strokeWidth="1.8" strokeLinejoin="round" />
          <text x="18" y={PLOT_HEIGHT - 18} fill="var(--sv-ink, #c5d0dc)" fontSize="12">LOLA DEM · {t('terrainBelowHorizon')}</text>
          {bodies.map(({ body, name, color, kind }, index) => {
            const x = azimuthToX(body.azimuth_deg, PLOT_WIDTH);
            const y = elevationToY(body.elevation_deg, PLOT_HEIGHT, range);
            const width = Math.min(body.center_visible ? 174 : 260, PLOT_WIDTH - 16);
            const height = body.center_visible ? 66 : 84;
            const labelX = clamp(x > PLOT_WIDTH * .65 ? x - width - 18 : x + 18, 8, PLOT_WIDTH - width - 8);
            const labelY = clamp(index === 0 ? y - height - 20 : y + 22, 8, PLOT_HEIGHT - height - 8);
            const statusColor = body.center_visible ? 'var(--sv-positive, #89dfac)' : 'var(--sv-negative, #ff9393)';
            return <g key={name} data-body={name}>
              {!body.center_visible && markerXs(body.azimuth_deg, PLOT_WIDTH, 14).map((copyX, i) => <g key={i}><circle cx={copyX} cy={y} r="11" fill="none" stroke={color} strokeWidth="1.8" strokeDasharray="3 3" /><path d={`M${copyX - 4},${y}h8 M${copyX},${y - 4}v8`} stroke={color} /></g>)}
              <path d={`M${x},${y} L${labelX + (x > labelX + width ? width : 0)},${labelY + height / 2}`} fill="none" stroke={statusColor} strokeWidth="1.2" strokeDasharray={body.center_visible ? undefined : '4 4'} opacity="0.65" />
              <rect x={labelX} y={labelY} width={width} height={height} rx="8" fill="var(--sv-card, #101820)" stroke="var(--sv-border, #35434f)" />
              <GraphBodyIcon kind={kind} id={`${id}-${kind}-label`} x={labelX + 16} y={labelY + 21} radius={7} phase={earthPhase} />
              <text x={labelX + 28} y={labelY + 26} fill="var(--sv-ink, #c5d0dc)" fontSize="17" fontWeight="600">{name}<tspan fill="var(--sv-muted, #b0bdca)" fontSize="13" fontWeight="400"> · {body.elevation_deg.toFixed(2)}°</tspan></text>
              <text x={labelX + 14} y={labelY + 50} fill={statusColor} fontSize="16" fontWeight="600">{body.center_visible ? visibleText : language === 'tr' ? 'GÖRÜNMÜYOR /' : 'NOT VISIBLE /'}{!body.center_visible && <tspan x={labelX + 14} dy="19">{language === 'tr' ? 'ARAZİ ARKASINDA' : 'BEHIND TERRAIN'}</tspan>}</text>
            </g>;
          })}
        </g>
        <rect width={PLOT_WIDTH} height={PLOT_HEIGHT} fill="none" stroke="var(--sv-border, #35434f)" />
        {elevationTicks(range).map(tick => <text key={tick} x="-12" y={elevationToY(tick, PLOT_HEIGHT, range) + 4} textAnchor="end" fill="var(--sv-muted, #b0bdca)" fontSize="13">{tick > 0 ? '+' : ''}{tick}°</text>)}
        {AZIMUTHS.filter(tick => viewport.width >= 600 || tick % 90 === 0).map(tick => <text key={tick} x={azimuthToX(tick, PLOT_WIDTH)} y={PLOT_HEIGHT + 25} textAnchor="middle" fill="var(--sv-muted, #b0bdca)" fontSize="12">{tick}°{DIRECTIONS[tick] ? ` ${DIRECTIONS[tick][language]}` : ''}</text>)}
        <text x={PLOT_WIDTH / 2} y={PLOT_HEIGHT + 53} textAnchor="middle" fill="var(--sv-muted, #97a8b8)" fontSize="12">{t('graphAzimuthAxis')}</text>
        <text transform={`translate(-47 ${PLOT_HEIGHT / 2}) rotate(-90)`} textAnchor="middle" fill="var(--sv-muted, #97a8b8)" fontSize="12">{t('graphElevationAxis')}</text>
      </g>
    </svg></div>
    <p className="sv-graph-caption">{t('graphCaption')}</p>
    <details className="sv-graph-details"><summary><span className="sv-graph-moon" aria-hidden="true" style={{ '--sv-graph-moon-texture': `url("${process.env.PUBLIC_URL}/textures/moon-lroc-2k.jpg")` } as React.CSSProperties} />{t('graphContextSummary')}</summary><p className="sv-graph-context">{t('graphContextNote')}</p><p className="sv-graph-art-credit">{earthPhase ? t('earthPhaseInfo').replace('{percent}', String(Math.round(earthPhase.fraction * 100))) : t('earthPhaseUnavailable')} {t('graphTextureNote')} · <a href={`${process.env.PUBLIC_URL}/textures/SOURCES.md`}>{t('graphSourceLimits')}</a>.</p></details>
  </section>;
}

export { SkyViewGraph };
