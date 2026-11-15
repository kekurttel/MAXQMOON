import type { SkyBody, SkyPoint, SkySeries } from '../../services/skyview';

export type Vec3 = [number, number, number];
export type SystemFocus = 'all' | 'moon' | 'earth';
export const DEFAULT_SYSTEM_FOCUS: SystemFocus = 'moon';
export interface SystemCameraPose { target: Vec3; distance: number; yaw: number; pitch: number }
/** Mean spherical Earth radius, matching the panorama's angular-size model. */
export const SYSTEM_RADII_KM = { moon: 1737.4, earth: 6371, sun: 695700 } as const;
const RAD = Math.PI / 180;
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const length = (a: Vec3): number => Math.hypot(...a);
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a: Vec3): Vec3 => length(a) > 1e-12 ? scale(a, 1 / length(a)) : [0, 1, 0];

/** Same right-handed convention as compassDirection: +X east, +Y up, -Z north. */
export function topocentricKm(body: Pick<SkyBody, 'azimuth_deg' | 'elevation_deg' | 'distance_km'>): Vec3 {
  const { azimuth_deg: az, elevation_deg: el, distance_km: d } = body;
  if (![az, el, d].every(Number.isFinite) || d <= 0 || Math.abs(el) > 90) throw new Error('Invalid topocentric body coordinates');
  return [d * Math.cos(el * RAD) * Math.sin(az * RAD), d * Math.sin(el * RAD), -d * Math.cos(el * RAD) * Math.cos(az * RAD)];
}

/** Reconstructed equivalent ENU, NOT an inertial/SPICE frame transform.
 * Surface origin: Moon centre Y=-(1737400+surface_m), eye Y=height_m.
 * Translate both by -Moon centre, then convert metres to kilometres.
 */
export function reconstructSystem(site: SkySeries['site'], point: SkyPoint) {
  if (![site.surface_elevation_m, site.observer_height_m].every(Number.isFinite)) throw new Error('Invalid observer heights');
  const observer: Vec3 = [0, SYSTEM_RADII_KM.moon + (site.surface_elevation_m + site.observer_height_m) / 1000, 0];
  const moon: Vec3 = [0, 0, 0];
  const sun = add(observer, topocentricKm(point.sun));
  const earth = add(observer, topocentricKm(point.earth));
  const normal = cross(earth, sun);
  return { moon, earth, sun, observer, planeNormal: length(normal) > 1e-6 ? unit(normal) : [0, 1, 0] as Vec3,
    moonLight: unit(sun), earthLight: unit(subtract(sun, earth)) };
}

/** A navigation destination changes the camera only; physical spheres stay untouched. */
export function systemFocusFit(focus: SystemFocus, model: ReturnType<typeof reconstructSystem> | null, fovDeg: number, aspect: number) {
  if (focus === 'earth' && !model) return null;
  const moon = { center: [0, 0, 0] as Vec3, radius: SYSTEM_RADII_KM.moon };
  const spheres = focus === 'all' && model
    ? [moon, { center: model.earth, radius: SYSTEM_RADII_KM.earth }, { center: model.sun, radius: SYSTEM_RADII_KM.sun }]
    : focus === 'earth' && model ? [{ center: model.earth, radius: SYSTEM_RADII_KM.earth }] : [moon];
  return fitSystem(spheres, fovDeg, aspect);
}

/** Sample from the last presented pose so navigation can be interrupted/re-targeted. */
export function interpolateSystemCamera(from: SystemCameraPose, to: SystemCameraPose, progress: number): SystemCameraPose {
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * (3 - 2 * t);
  const mix = (a: number, b: number) => a + (b - a) * eased;
  return { target: from.target.map((value, i) => mix(value, to.target[i])) as Vec3,
    distance: Math.exp(mix(Math.log(from.distance), Math.log(to.distance))),
    yaw: mix(from.yaw, to.yaw), pitch: mix(from.pitch, to.pitch) };
}

export function fitSystem(spheres: { center: Vec3; radius: number }[], fovDeg: number, aspect: number) {
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  spheres.forEach(({ center, radius }) => center.forEach((v, i) => {
    low[i] = Math.min(low[i], v - radius); high[i] = Math.max(high[i], v + radius);
  }));
  const center = scale(add(low, high), 0.5);
  const radius = Math.max(...spheres.map(s => length(subtract(s.center, center)) + s.radius));
  const halfFov = Math.min(fovDeg * RAD / 2, Math.atan(Math.tan(fovDeg * RAD / 2) * Math.max(0.01, aspect)));
  return { center, distance: radius / Math.sin(halfFov) * 1.08 };
}
