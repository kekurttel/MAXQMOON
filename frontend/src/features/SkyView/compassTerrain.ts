import * as THREE from 'three';

export const LUNAR_RADIUS_M = 1737400;
const RAD = Math.PI / 180;
/** Finite mesh budget: 503 rings × 721 rays, about 363k vertices / 724k triangles.
 * Radial samples include every API 200 m sample; azimuth remains 0.5°, not 200 m
 * cross-track detail (about 873 m at 100 km). Neither adds DEM measurements.
 */
export const COMPASS_TERRAIN_SEGMENTS = 720;
export const COMPASS_TERRAIN_RADII_M = [50, 100, 150,
  ...Array.from({ length: 500 }, (_, index) => (index + 1) * 200)];
/** Separate display depths preserve angular size and Earth-before-Sun occultation.
 * Both remain behind the entire 100 km DEM, including camera inspection offsets.
 */
export const COMPASS_SKY_DISTANCES_M = { earth: 250000, sun: 500000 } as const;
export const EARTH_MEAN_RADIUS_KM = 6371;

export interface CompassDem {
  rows: number;
  cols: number;
  spacing: number;
  line0: number;
  sample0: number;
  scale: number;
  values: DataView;
}

/** The packaged LOLA export; all header fields and samples are little-endian. */
export function parseCompassDem(buffer: ArrayBuffer): CompassDem {
  if (buffer.byteLength < 24) throw new Error('Truncated DEM header');
  const header = new DataView(buffer);
  const rows = header.getUint32(0, true), cols = header.getUint32(4, true);
  const spacing = header.getFloat32(8, true), line0 = header.getFloat32(12, true);
  const sample0 = header.getFloat32(16, true), scale = header.getFloat32(20, true);
  if (rows < 2 || cols < 2 || buffer.byteLength !== 24 + rows * cols * 2 ||
      ![spacing, line0, sample0, scale].every(Number.isFinite) || spacing <= 0 || scale <= 0) {
    throw new Error('Invalid DEM dimensions or scale');
  }
  return { rows, cols, spacing, line0, sample0, scale, values: new DataView(buffer, 24) };
}

/** South stereographic MOON_ME_DE421 coordinates. Never extrapolates missing data. */
export function sampleCompassDem(dem: CompassDem, x: number, y: number): number | null {
  const col = dem.sample0 + x / dem.spacing, row = dem.line0 - y / dem.spacing;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  const c = Math.floor(col), r = Math.floor(row);
  if (c < 0 || r < 0 || c + 1 >= dem.cols || r + 1 >= dem.rows) return null;
  const heights = [r * dem.cols + c, r * dem.cols + c + 1,
    (r + 1) * dem.cols + c, (r + 1) * dem.cols + c + 1]
    .map(index => dem.values.getInt16(index * 2, true));
  if (heights.some(height => height <= -32767)) return null;
  const a = col - c, b = row - r;
  return dem.scale * (heights[0] * (1 - a) * (1 - b) + heights[1] * a * (1 - b) +
    heights[2] * (1 - a) * b + heights[3] * a * b);
}

export function compassDirection(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = azimuthDeg * RAD, el = elevationDeg * RAD;
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}

export function apparentRadiusRadians(radiusKm: number, distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= radiusKm) return 0;
  return Math.asin(radiusKm / distanceKm);
}

/** Unit incident-light direction at a body, from topocentric vectors in the same ENU frame.
 * Subtract vectors before normalization: Earth phase is not the observer's Sun direction.
 */
export function bodyToSunDirection(
  sun: { azimuth_deg: number; elevation_deg: number; distance_km: number },
  body: { azimuth_deg: number; elevation_deg: number; distance_km: number },
): THREE.Vector3 {
  if (![sun.distance_km, body.distance_km, sun.azimuth_deg, sun.elevation_deg,
    body.azimuth_deg, body.elevation_deg].every(Number.isFinite) ||
    sun.distance_km <= 0 || body.distance_km <= 0) return new THREE.Vector3();
  return compassDirection(sun.azimuth_deg, sun.elevation_deg).multiplyScalar(sun.distance_km)
    .sub(compassDirection(body.azimuth_deg, body.elevation_deg).multiplyScalar(body.distance_km)).normalize();
}

/** Fit the directional shadow camera to *all* rendered DEM vertices, including remote
 * ridges. A square local crop loses low-Sun casters. Fit in light space instead.
 * This is still a finite-resolution, finite-coverage shadow map, not horizon certification.
 */
export function fitTerrainShadow(light: THREE.DirectionalLight, geometry: THREE.BufferGeometry): void {
  const camera = light.shadow.camera;
  camera.position.copy(light.position);
  camera.up.set(0, 1, 0);
  if (Math.abs(light.position.clone().sub(light.target.position).normalize().y) > 0.99) camera.up.set(0, 0, 1);
  camera.lookAt(light.target.position);
  camera.updateMatrixWorld(true);
  const position = geometry.getAttribute('position');
  const vertex = new THREE.Vector3();
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  let near = Infinity, far = -Infinity;
  for (let index = 0; index < position.count; index++) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(camera.matrixWorldInverse);
    left = Math.min(left, vertex.x); right = Math.max(right, vertex.x);
    bottom = Math.min(bottom, vertex.y); top = Math.max(top, vertex.y);
    near = Math.min(near, -vertex.z); far = Math.max(far, -vertex.z);
  }
  const margin = 200;
  Object.assign(camera, { left: left - margin, right: right + margin, bottom: bottom - margin,
    top: top + margin, near: Math.max(1, near - margin), far: far + margin });
  camera.updateProjectionMatrix();
  light.shadow.needsUpdate = true;
}

/** An open DEM sheet has no underside shell. Three's default BackSide shadow
 * material culls its Sun-facing triangles, losing ridge shadows. Render both
 * sides into the shadow map, while retaining outward-only visible rendering.
 */
export function createCompassTerrainMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xbcb9b3, roughness: 1, metalness: 0 });
  material.shadowSide = THREE.DoubleSide;
  return material;
}

export interface CompassTerrain {
  geometry: THREE.BufferGeometry;
  surfaceElevationM: number;
  partial: boolean;
  vertexCount: number;
}

/** Concentric geodesic rings: 50 m near the eye, API-matching 200 m to 100 km.
 * Sub-grid vertices interpolate the 200 m DEM, not extra measured detail.
 * Every vertex is a measured radial height on the real lunar sphere, scale 1:1.
 * Angular interpolation remains finite; API center visibility stays authoritative.
 */
export function buildCompassTerrain(dem: CompassDem, latDeg: number, lonDeg: number,
  referenceElevationM: number): CompassTerrain {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(referenceElevationM) ||
      latDeg < -90 || latDeg >= 0 || lonDeg < -180 || lonDeg > 180) {
    throw new Error('Coordinate outside south-polar DEM coverage');
  }
  const lat = latDeg * RAD, lon = lonDeg * RAD;
  const rho = 2 * LUNAR_RADIUS_M * Math.tan((Math.PI / 2 + lat) / 2);
  const surfaceElevationM = sampleCompassDem(dem, rho * Math.sin(lon), rho * Math.cos(lon));
  if (surfaceElevationM === null) throw new Error('No measured DEM surface at observer');
  // A different DEM/datum must never silently shift the eye below or above the backend surface.
  if (Math.abs(surfaceElevationM - referenceElevationM) > 0.1) {
    throw new Error('DEM surface does not match backend elevation (tolerance 0.1 m)');
  }
  const up = new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
  const north = new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat));
  const origin = up.clone().multiplyScalar(LUNAR_RADIUS_M + referenceElevationM);
  const radii = COMPASS_TERRAIN_RADII_M;
  const segments = COMPASS_TERRAIN_SEGMENTS, stride = segments + 1, count = 1 + radii.length * stride;
  const positions = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const valid = new Uint8Array(count), indices: number[] = [];
  valid[0] = 1;
  positions[1] = surfaceElevationM - referenceElevationM;
  uv[0] = lonDeg / 360 + 0.5; uv[1] = latDeg / 180 + 0.5;
  let partial = false;
  const unit = new THREE.Vector3(), offset = new THREE.Vector3();
  radii.forEach((radius, ring) => {
    const angle = radius / LUNAR_RADIUS_M;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = (segment % segments) * 2 * Math.PI / segments;
      unit.copy(up).multiplyScalar(Math.cos(angle))
        .addScaledVector(east, Math.sin(angle) * Math.sin(azimuth))
        .addScaledVector(north, Math.sin(angle) * Math.cos(azimuth));
      const latitude = Math.atan2(unit.z, Math.hypot(unit.x, unit.y));
      const longitude = Math.atan2(unit.y, unit.x);
      const projectedRadius = 2 * LUNAR_RADIUS_M * Math.tan((Math.PI / 2 + latitude) / 2);
      const height = sampleCompassDem(dem, projectedRadius * Math.sin(longitude), projectedRadius * Math.cos(longitude));
      const index = 1 + ring * stride + segment;
      if (height === null) { partial = true; continue; }
      valid[index] = 1;
      offset.copy(unit).multiplyScalar(LUNAR_RADIUS_M + height).sub(origin);
      positions[index * 3] = offset.dot(east);
      positions[index * 3 + 1] = offset.dot(up);
      positions[index * 3 + 2] = -offset.dot(north);
      let u = longitude / (2 * Math.PI) + 0.5;
      const centerU = lonDeg / 360 + 0.5;
      if (u - centerU > 0.5) u -= 1;
      if (u - centerU < -0.5) u += 1;
      uv[index * 2] = u; uv[index * 2 + 1] = latitude / Math.PI + 0.5;
    }
  });
  const triangle = (a: number, b: number, c: number) => {
    if (valid[a] && valid[b] && valid[c]) indices.push(a, b, c);
  };
  for (let segment = 0; segment < segments; segment++) triangle(0, segment + 2, segment + 1);
  for (let ring = 0; ring < radii.length - 1; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = 1 + ring * stride + segment, b = a + 1, c = a + stride, d = c + 1;
      triangle(a, b, c); triangle(b, d, c);
    }
  }
  if (!indices.length) throw new Error('No measured terrain triangles');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  // Ring endpoints coincide geometrically but have separate UVs. Weld their
  // indices for area-weighted normals, then restore the texture topology.
  const weldedIndices = indices.map(index => index > 0 && (index - 1) % stride === segments
    ? index - segments : index);
  geometry.setIndex(weldedIndices);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  for (let ring = 0; ring < radii.length; ring++) {
    const first = 1 + ring * stride, last = first + segments;
    normals.setXYZ(last, normals.getX(first), normals.getY(first), normals.getZ(first));
  }
  geometry.setIndex(indices);
  const extraPositions: number[] = [], extraNormals: number[] = [], extraUv: number[] = [];
  const duplicates = new Map<string, number>();
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const vertices = indices.slice(triangle, triangle + 3);
    const original = vertices.map(index => uv[index * 2]);
    if (Math.max(...original) - Math.min(...original) <= 0.5) continue;
    const cyclic = original.map(u => u - Math.floor(u));
    const sorted = [...cyclic].sort((a, b) => a - b);
    let cut = 0, largestGap = -1;
    for (let corner = 0; corner < 3; corner++) {
      const gap = (corner === 2 ? sorted[0] + 1 : sorted[corner + 1]) - sorted[corner];
      if (gap > largestGap) { largestGap = gap; cut = sorted[(corner + 1) % 3]; }
    }
    const unwrapped = cyclic.map(u => u < cut ? u + 1 : u);
    const shift = Math.round(original[0] - unwrapped[0]);
    for (let corner = 0; corner < 3; corner++) unwrapped[corner] += shift;
    if (Math.max(...unwrapped) - Math.min(...unwrapped) > 0.5) {
      // A triangle enclosing the pole has no continuous equirectangular UV chart.
      // Preserve its measured geometry; approximate the closest-to-pole corner's
      // longitude by the midpoint of the other two along their shorter arc.
      let polar = 0;
      for (let corner = 1; corner < 3; corner++) {
        if (uv[vertices[corner] * 2 + 1] < uv[vertices[polar] * 2 + 1]) polar = corner;
      }
      const a = (polar + 1) % 3, b = (polar + 2) % 3;
      unwrapped[a] = original[a];
      unwrapped[b] = original[b] + Math.round(original[a] - original[b]);
      unwrapped[polar] = (unwrapped[a] + unwrapped[b]) / 2;
    }
    for (let corner = 0; corner < 3; corner++) {
      const index = vertices[corner], u = Math.fround(unwrapped[corner]);
      if (u === original[corner]) continue;
      const key = `${index}/${u}`;
      let duplicate = duplicates.get(key);
      if (duplicate === undefined) {
        duplicate = count + extraUv.length / 2;
        duplicates.set(key, duplicate);
        extraPositions.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
        extraNormals.push(normals.getX(index), normals.getY(index), normals.getZ(index));
        extraUv.push(u, uv[index * 2 + 1]);
      }
      indices[triangle + corner] = duplicate;
    }
  }
  if (extraUv.length) {
    const append = (source: Float32Array, extra: number[]) => {
      const result = new Float32Array(source.length + extra.length);
      result.set(source); result.set(extra, source.length); return result;
    };
    geometry.setAttribute('position', new THREE.BufferAttribute(append(positions, extraPositions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(append(normals.array as Float32Array, extraNormals), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(append(uv, extraUv), 2));
    geometry.setIndex(indices);
  }
  geometry.computeBoundingSphere();
  return { geometry, surfaceElevationM, partial, vertexCount: geometry.getAttribute('position').count };
}
