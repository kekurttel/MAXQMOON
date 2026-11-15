import * as THREE from 'three';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { apparentRadiusRadians, bodyToSunDirection, buildCompassTerrain, compassDirection,
  COMPASS_SKY_DISTANCES_M, COMPASS_TERRAIN_RADII_M, COMPASS_TERRAIN_SEGMENTS,
  createCompassTerrainMaterial, EARTH_MEAN_RADIUS_KM, fitTerrainShadow, LUNAR_RADIUS_M, parseCompassDem, sampleCompassDem } from './compassTerrain';

// Synthetic fixtures are deliberately confined to tests. Production never fabricates DEM data.
function fixture(size = 1201, height: (x: number, y: number) => number = () => 0) {
  const buffer = new ArrayBuffer(24 + size * size * 2), view = new DataView(buffer);
  const center = (size - 1) / 2;
  view.setUint32(0, size, true); view.setUint32(4, size, true);
  [200, center, center, 0.5].forEach((value, index) => view.setFloat32(8 + index * 4, value, true));
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    view.setInt16(24 + (row * size + col) * 2, height((col - center) * 200, (center - row) * 200) * 2, true);
  }
  return { buffer, dem: parseCompassDem(buffer) };
}

test('DEM validates headers, interpolates measured cells, never fills missing coverage', () => {
  expect(() => parseCompassDem(new ArrayBuffer(12))).toThrow('Truncated DEM header');
  const { buffer, dem } = fixture(5, (x, y) => (x + y) / 10);
  expect(sampleCompassDem(dem, 100, 100)).toBe(20);
  expect(sampleCompassDem(dem, 10000, 0)).toBeNull();
  new DataView(buffer).setInt16(24 + (2 * 5 + 2) * 2, -32768, true);
  expect(sampleCompassDem(dem, 0, 0)).toBeNull();
  new DataView(buffer).setFloat32(8, 0, true);
  expect(() => parseCompassDem(buffer)).toThrow('Invalid DEM dimensions or scale');
});

test('ENU directions and actual angular radius preserve physical scale', () => {
  expect(compassDirection(0, 0).distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-12);
  expect(compassDirection(90, 0).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-12);
  expect(compassDirection(0, 90).y).toBeCloseTo(1);
  expect(apparentRadiusRadians(6371, 384400) * 360 / Math.PI).toBeCloseTo(1.899, 2);
  expect(apparentRadiusRadians(1, NaN)).toBe(0);
  expect(apparentRadiusRadians(1, 0.5)).toBe(0);
});

test('Earth lighting subtracts full topocentric position vectors before normalization', () => {
  const sun = { azimuth_deg: 90, elevation_deg: 0, distance_km: 100 };
  const earth = { azimuth_deg: 0, elevation_deg: 0, distance_km: 30 };
  const expected = new THREE.Vector3(100, 0, 30).normalize();
  expect(bodyToSunDirection(sun, earth).distanceTo(expected)).toBeLessThan(1e-12);
  expect(bodyToSunDirection(sun, earth).distanceTo(compassDirection(90, 0))).toBeGreaterThan(0.2);
});

test('all indexed terrain triangles face outward; near and far rings retain lunar curvature', () => {
  const { dem } = fixture();
  const result = buildCompassTerrain(dem, -90, 0, 0);
  expect(result.partial).toBe(false);
  const geometry = result.geometry;
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const indices = geometry.getIndex()!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let minimumFacing = Infinity;
  for (let i = 0; i < indices.count; i += 3) {
    a.fromBufferAttribute(positions, indices.getX(i));
    b.fromBufferAttribute(positions, indices.getX(i + 1));
    c.fromBufferAttribute(positions, indices.getX(i + 2));
    const outward = a.clone().add(new THREE.Vector3(0, LUNAR_RADIUS_M, 0)).normalize();
    minimumFacing = Math.min(minimumFacing, b.sub(a).cross(c.sub(a)).normalize().dot(outward));
  }
  expect(minimumFacing).toBeGreaterThan(0.99);
  expect(normals.getY(0)).toBeGreaterThan(0.99);
  expect(positions.getY(positions.count - 1)).toBeCloseTo(LUNAR_RADIUS_M * (Math.cos(100000 / LUNAR_RADIUS_M) - 1), 2);
  geometry.dispose();
  expect(() => buildCompassTerrain(dem, -90, 0, 1)).toThrow('DEM surface does not match backend elevation');
});

test('nonzero radial datum is subtracted exactly once; API eye height is local, not absolute', () => {
  const { dem } = fixture(1201, () => 1954.5);
  const { geometry, surfaceElevationM } = buildCompassTerrain(dem, -89.4395, -137.1934, 1954.5);
  const positions = geometry.getAttribute('position');
  expect(surfaceElevationM).toBeCloseTo(1954.5);
  expect(positions.getY(0)).toBeCloseTo(0);
  expect(2 - positions.getY(0)).toBeCloseTo(2);
  // A constant radial height is not a flat tangent sheet: retain true spherical sag.
  expect(positions.getY(1)).toBeCloseTo((LUNAR_RADIUS_M + 1954.5) * (Math.cos(50 / LUNAR_RADIUS_M) - 1), 5);
  geometry.dispose();
});

test('non-pole terrain unwraps cyclic UV seams without changing triangles or smooth normals', () => {
  const { dem } = fixture();
  const { geometry, partial, vertexCount } = buildCompassTerrain(dem, -89.4395, -137.1934, 0);
  expect(partial).toBe(false);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv'), indices = geometry.getIndex()!;
  const rings = COMPASS_TERRAIN_RADII_M.length, stride = COMPASS_TERRAIN_SEGMENTS + 1;
  const originalCount = 1 + rings * stride;
  const originalIndices: number[] = [];
  for (let segment = 0; segment < 720; segment++) originalIndices.push(0, segment + 2, segment + 1);
  for (let ring = 0; ring < rings - 1; ring++) for (let segment = 0; segment < 720; segment++) {
    const a = 1 + ring * stride + segment, b = a + 1, c = a + stride;
    originalIndices.push(a, b, c, b, c + 1, c);
  }
  const original = new THREE.BufferGeometry();
  original.setAttribute('position', new THREE.BufferAttribute(
    (positions.array as Float32Array).slice(0, originalCount * 3), 3));
  original.setIndex(originalIndices.map(index => index > 0 && (index - 1) % stride === 720 ? index - 720 : index));
  original.computeVertexNormals();
  const originalNormals = original.getAttribute('normal');
  for (let ring = 0; ring < rings; ring++) {
    const first = 1 + ring * stride, last = first + 720;
    originalNormals.setXYZ(last, originalNormals.getX(first), originalNormals.getY(first), originalNormals.getZ(first));
    expect(new THREE.Vector3().fromBufferAttribute(normals, first)
      .distanceTo(new THREE.Vector3().fromBufferAttribute(normals, last))).toBe(0);
  }
  let maximumSpan = 0, maximumPositionError = 0, maximumNormalError = 0, maximumLatitudeError = 0;
  const duplicated = new Set<number>();
  expect(indices.count).toBe(originalIndices.length);
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const us = [0, 1, 2].map(corner => uv.getX(indices.getX(triangle + corner)));
    maximumSpan = Math.max(maximumSpan, Math.max(...us) - Math.min(...us));
    for (let corner = 0; corner < 3; corner++) {
      const actual = indices.getX(triangle + corner), expected = originalIndices[triangle + corner];
      for (let axis = 0; axis < 3; axis++) {
        maximumPositionError = Math.max(maximumPositionError,
          Math.abs(positions.array[actual * 3 + axis] - positions.array[expected * 3 + axis]));
        maximumNormalError = Math.max(maximumNormalError,
          Math.abs(normals.array[actual * 3 + axis] - originalNormals.array[expected * 3 + axis]));
      }
      maximumLatitudeError = Math.max(maximumLatitudeError, Math.abs(uv.getY(actual) - uv.getY(expected)));
      if (actual >= originalCount) duplicated.add(actual);
    }
  }
  expect(maximumSpan).toBeLessThanOrEqual(0.5);
  expect(maximumPositionError).toBe(0);
  expect(maximumNormalError).toBe(0);
  expect(maximumLatitudeError).toBe(0);
  expect(duplicated.size).toBeGreaterThan(0);
  expect(vertexCount).toBe(positions.count);
  expect(vertexCount - originalCount).toBe(duplicated.size);
  expect(duplicated.size).toBeLessThan(1000);
  original.dispose(); geometry.dispose();
});

test('open DEM keeps outward visible faces but casts from both sides of its zero-thickness sheet', () => {
  const material = createCompassTerrainMaterial();
  expect(material.side).toBe(THREE.FrontSide);
  expect(material.shadowSide).toBe(THREE.DoubleSide);
  // GPU shadow generation itself is deliberately not claimed by this material contract test.
  material.dispose();
});

test.each([0.2, -5, 90, -90])('shadow fit survives Three runtime matrix update at Sun elevation %s', elevation => {
  const { dem } = fixture();
  const { geometry } = buildCompassTerrain(dem, -90, 0, 0);
  const scene = new THREE.Scene(), light = new THREE.DirectionalLight();
  light.position.copy(compassDirection(43, elevation)).multiplyScalar(400000);
  scene.add(light, light.target); scene.updateMatrixWorld(true);
  fitTerrainShadow(light, geometry);
  light.shadow.updateMatrices(light);
  const positions = geometry.getAttribute('position'), vertex = new THREE.Vector3();
  let maximumClip = 0;
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i).project(light.shadow.camera);
    maximumClip = Math.max(maximumClip, Math.abs(vertex.x), Math.abs(vertex.y), Math.abs(vertex.z));
  }
  expect(maximumClip).toBeLessThan(1);
  const towardSun = light.position.clone().sub(light.target.position).normalize();
  expect(towardSun.distanceTo(compassDirection(43, elevation))).toBeLessThan(1e-12);
  light.shadow.dispose(); geometry.dispose();
});

test('low-Sun shadow fit includes all rendered casters, not only a 28 km crop', () => {
  const { dem } = fixture();
  const { geometry } = buildCompassTerrain(dem, -90, 0, 0);
  const light = new THREE.DirectionalLight();
  light.position.copy(compassDirection(43, 0.2)).multiplyScalar(400000);
  light.shadow.mapSize.set(4096, 4096);
  fitTerrainShadow(light, geometry);
  const positions = geometry.getAttribute('position'), vertex = new THREE.Vector3();
  const camera = light.shadow.camera;
  let maximumClip = 0;
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i).project(camera);
    maximumClip = Math.max(maximumClip, Math.abs(vertex.x), Math.abs(vertex.y), Math.abs(vertex.z));
  }
  expect(maximumClip).toBeLessThan(1);
  expect(camera.right - camera.left).toBeGreaterThan(190000);
  expect(light.shadow.needsUpdate).toBe(true);
  light.shadow.dispose(); geometry.dispose();
});

test('a measured DEM ridge intercepts sunlight; a flat fixture does not', () => {
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 2, 0), compassDirection(0, 5), 1, 5000);
  const ridge = fixture(1201, (_x, y) => y >= 800 && y <= 1200 ? 500 : 0);
  const flat = fixture();
  const ridgeTerrain = buildCompassTerrain(ridge.dem, -90, 0, 0);
  const flatTerrain = buildCompassTerrain(flat.dem, -90, 0, 0);
  const material = new THREE.MeshBasicMaterial();
  const ridgeMesh = new THREE.Mesh(ridgeTerrain.geometry, material);
  const flatMesh = new THREE.Mesh(flatTerrain.geometry, material);
  ridgeMesh.updateMatrixWorld(); flatMesh.updateMatrixWorld();
  expect(ray.intersectObject(ridgeMesh).length).toBeGreaterThan(0);
  expect(ray.intersectObject(flatMesh).length).toBe(0);
  ridgeTerrain.geometry.dispose(); flatTerrain.geometry.dispose(); material.dispose();
});

// These markers were independently computed by backend/app/horizon.py::compute_horizon
// against this byte-identical packaged DEM: 200 m radial / 1° azimuth / API eye 2 m.
// A source-artifact regression, not a synthetic crater/terrain claim.
test.each([
  { lat: -89.4395, lon: -137.1934, surface: 1954.314983782483,
    markers: [[0, -1.2705532713042178], [90, -1.2680775856987863], [111, -2.2282591785776287],
      [180, -0.29179430190578115], [270, 0.2093060381757832]] },
  { lat: -89.9, lon: 45, surface: 1299.4090885602277,
    markers: [[0, 0.9046463399632275], [90, 3.4340891151481823], [111, 3.1886258526516946],
      [180, 1.3856836690565675], [270, -2.3555284457328933]] },
])('packaged DEM at $lat / $lon retains API skyline samples without raising the 2 m eye', ({ lat, lon, surface, markers }) => {
  const bytes = readFileSync(path.resolve(process.cwd(), 'public/terrain-data/pole_dem.bin'));
  expect(createHash('sha256').update(bytes).digest('hex'))
    .toBe('940998902349d937387aa7cd151dbdc704b5a820f7261a76daf490a886c9cfcd');
  const dem = parseCompassDem(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const { geometry, surfaceElevationM, vertexCount } = buildCompassTerrain(dem, lat, lon, surface);
  expect(surfaceElevationM).toBeCloseTo(surface, 6);
  expect(vertexCount).toBeLessThan(365000);
  const position = geometry.getAttribute('position'), stride = COMPASS_TERRAIN_SEGMENTS + 1;
  expect(2 - position.getY(0)).toBeCloseTo(2, 9);
  for (const [azimuth, apiElevation] of markers) {
    let highest = -Infinity, controllingRadius = 0;
    COMPASS_TERRAIN_RADII_M.forEach((radius, ring) => {
      const i = 1 + ring * stride + azimuth * 2;
      const elevation = Math.atan2(position.getY(i) - 2, Math.hypot(position.getX(i), position.getZ(i))) * 180 / Math.PI;
      if (elevation > highest) { highest = elevation; controllingRadius = radius; }
    });
    // Float32 geometry precision, not an invented scientific uncertainty bound.
    expect(Math.abs(highest - apiElevation)).toBeLessThan(0.00001);
    if (lat === -89.4395 && azimuth === 111) expect(controllingRadius).toBe(90400);
  }
  geometry.dispose();
});

test('display depths put all Earth surface in front of Sun while preserving true angular radius', () => {
  const earthAngle = apparentRadiusRadians(EARTH_MEAN_RADIUS_KM, 384400);
  const sunAngle = apparentRadiusRadians(695700, 149597870.7);
  const earthRadius = COMPASS_SKY_DISTANCES_M.earth * Math.sin(earthAngle);
  const sunRadius = COMPASS_SKY_DISTANCES_M.sun * Math.sin(sunAngle);
  expect(Math.asin(earthRadius / COMPASS_SKY_DISTANCES_M.earth)).toBe(earthAngle);
  expect(Math.asin(sunRadius / COMPASS_SKY_DISTANCES_M.sun)).toBe(sunAngle);
  expect(COMPASS_SKY_DISTANCES_M.earth + earthRadius)
    .toBeLessThan(COMPASS_SKY_DISTANCES_M.sun - sunRadius);
  expect(COMPASS_SKY_DISTANCES_M.earth - earthRadius).toBeGreaterThan(200000);
});
