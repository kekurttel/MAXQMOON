import * as THREE from 'three';

/** Camera-only inspection: never changes API observer, terrain scale or coverage. */
export const MAX_CAMERA_ALTITUDE_M = 120000;
export function stepCameraAltitude(height: number, delta: number, minimum = 0): number {
  const floor = Number.isFinite(minimum) ? THREE.MathUtils.clamp(minimum, 0, MAX_CAMERA_ALTITUDE_M) : 0;
  const current = Number.isFinite(height) ? THREE.MathUtils.clamp(height, floor, MAX_CAMERA_ALTITUDE_M) : floor;
  const step = Number.isFinite(delta) ? THREE.MathUtils.clamp(delta, -1000, 1000) : 0;
  return THREE.MathUtils.clamp((current + 100) * Math.exp(step * 0.002) - 100, floor, MAX_CAMERA_ALTITUDE_M);
}

/** Aim below the highest measured skyline, retaining it within the vertical FOV.
 * This is framing only, never a horizon/visibility calculation or raised eye.
 */
export function initialTerrainFraming(azimuths: number[], elevations: number[], verticalFov = 65): { heading: number; pitch: number } {
  let heading = 0, highest = -Infinity;
  elevations.forEach((elevation, index) => {
    if (Number.isFinite(elevation) && Number.isFinite(azimuths[index]) && elevation >= -90 && elevation <= 90 && elevation > highest) {
      highest = elevation; heading = ((azimuths[index] % 360) + 360) % 360;
    }
  });
  const skyline = Number.isFinite(highest) ? highest : 0;
  const fov = Number.isFinite(verticalFov) ? THREE.MathUtils.clamp(verticalFov, 12, 95) : 65;
  return { heading, pitch: THREE.MathUtils.clamp(skyline - Math.min(10, fov * 0.2), -89, 89) };
}

/** Fit only the existing measured local neighborhood, not the 100 km far horizon.
 * Bounding-sphere fit respects portrait aspect and never manufactures missing DEM.
 */
export function terrainInspectionFraming(geometry: THREE.BufferGeometry, aspect: number, heading: number, verticalFov = 65, inspectionRadiusM = 30000) {
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  const positions = geometry.getAttribute('position');
  for (let i = 0; i < positions.count; i++) {
    vertex.fromBufferAttribute(positions, i);
    if ([vertex.x, vertex.y, vertex.z].every(Number.isFinite) && Math.hypot(vertex.x, vertex.z) <= inspectionRadiusM) bounds.expandByPoint(vertex);
  }
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const fov = Number.isFinite(verticalFov) ? THREE.MathUtils.clamp(verticalFov, 12, 95) : 65;
  const halfVertical = THREE.MathUtils.degToRad(fov / 2);
  const halfFov = Math.min(halfVertical, Math.atan(Math.tan(halfVertical) * safeAspect));
  const requestedDistance = sphere.radius * 1.12 / Math.sin(halfFov);
  return { target: sphere.center, distance: THREE.MathUtils.clamp(requestedDistance, 2000, MAX_CAMERA_ALTITUDE_M),
    heading: THREE.MathUtils.degToRad((Number.isFinite(heading) ? heading : 0) + 180),
    elevation: THREE.MathUtils.degToRad(45), limited: requestedDistance > MAX_CAMERA_ALTITUDE_M };
}

/** Display exposure is illustrative, not measured radiometry. Fill defaults off. */
export const DEFAULT_TERRAIN_EXPOSURE = 1.22;
export const DEFAULT_INSPECTION_FILL = 0.08;
export function terrainInspectionFill(enabled: boolean, amount: number): number {
  return enabled && Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 0.3) : 0;
}

/** Positive elevation; positions and target height are in scene metres. */
export function localOrbitPosition(heading: number, elevation: number, distance: number, targetHeight: number): THREE.Vector3 {
  const horizontal = distance * Math.cos(elevation);
  return new THREE.Vector3(Math.sin(heading) * horizontal,
    targetHeight + distance * Math.sin(elevation), -Math.cos(heading) * horizontal);
}
