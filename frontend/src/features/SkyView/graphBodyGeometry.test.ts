import type { SkyBody } from '../../services/skyview';
import { graphEarthPhase, graphLitDiskPath } from './graphBodyGeometry';

const body = (azimuth_deg: number, elevation_deg: number, distance_km: number): SkyBody => ({ azimuth_deg, elevation_deg, distance_km, horizon_elevation_deg: 0, clearance_deg: elevation_deg, center_visible: true, next_transition: null });

test('opposite observer directions give full Earth, same directions give new Earth', () => {
  expect(graphEarthPhase(body(180, 0, 150e6), body(0, 0, 384400))?.fraction).toBeCloseTo(1);
  expect(graphEarthPhase(body(0, 0, 150e6), body(0, 0, 384400))?.fraction).toBeCloseTo(0);
});

test('finite-distance geometry uses Sun minus Earth, not just angular separation', () => {
  const phase = graphEarthPhase(body(90, 0, 3), body(0, 0, 4));
  expect(phase?.cosine).toBeCloseTo(4 / 5);
  expect(phase?.fraction).toBeCloseTo(.9);
  expect(phase?.angle).toBeCloseTo(0);
});

test('projected lighting follows local screen up and azimuth wrap', () => {
  expect(graphEarthPhase(body(0, 45, 150e6), body(0, 0, 384400))?.angle).toBeCloseTo(-90);
  expect(graphEarthPhase(body(90, 20, 150e6), body(360, 10, 384400))?.fraction).toBeCloseTo(graphEarthPhase(body(90, 20, 150e6), body(0, 10, 384400))!.fraction);
});

test('invalid or coincident vectors have no invented phase', () => {
  expect(graphEarthPhase(body(0, 0, 0), body(0, 0, 1))).toBeNull();
  expect(graphEarthPhase(body(NaN, 0, 1), body(0, 0, 1))).toBeNull();
  expect(graphEarthPhase(body(0, 0, 1), body(0, 0, 1))).toBeNull();
});

test('disk terminator handles quarter phase and bounded extremes without NaN', () => {
  expect(graphLitDiskPath(0)).toContain('L0 -1');
  expect(graphLitDiskPath(1)).toContain('A1 1 0 0 1 0 -1');
  expect(graphLitDiskPath(-1)).toContain('A1 1 0 0 0 0 -1');
  expect(graphLitDiskPath(2)).toBe(graphLitDiskPath(1));
});
