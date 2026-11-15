import * as THREE from 'three';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import SystemView from './SystemView';
import { parseCompassDem } from './compassTerrain';
import { lunarLocationToScene, lunarSphereBasis, normalizeLongitude, sceneToLunarLocation, projectLunarSouth, inverseLunarSouth, measuredDemBounds, measuredDemSupport, measuredDemBoundary, measuredDemMatches, visibleLunarSurfaceLocation } from './lunarLocation';
import type { SkyHorizon, SkySeries, SkyPoint } from '../../services/skyview';
jest.mock('three', () => ({ ...jest.requireActual('three'), WebGLRenderer: jest.fn(() => { throw new Error('Test without GPU'); }) }));
afterEach(cleanup);
const closeVector = (actual: number[], expected: number[]) => actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 10));

test('MOON_ME_DE421 observer is scene up, local north is -Z and east +X', () => {
  const site = { lat: -70, lon: 37 };
  closeVector(lunarLocationToScene(site, site), [0, 1, 0]);
  const north = lunarLocationToScene({ lat: -69, lon: 37 }, site);
  expect(north[0]).toBeCloseTo(0, 10); expect(north[2]).toBeLessThan(0);
  const east = lunarLocationToScene({ lat: -70, lon: 38 }, site);
  expect(east[0]).toBeGreaterThan(0);
  closeVector(lunarLocationToScene({ lat: 0, lon: 90 }, { lat: 0, lon: 0 }), [1, 0, 0]);
  closeVector(lunarLocationToScene({ lat: 90, lon: 0 }, { lat: 0, lon: 0 }), [0, 0, -1]);
});

test.each([{ lat: 0, lon: 0 }, { lat: -89.8, lon: 179.9 }, { lat: 90, lon: 44 }, { lat: -90, lon: -99 }])('round trip at arbitrary observer including poles: %p', site => {
  for (const location of [{ lat: 34, lon: -179.999 }, { lat: -85, lon: 180 }, { lat: 0, lon: 179.999 }, { lat: 89.99, lon: -45 }]) {
    const result = sceneToLunarLocation(lunarLocationToScene(location, site).map(x => x * 1737.4) as [number, number, number], site);
    expect(result.lat).toBeCloseTo(location.lat, 7);
    expect(normalizeLongitude(result.lon - location.lon)).toBeCloseTo(0, 7);
  }
  expect(sceneToLunarLocation(lunarLocationToScene({ lat: 90, lon: 25 }, site), site).lat).toBeCloseTo(90, 6);
});

test('sphere orientation registers Three geometry geographic axes before raycasting', () => {
  const site = { lat: -85, lon: 21 };
  const basis = lunarSphereBasis(site).map(v => new THREE.Vector3(...v));
  const matrix = new THREE.Matrix4().makeBasis(basis[0], basis[1], basis[2]);
  expect(matrix.determinant()).toBeCloseTo(1, 10);
  for (const location of [{ lat: 0, lon: 0 }, { lat: 40, lon: 90 }, { lat: -90, lon: 0 }]) {
    const lat = location.lat * Math.PI / 180, lon = location.lon * Math.PI / 180;
    const transformed = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)).applyMatrix4(matrix);
    closeVector(transformed.toArray(), lunarLocationToScene(location, site));
  }
});

test('raycast on the registered sphere returns the intended site, independent of texture UVs', () => {
  const site = { lat: -84.25, lon: 179.75 };
  const columns = lunarSphereBasis(site).map(v => new THREE.Vector3(...v));
  const geometry = new THREE.SphereGeometry(1737.4, 96, 64);
  const material = new THREE.MeshBasicMaterial();
  const moon = new THREE.Mesh(geometry, material);
  moon.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(columns[0], columns[1], columns[2]));
  moon.updateMatrixWorld();
  const hit = new THREE.Raycaster(new THREE.Vector3(0, 4000, 0), new THREE.Vector3(0, -1, 0)).intersectObject(moon)[0];
  expect(hit).toBeDefined();
  const result = sceneToLunarLocation(hit.point.toArray() as [number, number, number], site);
  expect(result.lat).toBeCloseTo(site.lat, 8); expect(result.lon).toBeCloseTo(site.lon, 8);
  geometry.dispose(); material.dispose();
});

test('reference-sphere picking rejects interior exit hits and the occluded hemisphere', () => {
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1737.4), site = { lat: -89, lon: 38 };
  const ray = new THREE.Ray(new THREE.Vector3(0, 4000, 0), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectSphere(sphere, new THREE.Vector3())!;
  const location = visibleLunarSurfaceLocation(ray.origin.toArray() as [number, number, number], hit.toArray() as [number, number, number], site)!;
  expect(location.lat).toBeCloseTo(site.lat, 8); expect(location.lon).toBeCloseTo(site.lon, 8);
  expect(visibleLunarSurfaceLocation([0, 4000, 0], [0, -1737.4, 0], site)).toBeNull();
  const inside = new THREE.Ray(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0));
  const exit = inside.intersectSphere(sphere, new THREE.Vector3())!;
  expect(exit.y).toBeCloseTo(-1737.4);
  expect(visibleLunarSurfaceLocation(inside.origin.toArray() as [number, number, number], exit.toArray() as [number, number, number], site)).toBeNull();
});

test('time scrubbing preserves the scene lifecycle instead of rebuilding the camera', async () => {
  const previousFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => fixtureBuffer() });
  const renderer = THREE.WebGLRenderer as unknown as jest.Mock;
  renderer.mockReset();
  renderer.mockImplementation(() => { throw new Error('Test without GPU'); });
  const site = { lat_deg: -89, lon_deg: 0, surface_elevation_m: 0, observer_height_m: 2 };
  const body = { azimuth_deg: 90, elevation_deg: 1, distance_km: 150000000, horizon_elevation_deg: 0, clearance_deg: 1, center_visible: true, next_transition: null };
  const first: SkyPoint = { time_utc: '2026-11-15T00:00:00Z', sun: body, earth: { ...body, distance_km: 384400 } };
  const second: SkyPoint = { ...first, time_utc: '2026-11-15T01:00:00Z' };
  const series = { site, horizon: {} } as SkySeries;
  try {
    // GPU creation deliberately fails; count effect setup attempts, not physical output.
    const view = render(React.createElement(SystemView, { series, point: first }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    // Initial setup and the async DEM arrival both precede the scrub assertion.
    await waitFor(() => expect(renderer).toHaveBeenCalledTimes(2));
    const setups = renderer.mock.calls.length;
    view.rerender(React.createElement(SystemView, { series, point: second }));
    expect(renderer).toHaveBeenCalledTimes(setups);
    view.rerender(React.createElement(SystemView, { series: { ...series, site: { ...site, lon_deg: 1 } }, point: second }));
    expect(renderer).toHaveBeenCalledTimes(setups + 1);
  } finally { global.fetch = previousFetch; }
});

test('invalid inputs fail explicitly; longitude wraps at dateline', () => {
  expect(normalizeLongitude(540)).toBe(-180);
  expect(() => lunarLocationToScene({ lat: 91, lon: 0 }, { lat: 0, lon: 0 })).toThrow();
  expect(() => sceneToLunarLocation([0, 0, 0], { lat: 0, lon: 0 })).toThrow();
});

// Synthetic 5x6 fixture only: deliberately not the packaged dimensions/origins.
function fixtureBuffer() {
  const buffer = new ArrayBuffer(24 + 5 * 6 * 2), header = new DataView(buffer);
  header.setUint32(0, 5, true); header.setUint32(4, 6, true);
  [125, 2.25, 2.5, 0.5].forEach((value, i) => header.setFloat32(8 + i * 4, value, true));
  return buffer;
}
test('south-polar projection round trips dateline, arbitrary longitudes and the pole', () => {
  for (const location of [{ lat: -88.12345, lon: 12.34567 }, { lat: -86, lon: -180 }, { lat: -89, lon: 540 }]) {
    const p = projectLunarSouth(location), result = inverseLunarSouth(p.x, p.y);
    expect(result.lat).toBeCloseTo(location.lat, 10);
    expect(normalizeLongitude(result.lon - location.lon)).toBeCloseTo(0, 10);
  }
  expect(measuredDemSupport(parseCompassDem(fixtureBuffer()), { lat: -90, lon: 179 })).toBe('supported');
  expect(sceneToLunarLocation([0, 1, 0], { lat: -90, lon: 47 }).lon).toBe(47);
  expect(measuredDemSupport(parseCompassDem(fixtureBuffer()), { lat: 90, lon: 0 })).toBe('outside');
});
test('finite measured bounds derive from header and reject outside/nodata, not catalog membership', () => {
  const dem = parseCompassDem(fixtureBuffer());
  const bounds = measuredDemBounds(dem);
  expect(bounds).toEqual({ x_min: -312.5, x_max: 312.5, y_min: -218.75, y_max: 281.25 });
  expect(measuredDemSupport(dem, inverseLunarSouth(123.45, 45.67))).toBe('supported');
  expect(measuredDemSupport(dem, inverseLunarSouth(312.51, 0))).toBe('outside');
  expect(measuredDemSupport(dem, { lat: 0, lon: 0 })).toBe('outside');
  expect(measuredDemSupport(null, { lat: -90, lon: 0 })).toBe('unavailable');
  // Four required corners, including a corner whose interpolation weight is zero.
  for (const index of [2 * 6 + 2, 2 * 6 + 3, 3 * 6 + 2, 3 * 6 + 3]) {
    dem.values.setInt16(index * 2, -32767, true);
    expect(measuredDemSupport(dem, { lat: -90, lon: 0 })).toBe('nodata');
    dem.values.setInt16(index * 2, 0, true);
  }
});
test('boundary is the inverse-projected grid perimeter, including last sample center', () => {
  const dem = parseCompassDem(fixtureBuffer()), bounds = measuredDemBounds(dem);
  const boundary = measuredDemBoundary(dem, 4);
  expect(boundary).toHaveLength(16);
  boundary.forEach((location, index) => {
    const p = projectLunarSouth(location), edge = Math.floor(index / 4);
    expect(edge === 0 ? p.y : edge === 1 ? p.x : edge === 2 ? p.y : p.x)
      .toBeCloseTo(edge === 0 ? bounds.y_min : edge === 1 ? bounds.x_max : edge === 2 ? bounds.y_max : bounds.x_min, 6);
  });
  // Exact last-cell clamping, with inverse-projection rounding kept out of the assertion.
  const centered = { ...dem, line0: 0, sample0: 0 };
  expect(measuredDemSupport(centered, { lat: -90, lon: 0 })).toBe('supported');
  const lastCenter = { ...dem, line0: dem.rows - 1, sample0: dem.cols - 1 };
  expect(measuredDemSupport(lastCenter, { lat: -90, lon: 0 })).toBe('supported');
});
test('API metadata must describe the loaded measured file header and frame', () => {
  const dem = parseCompassDem(fixtureBuffer());
  const provenance = { frame: 'MOON_ME_DE421', reference_radius_m: 1737400, rows: dem.rows, cols: dem.cols,
    spacing_m: dem.spacing, line0: dem.line0, sample0: dem.sample0, scale_m: dem.scale,
    bounds_projected_m: measuredDemBounds(dem) } as SkyHorizon['provenance'];
  expect(measuredDemMatches(dem, provenance)).toBe(true);
  expect(measuredDemMatches(dem, { ...provenance, spacing_m: 40 })).toBe(false);
  expect(measuredDemMatches(dem, { ...provenance, frame: 'IAU_MOON' })).toBe(false);
});
test('single global draft requires explicit apply; unsupported selection never reuses a supported location', async () => {
  (THREE.WebGLRenderer as unknown as jest.Mock).mockImplementation(() => { throw new Error('Test without GPU'); });
  const previousFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => fixtureBuffer() });
  const panorama = jest.fn(), reject = jest.fn();
  try {
    render(React.createElement(SystemView, { series: null, point: null, onEnterPanorama: panorama, onRejectLocation: reject,
      catalogSites: [{ id: 'custom-test', name: 'Test iç nokta', lat: -89.999, lon: 12.34567 }, { id: 'outside-test', name: 'Test dış nokta', lat: 0, lon: 0 }] }));
    await act(async () => {});
    expect(screen.queryByText('A noktası')).toBeNull();
    expect(screen.queryByText('DEM alanına odaklan')).toBeNull();
    fireEvent.change(screen.getByLabelText('Katalogdan Ay konumu seç'), { target: { value: 'custom-test' } });
    expect(panorama).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Bu noktayı gözle'));
    expect(panorama).toHaveBeenLastCalledWith({ lat: -89.999, lon: 12.34567, name: 'Test iç nokta' });
    fireEvent.change(screen.getByLabelText('Katalogdan Ay konumu seç'), { target: { value: 'outside-test' } });
    expect(screen.getByText('0.00000°, 0.00000°')).toBeTruthy();
    expect(screen.getByText('Bu konum için arazi verisi yok.')).toBeTruthy();
    fireEvent.click(screen.getByText('Bu noktayı gözle'));
    expect(panorama).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledWith({ lat: 0, lon: 0, name: 'Test dış nokta' }, 'Bu konum için ayrıntılı arazi verisi yok; mevcut veri güney kutbunu kapsıyor.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  } finally { global.fetch = previousFetch; }
});

test('nearer Earth occludes a lunar pick; Earth behind Moon or off ray does not', () => {
  const origin: [number, number, number] = [0, 20000, 0], hit: [number, number, number] = [0, 1737.4, 0];
  const site = { lat: -89, lon: 38 };
  expect(visibleLunarSurfaceLocation(origin, hit, site, [{ center: [0, 10000, 0], radius: 6371 }])).toBeNull();
  expect(visibleLunarSurfaceLocation(origin, hit, site, [{ center: [0, -10000, 0], radius: 6371 }])).not.toBeNull();
  expect(visibleLunarSurfaceLocation(origin, hit, site, [{ center: [10000, 10000, 0], radius: 6371 }])).not.toBeNull();
});
