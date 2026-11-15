import type { Vec3 } from './systemGeometry';
import type { CompassDem } from './compassTerrain';
import type { SkyHorizon } from '../../services/skyview';

export interface LunarLocation { lat: number; lon: number; name?: string }
export type LocationSlot = 'A' | 'B';
export type MarkedLocations = Partial<Record<LocationSlot, LunarLocation>>;
export type DemSupport = 'supported' | 'outside' | 'nodata' | 'unavailable';
export const LUNAR_REFERENCE_RADIUS_M = 1737400;
export const DEFAULT_GLOBE_SITE: LunarLocation = { lat: -90, lon: 0 };

/** Same spherical MOON_ME_DE421 projection as the calculation backend. */
export function projectLunarSouth(location: LunarLocation): { x: number; y: number } {
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon) || location.lat < -90 || location.lat >= 90) return { x: NaN, y: NaN };
  const rho = 2 * LUNAR_REFERENCE_RADIUS_M * Math.tan((90 + location.lat) * Math.PI / 360);
  const lon = normalizeLongitude(location.lon) * Math.PI / 180;
  return { x: rho * Math.sin(lon), y: rho * Math.cos(lon) };
}
export function inverseLunarSouth(x: number, y: number): LunarLocation {
  return { lat: 2 * Math.atan2(Math.hypot(x, y), 2 * LUNAR_REFERENCE_RADIUS_M) * 180 / Math.PI - 90,
    lon: normalizeLongitude(Math.atan2(x, y) * 180 / Math.PI) };
}
export function measuredDemBounds(dem: Pick<CompassDem, 'rows' | 'cols' | 'sample0' | 'line0' | 'spacing'>) {
  return { x_min: -dem.sample0 * dem.spacing, x_max: (dem.cols - 1 - dem.sample0) * dem.spacing,
    y_min: (dem.line0 - dem.rows + 1) * dem.spacing, y_max: dem.line0 * dem.spacing };
}
/** Closed sample-center bounds and last-cell clamping intentionally match _DEM.sample. */
export function measuredDemSupport(dem: CompassDem | null, location: LunarLocation): DemSupport {
  if (!dem) return 'unavailable';
  const { x, y } = projectLunarSouth(location);
  const row = dem.line0 - y / dem.spacing, col = dem.sample0 + x / dem.spacing;
  if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0 || row > dem.rows - 1 || col > dem.cols - 1) return 'outside';
  const r = Math.min(Math.floor(row), dem.rows - 2), c = Math.min(Math.floor(col), dem.cols - 2);
  return [r * dem.cols + c, r * dem.cols + c + 1, (r + 1) * dem.cols + c, (r + 1) * dem.cols + c + 1]
    .some(index => dem.values.getInt16(index * 2, true) <= -32767) ? 'nodata' : 'supported';
}
/** Densely sampled projected square, not an invented geographic bounding rectangle. */
export function measuredDemBoundary(dem: CompassDem, segments = 64): LunarLocation[] {
  const b = measuredDemBounds(dem), result: LunarLocation[] = [];
  const corners = [[b.x_min, b.y_min], [b.x_max, b.y_min], [b.x_max, b.y_max], [b.x_min, b.y_max]];
  corners.forEach(([x, y], edge) => {
    const next = corners[(edge + 1) % 4];
    for (let i = 0; i < segments; i++) result.push(inverseLunarSouth(x + (next[0] - x) * i / segments, y + (next[1] - y) * i / segments));
  });
  return result;
}
export function measuredDemMatches(dem: CompassDem, provenance: SkyHorizon['provenance']): boolean {
  const bounds = measuredDemBounds(dem);
  return provenance.frame === 'MOON_ME_DE421' && provenance.reference_radius_m === LUNAR_REFERENCE_RADIUS_M &&
    dem.rows === provenance.rows && dem.cols === provenance.cols && dem.spacing === provenance.spacing_m &&
    dem.line0 === provenance.line0 && dem.sample0 === provenance.sample0 && dem.scale === provenance.scale_m &&
    (Object.keys(bounds) as (keyof typeof bounds)[]).every(key => Math.abs(bounds[key] - provenance.bounds_projected_m[key]) < 1e-6);
}
const RAD = Math.PI / 180;
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, value, i) => sum + value * b[i], 0);
export const normalizeLongitude = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;

/** Planetocentric MOON_ME_DE421 east-positive longitude; no IAU_MOON substitution. */
export function lunarFixedUnit({ lat, lon }: LunarLocation): Vec3 {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon)) throw new Error('Geçersiz Ay koordinatı');
  return [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
}
export function lunarLocalBasis(site: LunarLocation) {
  const up = lunarFixedUnit(site);
  const east: Vec3 = [-Math.sin(site.lon * RAD), Math.cos(site.lon * RAD), 0];
  const north: Vec3 = [-Math.sin(site.lat * RAD) * Math.cos(site.lon * RAD), -Math.sin(site.lat * RAD) * Math.sin(site.lon * RAD), Math.cos(site.lat * RAD)];
  return { east, up, north };
}
/** Moon-centred scene axes are east, up, south at the API observer site. */
export function lunarLocationToScene(location: LunarLocation, site: LunarLocation): Vec3 {
  const fixed = lunarFixedUnit(location), basis = lunarLocalBasis(site);
  return [dot(fixed, basis.east), dot(fixed, basis.up), -dot(fixed, basis.north)];
}
export function sceneToLunarLocation(scene: Vec3, site: LunarLocation): LunarLocation {
  const length = Math.hypot(...scene);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error('Geçersiz küre kesişimi');
  const { east, up, north } = lunarLocalBasis(site);
  const fixed = east.map((_, i) => (scene[0] * east[i] + scene[1] * up[i] - scene[2] * north[i]) / length);
  return { lat: Math.atan2(fixed[2], Math.hypot(fixed[0], fixed[1])) / RAD,
    lon: Math.hypot(fixed[0], fixed[1]) < 1e-12 ? normalizeLongitude(site.lon) : normalizeLongitude(Math.atan2(fixed[1], fixed[0]) / RAD) };
}
/** A selectable hit must face an exterior camera, never a far-side exit hit.
 * Coordinates are scene kilometres, matching the reference sphere renderer.
 */
export function visibleLunarSurfaceLocation(origin: Vec3, hit: Vec3, site: LunarLocation, occluders: { center: Vec3; radius: number }[] = []): LunarLocation | null {
  const radius = LUNAR_REFERENCE_RADIUS_M / 1000;
  if (![...origin, ...hit].every(Number.isFinite) || Math.hypot(...origin) <= radius) return null;
  if (dot(hit, origin.map((value, i) => value - hit[i]) as Vec3) <= 0) return null;
  const length = Math.hypot(...hit.map((value, i) => value - origin[i]));
  const direction = hit.map((value, i) => (value - origin[i]) / length) as Vec3;
  for (const body of occluders) {
    const offset = origin.map((value, i) => value - body.center[i]) as Vec3;
    const projection = dot(offset, direction);
    const discriminant = projection * projection - dot(offset, offset) + body.radius * body.radius;
    if (discriminant < 0) continue;
    const entry = -projection - Math.sqrt(discriminant), exit = -projection + Math.sqrt(discriminant);
    if (exit > 0 && Math.max(0, entry) < length) return null;
  }
  return sceneToLunarLocation(hit, site);
}

/** Columns rotate Three SphereGeometry (+Y north, +X lon=0, -Z lon=90)
 * into this site's scene basis. Texture registration is equirectangular only;
 * it is not a measured SPICE texture attitude or pixel-level frame certification. */
export function lunarSphereBasis(site: LunarLocation): [Vec3, Vec3, Vec3] {
  return [lunarLocationToScene({ lat: 0, lon: 0 }, site),
    lunarLocationToScene({ lat: 90, lon: 0 }, site),
    lunarLocationToScene({ lat: 0, lon: -90 }, site)];
}
