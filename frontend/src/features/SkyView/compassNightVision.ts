import * as THREE from 'three';

export const DEFAULT_NIGHT_VISION = false;
/** Fixed ENU-local display cue, deliberately NOT the Sun or a physical light. */
export const NIGHT_RELIEF_DIRECTION = new THREE.Vector3(-0.6, 0.35, 0.45).normalize();

/** CPU reference: linear source luminances, bounded sRGB display output.
 * Subtract the flat-ground cue before amplifying measured slopes. Otherwise the
 * mostly upward-facing DEM normals produce an almost uniform bright surface.
 */
export function terrainNightVisionLevel(lit: number, texture: number, localNormal: THREE.Vector3): number {
  const light = Number.isFinite(lit) ? Math.max(lit, 0) : 0;
  const albedo = Number.isFinite(texture) ? THREE.MathUtils.clamp(texture, 0, 1) : 0;
  const normal = localNormal.clone();
  if (![normal.x, normal.y, normal.z].every(Number.isFinite) || normal.lengthSq() === 0) normal.set(0, 1, 0);
  const slope = THREE.MathUtils.clamp((normal.normalize().dot(NIGHT_RELIEF_DIRECTION) - NIGHT_RELIEF_DIRECTION.y) * 4, -1, 1);
  return 0.16 + 0.46 * (0.5 + 0.5 * slope) + 0.08 * albedo + 0.06 * light / (1 + light);
}

/** Generates procedural regolith noise texture without DOM canvas dependencies. */
export function createRegolithTexture(): THREE.Texture {
  const width = 256, height = 256;
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < data.length; i += 4) {
    const shade = Math.floor(140 + random() * 65);
    data[i] = shade;
    data[i + 1] = Math.floor(shade * 0.985);
    data[i + 2] = Math.floor(shade * 0.96);
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Terrain-only display mapping, after tone mapping and sRGB conversion so
 * exposure cannot wash the bounded grayscale back to white. Disabled is exact
 * original output. Object-space normals are ENU: this terrain has no transform.
 * Uniforms retain their identity across recompiles; no geometry/light mutation.
 */
export function installTerrainNightVision(material: THREE.MeshStandardMaterial) {
  const uniforms = {
    terrainNightAmount: { value: 0 },
    terrainReliefDirection: { value: NIGHT_RELIEF_DIRECTION.clone() },
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `varying vec3 vTerrainLocalNormal;\nvarying vec3 vTerrainPoint;\nvarying float vViewDistance;\n${shader.vertexShader}`
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvTerrainLocalNormal = objectNormal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvTerrainPoint = position;\nvec4 eyePoint = modelViewMatrix * vec4(position, 1.0);\nvViewDistance = length(eyePoint.xyz);`);
    shader.fragmentShader = `uniform float terrainNightAmount;
uniform vec3 terrainReliefDirection;
varying vec3 vTerrainLocalNormal;
varying vec3 vTerrainPoint;
varying float vViewDistance;

// Multi-scale procedural regolith noise; stable in local planet coordinates.
float grainHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float grainNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(grainHash(i), grainHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(grainHash(i + vec3(0.0, 1.0, 0.0)), grainHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(grainHash(i + vec3(0.0, 0.0, 1.0)), grainHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(grainHash(i + vec3(0.0, 1.0, 1.0)), grainHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z
  );
}

float regolithSand(vec3 p) {
  return grainNoise(p * 0.08) * 0.55 + grainNoise(p * 0.32) * 0.3 + grainNoise(p * 1.28) * 0.15;
}
${shader.fragmentShader}`
      .replace('#include <map_fragment>', `#include <map_fragment>
  // Multi-scale procedural regolith textures:
  // 1. Broad terrain dust variation (100m - 35km)
  // 2. Medium grain & crater ejecta (10m - 800m)
  // 3. Crunchy regolith sand & pebbles at observer feet (0-120m)
  float closeFade = 1.0 - smoothstep(1200.0, 35000.0, vViewDistance);
  float macroDust = (grainNoise(vTerrainPoint * 0.005) - 0.5) * 0.22;
  float mediumGrain = (grainNoise(vTerrainPoint * 0.05) - 0.5) * 0.18;
  float fineDust = (grainNoise(vTerrainPoint * 0.5) - 0.5) * (1.0 - smoothstep(15.0, 800.0, vViewDistance));
  float feetProximity = 1.0 - smoothstep(1.5, 120.0, vViewDistance);
  float microPebbles = (grainNoise(vTerrainPoint * 4.5) - 0.5) * 0.35 * feetProximity;
  float sandGrain = (regolithSand(vTerrainPoint * 12.0) - 0.5) * 0.25 * feetProximity;
  float totalRegolith = macroDust + mediumGrain + fineDust * 0.15 + microPebbles + sandGrain;
  diffuseColor.rgb *= clamp(1.0 + closeFade * totalRegolith, 0.45, 1.55);`)
      .replace('#include <colorspace_fragment>', `
  #include <colorspace_fragment>
  if (terrainNightAmount > 0.0) {
    float litLevel = max(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), 0.0);
    float textureLevel = clamp(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    // Camera-independent slope contrast; illustrative relief, NOT sunlight.
    float slope = clamp((dot(normalize(vTerrainLocalNormal), terrainReliefDirection)
      - terrainReliefDirection.y) * 4.0, -1.0, 1.0);
    float aidedLevel = 0.16 + 0.46 * (0.5 + 0.5 * slope) + 0.08 * textureLevel
      + 0.06 * litLevel / (1.0 + litLevel);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(aidedLevel), terrainNightAmount);
  }`);
  };
  material.customProgramCacheKey = () => 'terrain-night-vision-gray-v4';
  material.needsUpdate = true;
  return (amount: boolean | number) => {
    uniforms.terrainNightAmount.value = typeof amount === 'boolean' ? Number(amount)
      : Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0;
  };
}
