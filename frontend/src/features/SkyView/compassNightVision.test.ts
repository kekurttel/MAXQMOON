import * as THREE from 'three';
import { createCompassTerrainMaterial } from './compassTerrain';
import { DEFAULT_NIGHT_VISION, installTerrainNightVision, NIGHT_RELIEF_DIRECTION, terrainNightVisionLevel } from './compassNightVision';

test('grayscale display mapping is bounded, monotonic and legible with no incident light', () => {
  expect(DEFAULT_NIGHT_VISION).toBe(false);
  const normal = new THREE.Vector3(0, 1, 0);
  const values = [0, 0.01, 0.1, 1, 10, 100000].map(lit => terrainNightVisionLevel(lit, 0.5, normal));
  expect(values[0]).toBeCloseTo(0.43);
  values.forEach((level, index) => {
    expect(level).toBeGreaterThanOrEqual(0.16);
    expect(level).toBeLessThanOrEqual(0.76);
    if (index > 0) expect(level).toBeGreaterThan(values[index - 1]);
  });
  for (const slope of [NIGHT_RELIEF_DIRECTION, NIGHT_RELIEF_DIRECTION.clone().negate()]) {
    for (const texture of [0, 0.5, 1]) {
      for (const light of [0, 1, 1e6]) {
        const level = terrainNightVisionLevel(light, texture, slope);
        expect(level).toBeGreaterThanOrEqual(0.16);
        expect(level).toBeLessThanOrEqual(0.76);
      }
    }
  }
  expect(terrainNightVisionLevel(0, 1, normal)).toBeGreaterThan(terrainNightVisionLevel(0, 0, normal));
  expect(Number.isFinite(terrainNightVisionLevel(NaN, NaN, new THREE.Vector3(NaN, 0, 0)))).toBe(true);
});

test('signed local slope cue reveals gentle DEM slopes without camera dependence or normal mutation', () => {
  const facing = terrainNightVisionLevel(0, 0.5, NIGHT_RELIEF_DIRECTION);
  const opposing = terrainNightVisionLevel(0, 0.5, NIGHT_RELIEF_DIRECTION.clone().negate());
  expect(facing - opposing).toBeGreaterThan(0.4);
  const gentleFacing = new THREE.Vector3(-0.1, 1, 0.075).normalize();
  const gentleOpposing = new THREE.Vector3(0.1, 1, -0.075).normalize();
  expect(terrainNightVisionLevel(0, 0.5, gentleFacing) - terrainNightVisionLevel(0, 0.5, gentleOpposing)).toBeGreaterThan(0.18);
  const originalNormal = new THREE.Vector3(0.2, 1, -0.3);
  const before = originalNormal.toArray();
  const camera = new THREE.PerspectiveCamera();
  const initial = terrainNightVisionLevel(0, 0.5, originalNormal);
  camera.rotation.set(1, 2, 3); camera.updateMatrixWorld();
  expect(terrainNightVisionLevel(0, 0.5, originalNormal)).toBe(initial);
  expect(originalNormal.toArray()).toEqual(before);
});

test('r160 shader preserves original output and applies grayscale after tone mapping and output conversion', () => {
  const material = createCompassTerrainMaterial();
  installTerrainNightVision(material);
  const shader = {
    uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as Parameters<typeof material.onBeforeCompile>[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  // Exact r160 insertion hooks must exist once, in the correct order.
  expect(shader.vertexShader.match(/vTerrainLocalNormal = objectNormal;/g)).toHaveLength(1);
  expect(shader.vertexShader.indexOf('#include <beginnormal_vertex>')).toBeLessThan(shader.vertexShader.indexOf('vTerrainLocalNormal = objectNormal;'));
  expect(shader.fragmentShader).toContain('normalize(vTerrainLocalNormal)');
  expect(shader.fragmentShader).not.toContain('viewMatrix');
  expect(shader.fragmentShader).not.toContain('abs(normal.z)');
  expect(shader.fragmentShader).toContain('if (terrainNightAmount > 0.0)');
  expect(shader.fragmentShader).toContain('gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(aidedLevel), terrainNightAmount);');
  const opaque = shader.fragmentShader.indexOf('#include <opaque_fragment>');
  const tone = shader.fragmentShader.indexOf('#include <tonemapping_fragment>');
  const color = shader.fragmentShader.indexOf('#include <colorspace_fragment>');
  const enhancement = shader.fragmentShader.indexOf('if (terrainNightAmount > 0.0)');
  expect(opaque).toBeGreaterThan(-1);
  expect(tone).toBeGreaterThan(opaque);
  expect(color).toBeGreaterThan(tone);
  expect(enhancement).toBeGreaterThan(color);
  expect(shader.fragmentShader.match(/#include <colorspace_fragment>/g)).toHaveLength(1);
  expect(THREE.ShaderChunk.opaque_fragment).toContain('gl_FragColor = vec4( outgoingLight, diffuseColor.a );');
  expect(THREE.ShaderChunk.colorspace_fragment).toContain('gl_FragColor = linearToOutputTexel( gl_FragColor );');
  material.dispose();
});

test('terrain-only uniforms support reversible transitions and survive shader recompilation', () => {
  const material = createCompassTerrainMaterial();
  const earth = new THREE.MeshStandardMaterial();
  const sun = new THREE.MeshBasicMaterial({ toneMapped: false });
  const original = material.toJSON(), originalEarth = earth.toJSON(), originalSun = sun.toJSON();
  const update = installTerrainNightVision(material);
  const compile = () => {
    const shader = {
      uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as Parameters<typeof material.onBeforeCompile>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return shader;
  };
  const shader = compile();
  expect(shader.uniforms.terrainNightAmount.value).toBe(0);
  const baseline = JSON.stringify(shader.uniforms), version = material.version;
  for (let i = 0; i < 8; i++) {
    update(true);
    expect(shader.uniforms.terrainNightAmount.value).toBe(1);
    update(0.35);
    expect(shader.uniforms.terrainNightAmount.value).toBe(0.35);
    update(false);
    expect(JSON.stringify(shader.uniforms)).toBe(baseline);
  }
  update(2); expect(shader.uniforms.terrainNightAmount.value).toBe(1);
  update(-1); expect(shader.uniforms.terrainNightAmount.value).toBe(0);
  update(NaN); expect(shader.uniforms.terrainNightAmount.value).toBe(0);
  update(0.5);
  const recompiled = compile();
  expect(recompiled.uniforms.terrainNightAmount).toBe(shader.uniforms.terrainNightAmount);
  expect(recompiled.uniforms.terrainNightAmount.value).toBe(0.5);
  expect(recompiled.uniforms.terrainReliefDirection).toBe(shader.uniforms.terrainReliefDirection);
  expect(shader.uniforms.terrainReliefDirection.value.toArray()).toEqual(NIGHT_RELIEF_DIRECTION.toArray());
  expect(material.version).toBe(version);
  expect(material.toJSON()).toEqual(original);
  expect(earth.toJSON()).toEqual(originalEarth);
  expect(sun.toJSON()).toEqual(originalSun);
  expect(Object.keys(shader.uniforms).sort()).toEqual(['terrainNightAmount', 'terrainReliefDirection']);
  material.dispose(); earth.dispose(); sun.dispose();
});
