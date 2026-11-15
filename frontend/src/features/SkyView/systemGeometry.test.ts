import { DEFAULT_SYSTEM_FOCUS, fitSystem, interpolateSystemCamera, length, reconstructSystem, subtract, systemFocusFit, SystemCameraPose, SYSTEM_RADII_KM, topocentricKm } from './systemGeometry';
import type { SkyBody, SkyPoint } from '../../services/skyview';

const body = (azimuth_deg: number, elevation_deg: number, distance_km: number): SkyBody => ({
  azimuth_deg, elevation_deg, distance_km, horizon_elevation_deg: 0, clearance_deg: elevation_deg,
  center_visible: elevation_deg > 0, next_transition: null,
});
// Analytic fixture, independent of API/SPICE/network and Three.js.
const site = { lat_deg: -80, lon_deg: 15, surface_elevation_m: 2600, observer_height_m: 12 };
const point: SkyPoint = { time_utc: '2026-01-01T00:00:00Z', sun: body(90, 0, 150000000), earth: body(0, 0, 384400) };

it('uses the compass ENU convention in kilometres', () => {
  expect(topocentricKm(body(90, 0, 10))[0]).toBeCloseTo(10);
  expect(topocentricKm(body(0, 0, 10))[2]).toBeCloseTo(-10);
  expect(topocentricKm(body(270, 0, 10))[0]).toBeCloseTo(-10);
  expect(topocentricKm(body(0, 90, 10))[1]).toBeCloseTo(10);
});

it('adds the eye vector, including surface elevation and observer height, before rebasing to Moon centre', () => {
  const result = reconstructSystem(site, point);
  expect(result.moon).toEqual([0, 0, 0]);
  // Local centre = -1740 km, local eye = 0.012 km -> centre-to-eye = 1740.012 km.
  expect(result.observer[1]).toBeCloseTo(1740.012, 8);
  expect(result.earth[1]).toBeCloseTo(1740.012, 8);
  expect(result.earth[2]).toBeCloseTo(-384400, 8);
  expect(length(subtract(result.earth, result.observer))).toBeCloseTo(384400, 6);
  expect(length(subtract(result.sun, result.observer))).toBeCloseTo(150000000, 4);
});

it('calculates distinct Earth-to-Sun and Moon-to-Sun lighting directions', () => {
  const result = reconstructSystem(site, point);
  // Observer Y cancels exactly for Earth-to-Sun, but not Moon-to-Sun.
  expect(result.earthLight[1]).toBeCloseTo(0, 12);
  expect(result.earthLight[2]).toBeCloseTo(384400 / Math.hypot(150000000, 384400), 12);
  expect(result.moonLight[1]).toBeGreaterThan(0);
  expect(result.moonLight).not.toEqual(result.earthLight);
  expect(length(result.planeNormal)).toBeCloseTo(1, 12);
  expect(result.planeNormal.reduce((sum, n, i) => sum + n * result.earth[i], 0)).toBeCloseTo(0, 6);
  expect(result.planeNormal.reduce((sum, n, i) => sum + n * result.sun[i], 0)).toBeCloseTo(0, 6);
});

it('keeps Sun-facing and night-side hemispheres consistent with API azimuth/elevation', () => {
  for (const elevation of [-40, -2, 0, 2, 40]) {
    const sample = { ...point, sun: body(123, elevation, 150000000) };
    const model = reconstructSystem(site, sample);
    // The observer is scene +Y regardless of geographic longitude/latitude.
    // Subtract the observer before comparing topocentric elevation: centre-light
    // and observer-light differ by solar parallax, not a hemisphere reversal.
    const line = subtract(model.sun, model.observer);
    expect(line[1] / length(line)).toBeCloseTo(Math.sin(elevation * Math.PI / 180), 12);
    if (elevation !== 0) expect(Math.sign(model.moonLight[1])).toBe(Math.sign(elevation));
    const oppositeNormal = [0, -1, 0];
    expect(oppositeNormal.reduce((sum, n, i) => sum + n * model.moonLight[i], 0)).toBeCloseTo(-model.moonLight[1], 12);
  }
});

it('keeps a finite camera plane for collinear vectors', () => {
  const result = reconstructSystem({ ...site, surface_elevation_m: -1737400, observer_height_m: 0 }, { ...point, earth: body(90, 0, 384400) });
  expect(result.planeNormal.every(Number.isFinite)).toBe(true);
  expect(length(result.planeNormal)).toBeCloseTo(1);
});

it('fits all true-radius bodies and allows a Moon close-up, including portrait canvases', () => {
  const result = reconstructSystem(site, point);
  const spheres = [ { center: result.moon, radius: SYSTEM_RADII_KM.moon }, { center: result.earth, radius: SYSTEM_RADII_KM.earth }, { center: result.sun, radius: SYSTEM_RADII_KM.sun } ];
  const fit = fitSystem(spheres, 45, 1);
  spheres.forEach(sphere => expect(fit.distance * Math.sin(Math.PI / 8)).toBeGreaterThan(length(subtract(sphere.center, fit.center)) + sphere.radius));
  expect(fitSystem(spheres, 45, 0.5).distance).toBeGreaterThan(fit.distance);
  expect(fitSystem([spheres[0]], 45, 1).distance).toBeLessThan(6000);
});

it('opens on a useful Moon close-up without changing physical radii or positions', () => {
  expect(DEFAULT_SYSTEM_FOCUS).toBe('moon');
  const model = reconstructSystem(site, point);
  const original = JSON.stringify(model);
  const fit = systemFocusFit(DEFAULT_SYSTEM_FOCUS, model, 45, 1)!;
  expect(fit.center).toEqual([0, 0, 0]);
  expect(fit.distance).toBeGreaterThan(SYSTEM_RADII_KM.moon);
  expect(fit.distance).toBeLessThan(6000);
  expect(systemFocusFit('moon', model, 45, 0.5)!.distance).toBeGreaterThan(fit.distance);
  expect(SYSTEM_RADII_KM).toEqual({ moon: 1737.4, earth: 6371, sun: 695700 });
  expect(JSON.stringify(model)).toBe(original);
});

it('navigates between the actual Moon and Earth centers; missing data never invents Earth', () => {
  const model = reconstructSystem(site, point);
  systemFocusFit('earth', model, 45, 1)!.center.forEach((value, i) => expect(value).toBeCloseTo(model.earth[i], 8));
  expect(systemFocusFit('moon', model, 45, 1)!.center).toEqual(model.moon);
  expect(systemFocusFit('all', model, 45, 1)!.distance).toBeGreaterThan(1e8);
  expect(systemFocusFit('earth', null, 45, 1)).toBeNull();
  expect(systemFocusFit('moon', null, 45, 1)!.center).toEqual([0, 0, 0]);
  expect(systemFocusFit('all', null, 45, 1)).toEqual(systemFocusFit('moon', null, 45, 1));
});

it('samples camera navigation continuously and can retarget from its presented pose', () => {
  const from: SystemCameraPose = { target: [0, 0, 0], distance: 5000, yaw: 0, pitch: 0.35 };
  const to: SystemCameraPose = { target: [0, 1700, -384400], distance: 18000, yaw: 1, pitch: 0 };
  const middle = interpolateSystemCamera(from, to, 0.5);
  expect(middle.target).toEqual([0, 850, -192200]);
  expect(middle.distance).toBeCloseTo(Math.sqrt(5000 * 18000));
  expect(middle.yaw).toBeCloseTo(0.5);
  expect(interpolateSystemCamera(middle, from, 0).target).toEqual(middle.target);
  expect(interpolateSystemCamera(middle, from, 0).distance).toBeCloseTo(middle.distance);
  expect(interpolateSystemCamera(from, to, -1).target).toEqual(from.target);
  expect(interpolateSystemCamera(from, to, 2).target).toEqual(to.target);
  expect(interpolateSystemCamera(from, to, 1).distance).toBeCloseTo(to.distance);
  expect(from.target).toEqual([0, 0, 0]);
});

it('rejects corrupt inputs instead of inventing a position', () => {
  expect(() => topocentricKm(body(0, 0, NaN))).toThrow();
  expect(() => topocentricKm(body(0, 91, 1))).toThrow();
  expect(() => reconstructSystem({ ...site, observer_height_m: Infinity }, point)).toThrow();
});
