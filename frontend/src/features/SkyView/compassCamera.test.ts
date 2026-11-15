import * as THREE from 'three';
import { DEFAULT_TERRAIN_EXPOSURE, initialTerrainFraming, localOrbitPosition, MAX_CAMERA_ALTITUDE_M, stepCameraAltitude, terrainInspectionFill, terrainInspectionFraming } from './compassCamera';

test('initial framing retains measured skyline and foreground without raising the eye', () => {
  const frame = initialTerrainFraming([0, 90, 263], [-1.27, -2.61, 0.2179]);
  expect(frame.heading).toBe(263);
  expect(frame.pitch).toBeCloseTo(-9.7821);
  expect(initialTerrainFraming([], [])).toEqual({ heading: 0, pitch: -10 });
  expect(initialTerrainFraming([0, 450], [NaN, 80])).toEqual({ heading: 90, pitch: 70 });
  expect(initialTerrainFraming([0], [-40]).pitch).toBe(-50);
  expect(initialTerrainFraming([0], [0], 12).pitch).toBeCloseTo(-2.4);
  expect(initialTerrainFraming([NaN], [10], NaN)).toEqual({ heading: 0, pitch: -10 });
});

test('modest exposure never implicitly enables nonphysical night fill', () => {
  expect(DEFAULT_TERRAIN_EXPOSURE).toBe(1.22);
  expect(terrainInspectionFill(false, 0.3)).toBe(0);
  expect(terrainInspectionFill(true, 0.08)).toBe(0.08);
  expect(terrainInspectionFill(true, 10)).toBe(0.3);
  expect(terrainInspectionFill(true, NaN)).toBe(0);
});

test('altitude remains at or above actual API eye; zero increase means 2 m, not ground zero', () => {
  expect(stepCameraAltitude(2, 0, 2)).toBe(2);
  expect(stepCameraAltitude(2, -1000, 2)).toBe(2);
  expect(stepCameraAltitude(2, 160, 2)).toBeGreaterThan(30);
  expect(stepCameraAltitude(0, -1000)).toBe(0);
  expect(stepCameraAltitude(30000, 1000)).toBe(MAX_CAMERA_ALTITUDE_M);
  expect(stepCameraAltitude(stepCameraAltitude(500, 160), -160)).toBeCloseTo(500);
  expect(stepCameraAltitude(NaN, Infinity, 2)).toBe(2);
});

test('inspection fits measured local neighborhood and accounts for portrait FOV', () => {
  const geometry = new THREE.BufferGeometry();
  const coordinates = [-4000, -1000, -4000, 4000, 1000, 4000, 90000, 10000, 0];
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3));
  const before = Array.from(geometry.getAttribute('position').array);
  const landscape = terrainInspectionFraming(geometry, 2, 263);
  const portrait = terrainInspectionFraming(geometry, 0.5, 263);
  expect(landscape.target.toArray()).toEqual([0, 0, 0]); // far terrain does not displace local target
  expect(portrait.distance).toBeGreaterThan(landscape.distance);
  for (const [fit, aspect] of [[landscape, 2], [portrait, 0.5]] as const) {
    const halfVertical = THREE.MathUtils.degToRad(65 / 2);
    const halfFov = Math.min(halfVertical, Math.atan(Math.tan(halfVertical) * aspect));
    expect(fit.distance * Math.sin(halfFov)).toBeGreaterThan(Math.hypot(4000, 1000, 4000));
    expect(fit.elevation).toBeCloseTo(Math.PI / 4);
  }
  expect(Array.from(geometry.getAttribute('position').array)).toEqual(before);
  expect(terrainInspectionFraming(geometry, 0.01, 0).limited).toBe(true);
  expect(terrainInspectionFraming(geometry, NaN, NaN).distance).toBeGreaterThan(0);
  geometry.dispose();
});

test('local orbit uses metre distances and selected DEM height, without moving target', () => {
  const point = localOrbitPosition(0, Math.PI / 6, 12000, 40);
  expect(point.x).toBeCloseTo(0);
  expect(point.y).toBeCloseTo(6040);
  expect(point.z).toBeLessThan(0);
  expect(Math.hypot(point.x, point.y - 40, point.z)).toBeCloseTo(12000);
});
