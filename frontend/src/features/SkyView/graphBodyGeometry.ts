import type { SkyBody } from '../../services/skyview';

type Vector = [number, number, number];
const dot = (a: Vector, b: Vector) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const radians = (degrees: number) => degrees * Math.PI / 180;
const position = (body: SkyBody): Vector => {
  const az = radians(body.azimuth_deg), el = radians(body.elevation_deg);
  // Local east, north, up; both bodies use the same API observer frame.
  return [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)].map(v => v * body.distance_km) as Vector;
};

/** Geometric Earth illumination, not an attitude/cloud/atmosphere model. */
export function graphEarthPhase(sun: SkyBody, earth: SkyBody): { cosine: number; angle: number; fraction: number } | null {
  if (![sun, earth].every(body => [body.azimuth_deg, body.elevation_deg, body.distance_km].every(Number.isFinite) && body.distance_km > 0)) return null;
  const s = position(sun), e = position(earth);
  const light = s.map((value, i) => value - e[i]) as Vector;
  const length = Math.hypot(...light);
  if (!length) return null;
  const unitLight = light.map(v => v / length) as Vector;
  const towardObserver = e.map(v => -v / earth.distance_km) as Vector;
  const cosine = Math.max(-1, Math.min(1, dot(unitLight, towardObserver)));
  const az = radians(earth.azimuth_deg), el = radians(earth.elevation_deg);
  const right: Vector = [Math.cos(az), -Math.sin(az), 0];
  const up: Vector = [-Math.sin(el) * Math.sin(az), -Math.sin(el) * Math.cos(az), Math.cos(el)];
  return { cosine, fraction: (1 + cosine) / 2, angle: Math.atan2(-dot(unitLight, up), dot(unitLight, right)) * 180 / Math.PI };
}

/** Unit disk illuminated hemisphere, sunlight projected toward screen right. */
export function graphLitDiskPath(cosine: number): string {
  const c = Math.max(-1, Math.min(1, cosine));
  return `M0 -1 A1 1 0 0 1 0 1 ${Math.abs(c) < 1e-8 ? 'L0 -1' : `A${Math.abs(c)} 1 0 0 ${c >= 0 ? 1 : 0} 0 -1`} Z`;
}
