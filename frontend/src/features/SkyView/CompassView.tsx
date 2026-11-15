import { fetchTerrainAsset } from './terrainAsset';
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { SkyPoint, SkySeries } from '../../services/skyview';
import { useI18n } from '../../i18n';
import { apparentRadiusRadians, bodyToSunDirection, buildCompassTerrain, compassDirection, COMPASS_SKY_DISTANCES_M, createCompassTerrainMaterial, EARTH_MEAN_RADIUS_KM, fitTerrainShadow, parseCompassDem } from './compassTerrain';

import { DEFAULT_INSPECTION_FILL, DEFAULT_TERRAIN_EXPOSURE, initialTerrainFraming, localOrbitPosition, MAX_CAMERA_ALTITUDE_M, stepCameraAltitude, terrainInspectionFill, terrainInspectionFraming } from './compassCamera';

import { DEFAULT_NIGHT_VISION, installTerrainNightVision } from './compassNightVision';
import './CompassView.css';

type Action = 'sun' | 'earth' | 'reset' | 'in' | 'out' | 'mode' | 'surface' | 'inspect' | 'observer' | 'higher' | 'lower';
type CameraMode = 'panorama' | 'orbit';
type Status = 'loading' | 'ready' | 'error';
interface ViewReading { heading: number; pitch: number; fov: number; altitude: number; mode: CameraMode }
const RAD = Math.PI / 180;
const assets = process.env.PUBLIC_URL || '';
const panel: React.CSSProperties = {
  background: 'var(--compass-glass)', color: 'var(--compass-ink)',
  border: '1px solid var(--compass-border)', borderRadius: 10,
  padding: '8px 10px', backdropFilter: 'blur(18px) saturate(0)', fontSize: 12,
};
const button: React.CSSProperties = {
  border: '1px solid var(--compass-border)',
  background: 'var(--compass-glass)', color: 'var(--compass-ink)',
  backdropFilter: 'blur(18px) saturate(0)', borderRadius: 7, padding: '7px 10px', minHeight: 40, cursor: 'pointer', font: 'inherit',
};

/** Demand-rendered local panorama/DEM inspection. Ephemerides stay at the API observer. */
export default function CompassView({ series, point }: { series: SkySeries; point: SkyPoint }) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  const format = (value: number, digits: number) => value.toLocaleString(language === 'tr' ? 'tr-TR' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
  const localizeError = (message: string) => {
    const messages: Record<string, [string, string]> = {
      'Desteklenmeyen Ay referans çerçevesi; MOON_ME_DE421 gerekli.': ['Desteklenmeyen Ay referans çerçevesi; MOON_ME_DE421 gerekli.', 'Unsupported lunar reference frame; MOON_ME_DE421 is required.'],
      'Geçersiz gözlemci yüksekliği.': ['Geçersiz gözlemci yüksekliği.', 'Invalid observer height.'],
      'WebGL kullanılamıyor. Ölçülmüş arazi yerine yapay görüntü gösterilmiyor.': ['WebGL kullanılamıyor. Ölçülmüş arazi yerine yapay görüntü gösterilmiyor.', 'WebGL is unavailable. No synthetic image is substituted for measured terrain.'],
      'WebGL bağlamı kayboldu. Görünümü yeniden açın; yapay görüntü gösterilmiyor.': ['WebGL bağlamı kayboldu. Görünümü yeniden açın; yapay görüntü gösterilmiyor.', 'WebGL context lost. Reopen the view; no synthetic image is shown.'],
      'Ölçülmüş arazi yüklenemedi.': ['Ölçülmüş arazi yüklenemedi.', 'Measured terrain could not be loaded.'],
      'LROC dokusu yüklenemedi; yalnızca ölçülmüş gri DEM gösteriliyor.': ['LROC dokusu yüklenemedi; yalnızca ölçülmüş gri DEM gösteriliyor.', 'LROC texture could not be loaded; only the measured gray DEM is shown.'],
      'Dünya dokusu yüklenemedi; sahte kıtalar yerine Dünya modeli gizlendi. Konumu API verisinde mevcut.': ['Dünya dokusu yüklenemedi; sahte kıtalar yerine Dünya modeli gizlendi. Konumu API verisinde mevcut.', 'Earth texture could not be loaded; the Earth model is hidden rather than showing invented continents. Its position is available in the API data.'],
      'Truncated DEM header': ['DEM başlığı eksik.', 'Truncated DEM header'],
      'Invalid DEM dimensions or scale': ['DEM boyutları veya ölçeği geçersiz.', 'Invalid DEM dimensions or scale'],
      'Coordinate outside south-polar DEM coverage': ['Koordinat güney kutbu DEM kapsamı dışında.', 'Coordinate outside south-polar DEM coverage'],
      'No measured DEM surface at observer': ['Gözlemci konumunda ölçülmüş DEM yüzeyi yok.', 'No measured DEM surface at observer'],
      'DEM surface does not match backend elevation (tolerance 0.1 m)': ['DEM yüzeyi arka uç yüksekliğiyle uyuşmuyor (tolerans 0,1 m).', 'DEM surface does not match backend elevation (tolerance 0.1 m)'],
      'No measured terrain triangles': ['Ölçülmüş arazi üçgeni yok.', 'No measured terrain triangles'],
    };
    return messages[message] ? text(...messages[message]) : message;
  };
  const host = useRef<HTMLDivElement>(null);
  const pointRef = useRef(point);
  const updateRef = useRef<() => void>(() => undefined);
  const actionRef = useRef<(action: Action) => void>(() => undefined);
  const sensitivityRef = useRef(1);
  const inspectionRef = useRef(false);
  const shadowsRef = useRef(true);
  const [nightVision, setNightVision] = useState(DEFAULT_NIGHT_VISION);
  const nightVisionRef = useRef(nightVision);
  nightVisionRef.current = nightVision;
  const [exposure, setExposure] = useState(DEFAULT_TERRAIN_EXPOSURE);
  const [inspectionFill, setInspectionFill] = useState(DEFAULT_INSPECTION_FILL);
  const exposureRef = useRef(exposure);
  const inspectionFillRef = useRef(inspectionFill);
  exposureRef.current = exposure;
  inspectionFillRef.current = inspectionFill;
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [reading, setReading] = useState<ViewReading>({ heading: 0, pitch: 2, fov: 65, altitude: series.site.observer_height_m, mode: 'panorama' });
  const [altitudeWheel, setAltitudeWheel] = useState(false);
  const altitudeWheelRef = useRef(false);
  altitudeWheelRef.current = altitudeWheel;
  const [partial, setPartial] = useState(false);
  const [shadowResolution, setShadowResolution] = useState(0);
  const [textureWarnings, setTextureWarnings] = useState<string[]>([]);
  const [inspection, setInspection] = useState(false);
  const [shadows, setShadows] = useState(true);
  const [sensitivity, setSensitivity] = useState(1);
  pointRef.current = point;
  inspectionRef.current = inspection;
  sensitivityRef.current = sensitivity;
  shadowsRef.current = shadows;
  useEffect(() => { updateRef.current(); }, [point, inspection, shadows, exposure, inspectionFill, nightVision]);
  const framing = initialTerrainFraming(series.horizon.azimuths_deg, series.horizon.elevations_deg);
  const initialHeading = framing.heading, initialPitch = framing.pitch;

  const latitude = series.site.lat_deg, longitude = series.site.lon_deg;
  const surface = series.site.surface_elevation_m, eyeHeight = series.site.observer_height_m;
  const frameName = series.frame;
  const demSha256 = series.horizon.provenance.sha256;
  const demRows = series.horizon.provenance.rows;
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let disposed = false, cleaned = false, queued = 0;
    const teardown: (() => void)[] = [];
    const abort = new AbortController();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      abort.abort(); window.cancelAnimationFrame(queued);
      actionRef.current = () => undefined; updateRef.current = () => undefined;
      // Every resource is registered at creation, so initialization errors clean up too.
      for (const dispose of teardown.reverse()) { try { dispose(); } catch { /* finish remaining cleanup */ } }
    };
    const own = <T extends { dispose(): void },>(resource: T): T => {
      teardown.push(() => resource.dispose()); return resource;
    };
    setStatus('loading'); setError(''); setTextureWarnings([]);
    const start = async () => {
      if (frameName !== 'MOON_ME_DE421') throw new Error('Desteklenmeyen Ay referans çerçevesi; MOON_ME_DE421 gerekli.');
      if (!Number.isFinite(eyeHeight) || eyeHeight < 0) throw new Error('Geçersiz gözlemci yüksekliği.');
      const targetDem = (demSha256 === '830f54727e68f2c2c95e739a1bea21b6476a6f979876d0126c8b10a6ff73eb9e' || demRows === 7760)
        ? 'pole_dem_60s.bin'
        : (demSha256 === '7210a3774f7bb0aa26e8040e681b59c388487d9d0816d8708eb833f55ca4f617' || demRows === 3812)
        ? 'pole_dem_75s.bin'
        : 'pole_dem.bin';
      const dem = parseCompassDem(await fetchTerrainAsset(assets, targetDem, abort.signal));
      if (disposed) return;
      const terrainData = buildCompassTerrain(dem, latitude, longitude, surface);
      own(terrainData.geometry);
      let renderer: THREE.WebGLRenderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true }); }
      catch { throw new Error('WebGL kullanılamıyor. Ölçülmüş arazi yerine yapay görüntü gösterilmiyor.'); }
      teardown.push(() => { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = exposureRef.current;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.shadowMap.autoUpdate = false;
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
      renderer.domElement.setAttribute('aria-hidden', 'true');
      container.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      // Three.js light layers filter against the camera, not individual meshes.
      // A separate render scene is required for genuinely independent Earth lighting.
      const earthScene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 600000);
      camera.position.set(0, eyeHeight, 0);
      const material = own(createCompassTerrainMaterial());
      const setTerrainNightVision = installTerrainNightVision(material);
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      let nightAmount = Number(nightVisionRef.current), nightFrom = nightAmount, nightTarget = nightAmount, nightStart = 0;
      const terrain = new THREE.Mesh(terrainData.geometry, material);
      terrain.castShadow = true; terrain.receiveShadow = true;
      scene.add(terrain);
      const fill = new THREE.AmbientLight(0xffffff, 0);
      const sunlight = new THREE.DirectionalLight(0xfff7e8, 3.2);
      sunlight.castShadow = true;
      const mapSize = Math.min(4096, renderer.capabilities.maxTextureSize);
      sunlight.shadow.mapSize.set(mapSize, mapSize);
      sunlight.shadow.bias = -0.000005;
      sunlight.shadow.normalBias = 1;
      own(sunlight.shadow);
      scene.add(fill, sunlight, sunlight.target);
      const earthGeometry = own(new THREE.SphereGeometry(1, 64, 40));
      const earthMaterial = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }));
      const earth = new THREE.Mesh(earthGeometry, earthMaterial);
      earth.visible = false;
      // Separate scene: terrain inspection light must never change Earth phase.
      const earthSun = new THREE.DirectionalLight(0xffffff, 3.2);
      earthScene.add(earth, earthSun, earthSun.target);
      // Texture orientation is illustrative; no arbitrary ecliptic/axial tilt.
      const sunGeometry = own(new THREE.SphereGeometry(1, 48, 24));
      const sunMaterial = own(new THREE.MeshBasicMaterial({ color: 0xfff8e6, toneMapped: false }));
      const sun = new THREE.Mesh(sunGeometry, sunMaterial);
      scene.add(sun);
      let earthTextureReady = false;
      let yaw = initialHeading * RAD, pitch = initialPitch * RAD, altitude = eyeHeight;
      let mode: CameraMode = 'panorama';
      let orbitYaw = 0, orbitElevation = 45 * RAD, orbitDistance = 12000;
      const orbitTarget = new THREE.Vector3(0, terrainData.surfaceElevationM - surface, 0);
      const fitInspection = () => {
        const fit = terrainInspectionFraming(terrainData.geometry, camera.aspect, initialHeading);
        orbitYaw = fit.heading; orbitElevation = fit.elevation; orbitDistance = fit.distance;
        orbitTarget.copy(fit.target);
      };
      // Panorama state is retained while inspecting the selected site's local DEM.
      let savedPanorama = { yaw, pitch, altitude, fov: camera.fov };
      let drag: { id: number; x: number; y: number } | undefined;
      let contextLost = false;
      let previousSun = '';
      const direction = new THREE.Vector3();
      const render = () => {
        queued = 0;
        if (disposed || cleaned || contextLost) return;
        const progress = reducedMotion.matches ? 1 : Math.min(1, (performance.now() - nightStart) / 220);
        nightAmount = nightFrom + (nightTarget - nightFrom) * (1 - Math.pow(1 - progress, 3));
        setTerrainNightVision(nightAmount);
        if (progress < 1 && nightAmount !== nightTarget) invalidate();
        pitch = THREE.MathUtils.clamp(pitch, -89 * RAD, 89 * RAD);
        const previousPosition = camera.position.clone();
        if (mode === 'orbit') {
          camera.position.copy(localOrbitPosition(orbitYaw, orbitElevation, orbitDistance, 0)).add(orbitTarget);
          camera.lookAt(orbitTarget);
        } else {
          camera.position.set(0, altitude, 0);
          camera.lookAt(direction.copy(compassDirection(yaw / RAD, pitch / RAD)).add(camera.position));
        }
        // Sky directions remain ground-reference API angles, not recomputed ephemerides
        // for an elevated camera. Translate the sky, never the measured terrain.
        const translation = camera.position.clone().sub(previousPosition);
        sun.position.add(translation); earth.position.add(translation);
        earthSun.position.add(translation); earthSun.target.position.add(translation);
        renderer.autoClear = false;
        renderer.clear();
        renderer.toneMappingExposure = exposureRef.current;
        renderer.render(scene, camera);
        // Retain terrain depth and original Earth exposure; terrain controls do not alter its phase.
        renderer.toneMappingExposure = 1.15;
        renderer.render(earthScene, camera);
        const heading = mode === 'orbit' ? orbitYaw + Math.PI : yaw;
        setReading({ heading: ((heading / RAD % 360) + 360) % 360,
          pitch: mode === 'orbit' ? -orbitElevation / RAD : pitch / RAD,
          fov: camera.fov, altitude: camera.position.y, mode });
      };
      const invalidate = () => { if (!disposed && !cleaned && !queued && !contextLost) queued = window.requestAnimationFrame(render); };
      const applyPoint = () => {
        const current = pointRef.current;
        const sunDirection = compassDirection(current.sun.azimuth_deg, current.sun.elevation_deg);
        const sunKey = `${current.sun.azimuth_deg}/${current.sun.elevation_deg}`;
        if (sunKey !== previousSun) {
          previousSun = sunKey;
          sunlight.position.copy(sunDirection).multiplyScalar(400000);
          sunlight.target.position.set(0, 0, 0);
          fitTerrainShadow(sunlight, terrainData.geometry);
          // Global autoUpdate is disabled: explicitly refresh after time changes only.
          renderer.shadowMap.needsUpdate = true;
          const bounds = sunlight.shadow.camera;
          setShadowResolution(Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom) / mapSize);
        }
        if (terrain.receiveShadow !== shadowsRef.current) {
          terrain.receiveShadow = shadowsRef.current;
          material.needsUpdate = true;
        }
        fill.intensity = terrainInspectionFill(inspectionRef.current, inspectionFillRef.current);
        const target = Number(nightVisionRef.current);
        if (target !== nightTarget) {
          nightFrom = nightAmount; nightTarget = target; nightStart = performance.now();
        }
        for (const [mesh, body, radius, displayDistance] of [
          [sun, current.sun, 695700, COMPASS_SKY_DISTANCES_M.sun],
          [earth, current.earth, EARTH_MEAN_RADIUS_KM, COMPASS_SKY_DISTANCES_M.earth],
        ] as const) {
          const angularRadius = apparentRadiusRadians(radius, body.distance_km);
          const valid = angularRadius > 0 && Number.isFinite(body.azimuth_deg) && Number.isFinite(body.elevation_deg);
          mesh.visible = valid && (mesh !== earth || earthTextureReady);
          mesh.position.copy(compassDirection(body.azimuth_deg, body.elevation_deg))
            .multiplyScalar(displayDistance).add(camera.position);
          mesh.scale.setScalar(Math.sin(angularRadius) * displayDistance);
        }
        earthSun.target.position.copy(earth.position);
        earthSun.position.copy(earth.position).addScaledVector(bodyToSunDirection(current.sun, current.earth), 100000);
        invalidate();
      };
      const loadTexture = (file: string, onReady: (texture: THREE.Texture) => void, warning: string) => {
        fetch(`${assets}/textures/${file}`, { signal: abort.signal })
          .then(result => { if (!result.ok) throw new Error(`Texture HTTP ${result.status}`); return result.blob(); })
          .then(blob => createImageBitmap(blob, { imageOrientation: 'flipY' }))
          .then(bitmap => {
            if (disposed || cleaned) { bitmap.close(); return; }
            const texture = own(new THREE.Texture(bitmap));
            teardown.push(() => bitmap.close());
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            texture.needsUpdate = true;
            onReady(texture); applyPoint();
          }).catch(() => {
            if (!disposed && !cleaned) setTextureWarnings(previous => [...previous, warning]);
          });
      };
      loadTexture('moon-lroc-4k.jpg', texture => {
        texture.anisotropy = Math.min(renderer.capabilities?.getMaxAnisotropy?.() || 4, 8);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        material.map = texture;
        material.needsUpdate = true;
      },
        'LROC dokusu yüklenemedi; yalnızca ölçülmüş gri DEM gösteriliyor.');
      loadTexture('earth.jpg', texture => {
        texture.anisotropy = Math.min(renderer.capabilities?.getMaxAnisotropy?.() || 4, 8);
        earthMaterial.map = texture;
        earthMaterial.needsUpdate = true;
        earthTextureReady = true;
      },
        'Dünya dokusu yüklenemedi; sahte kıtalar yerine Dünya modeli gizlendi. Konumu API verisinde mevcut.');
      const restorePanorama = () => {
        if (mode !== 'orbit') return;
        ({ yaw, pitch, altitude } = savedPanorama);
        camera.fov = savedPanorama.fov;
        mode = 'panorama';
      };
      const action = (value: Action) => {
        if (value === 'mode' || value === 'inspect') {
          if (mode === 'panorama') {
            savedPanorama = { yaw, pitch, altitude, fov: camera.fov };
            mode = 'orbit'; camera.fov = 65; fitInspection();
          } else if (value === 'mode') restorePanorama();
          else { camera.fov = 65; fitInspection(); }
        } else if (value === 'sun' || value === 'earth') {
          restorePanorama();
          const body = pointRef.current[value];
          yaw = body.azimuth_deg * RAD; pitch = body.elevation_deg * RAD;
        } else if (value === 'higher' || value === 'lower') {
          restorePanorama(); altitude = stepCameraAltitude(altitude, value === 'higher' ? 160 : -160, eyeHeight);
        } else if (value === 'reset' || value === 'surface' || value === 'observer') {
          restorePanorama(); yaw = initialHeading * RAD; pitch = initialPitch * RAD; altitude = eyeHeight; camera.fov = 65;
        } else camera.fov = THREE.MathUtils.clamp(camera.fov * (value === 'in' ? 0.85 : 1 / 0.85), 12, 95);
        camera.updateProjectionMatrix(); invalidate();
      };
      actionRef.current = action; updateRef.current = applyPoint;
      const down = (event: PointerEvent) => {
        if (event.button !== 0) return;
        container.focus({ preventScroll: true });
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        container.setPointerCapture(event.pointerId);
      };
      const move = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) return;
        const amount = camera.fov / 65 * 0.003 * sensitivityRef.current;
        if (mode === 'orbit') {
          orbitYaw -= (event.clientX - drag.x) * amount;
          orbitElevation = THREE.MathUtils.clamp(orbitElevation + (event.clientY - drag.y) * amount, 15 * RAD, 85 * RAD);
        } else {
          yaw -= (event.clientX - drag.x) * amount;
          pitch += (event.clientY - drag.y) * amount;
        }
        drag.x = event.clientX; drag.y = event.clientY;
        invalidate();
      };
      const release = () => { drag = undefined; };
      const wheel = (event: WheelEvent) => {
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
        if (mode === 'orbit') orbitDistance = THREE.MathUtils.clamp(orbitDistance * Math.exp(THREE.MathUtils.clamp(delta * 0.002, -2, 2)), 2000, MAX_CAMERA_ALTITUDE_M);
        else if (altitudeWheelRef.current) altitude = stepCameraAltitude(altitude, delta, eyeHeight);
        else camera.fov = THREE.MathUtils.clamp(camera.fov * Math.exp(delta * 0.001), 12, 95);
        camera.updateProjectionMatrix(); invalidate();
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.target !== container) return;
        const amount = (event.shiftKey ? 10 : 2) * RAD * sensitivityRef.current;
        if (mode === 'orbit' && event.key.startsWith('Arrow')) {
          if (event.key === 'ArrowLeft') orbitYaw -= amount;
          if (event.key === 'ArrowRight') orbitYaw += amount;
          if (event.key === 'ArrowUp') orbitElevation += amount;
          if (event.key === 'ArrowDown') orbitElevation -= amount;
          orbitElevation = THREE.MathUtils.clamp(orbitElevation, 15 * RAD, 85 * RAD);
          event.preventDefault(); invalidate(); return;
        }
        switch (event.key) {
          case 'Escape': restorePanorama(); camera.updateProjectionMatrix(); break;
          case 'o': case 'O': action('mode'); break;
          case 'PageUp': action('higher'); break;
          case 'PageDown': action('lower'); break;
          case 'ArrowLeft': yaw -= amount; break;
          case 'ArrowRight': yaw += amount; break;
          case 'ArrowUp': pitch += amount; break;
          case 'ArrowDown': pitch -= amount; break;
          case '+': case '=': action('in'); break;
          case '-': action('out'); break;
          case 'r': case 'R': action('reset'); break;
          default: return;
        }
        event.preventDefault(); invalidate();
      };
      const lost = (event: Event) => {
        event.preventDefault(); contextLost = true;
        setError('WebGL bağlamı kayboldu. Görünümü yeniden açın; yapay görüntü gösterilmiyor.'); setStatus('error');
        cleanup();
      };
      const listen = (target: EventTarget, name: string, listener: EventListener, options?: AddEventListenerOptions) => {
        target.addEventListener(name, listener, options);
        teardown.push(() => target.removeEventListener(name, listener));
      };
      listen(container, 'pointerdown', down as EventListener);
      listen(container, 'pointermove', move as EventListener);
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) listen(container, name, release);
      listen(container, 'wheel', wheel as EventListener, { passive: false });
      listen(container, 'keydown', keydown as EventListener);
      listen(renderer.domElement, 'webglcontextlost', lost);
      const resize = () => {
        const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
        renderer.setSize(width, height, false); camera.aspect = width / height;
        camera.updateProjectionMatrix(); invalidate();
      };
      const observer = new ResizeObserver(resize);
      teardown.push(() => observer.disconnect());
      observer.observe(container); resize(); applyPoint();
      setPartial(terrainData.partial); setStatus('ready');
    };
    start().catch(reason => {
      if (!disposed && !abort.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Ölçülmüş arazi yüklenemedi.'); setStatus('error');
      }
      cleanup();
    });
    return () => { disposed = true; cleanup(); };
  }, [latitude, longitude, surface, eyeHeight, frameName, initialHeading, initialPitch, demSha256, demRows]);

  const headingName = (language === 'tr' ? ['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'] : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])[Math.round(reading.heading / 45) % 8];
  const act = (value: Action) => { actionRef.current(value); host.current?.focus({ preventScroll: true }); };
  return (
    <section className="compass-view" aria-label={text('Ölçülmüş Ay yüzeyinden gökyüzü panoraması', 'Sky panorama from the measured lunar surface')}
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 420, overflow: 'hidden', background: '#000' }}>
      <div className="compass-view__canvas" ref={host} tabIndex={0} role="group"
        aria-label={text('Ay panoraması. Sürükleyerek veya ok tuşlarıyla bakın. Artı eksi görüş açısı, PageUp PageDown kamera yüksekliği, O yerel inceleme, Escape panoramaya dönüş, R sıfırlama. Shift oklarla hızlı bakış.', 'Lunar panorama. Drag or use arrow keys to look around. Plus/minus changes field of view, PageUp/PageDown camera height, O local inspection, Escape returns to panorama, R resets. Shift with arrows for faster movement.')}
        style={{ position: 'absolute', inset: 0, outlineOffset: -3, touchAction: 'none' }} />
      <div className="compass-view__surface-guide" style={panel}>
        <span>{reading.mode === 'orbit' ? text('İsteğe bağlı arazi incelemesi', 'Optional terrain inspection') : text(`Göz hizası ${format(reading.altitude, 1)} m · gerçek ölçek`, `Eye level ${format(reading.altitude, 1)} m · true scale`)}</span>
        <small>{text('200 m DEM: küçük kaya/krater ayrıntısı yok; düz görünüm gerçek olabilir.', '200 m DEM: no small rock/crater detail; a flat appearance may be real.')}</small>
        <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act(reading.mode === 'orbit' ? 'observer' : 'inspect')}>
          {reading.mode === 'orbit' ? text('API göz hizasına dön', 'Return to API eye level') : text('Ölçülmüş araziyi incele', 'Inspect measured terrain')}
        </button>
      </div>
      <details className="compass-view__presets" style={panel}>
        <summary>{text('Kamera araçları', 'Camera tools')}</summary>
        <div role="group" aria-label={text('Kamera görünümü', 'Camera view')} className="compass-view__preset-buttons">
          <button type="button" style={button} disabled={status !== 'ready'} aria-pressed={reading.mode === 'panorama' && Math.abs(reading.altitude - eyeHeight) < 0.1} onClick={() => act('surface')}>{text('Yüzey', 'Surface')}</button>
          <button type="button" style={button} disabled={status !== 'ready'} aria-pressed={reading.mode === 'orbit'} onClick={() => act('inspect')}>{text('Araziyi incele', 'Inspect terrain')}</button>
        </div>
        <div className="compass-view__camera-note">{reading.mode === 'orbit' ? text(`İnceleme kamerası · ${format(reading.altitude, 0)} m`, `Inspection camera · ${format(reading.altitude, 0)} m`) : text(`API göz yüksekliği · ${format(eyeHeight, 1)} m`, `API eye height · ${format(eyeHeight, 1)} m`)}</div>
        <div className="compass-view__height" role="group" aria-label={text('Görsel kamera yüksekliği', 'Visual camera height')}>
          <span>{reading.mode === 'orbit' ? text('Yükseklik: panoramaya döner', 'Height: returns to panorama') : text(`İnceleme artışı +${format(Math.max(0, reading.altitude - eyeHeight), 0)} m`, `Inspection increase +${format(Math.max(0, reading.altitude - eyeHeight), 0)} m`)}</span>
          <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('lower')} aria-label={text('Görsel kamerayı alçalt', 'Lower visual camera')}>−</button>
          <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('higher')} aria-label={text('Görsel kamerayı yükselt', 'Raise visual camera')}>+</button>
        </div>
        <small>{text('Yalnızca kamera · API hesabı değişmez', 'Camera only · API calculation unchanged')}</small>
      </details>
      <details className="compass-view__heading" style={{ ...panel, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        <summary>{text('Bakış verileri', 'View readout')}</summary>
        <strong style={{ fontSize: 20 }}>{format(reading.heading, 1)}° {headingName}</strong>
        <div>{text('Yükselim', 'Elevation')} {format(reading.pitch, 1)}°</div><div>{text('Görüş', 'Field of view')} {format(reading.fov, 0)}°</div>
        <div>{text('200 m LOLA · 1:1 yükseklik', '200 m LOLA · 1:1 height')}</div>
        {inspection && <div>{text('Fiziksel olmayan dolgu açık', 'Nonphysical fill enabled')}</div>}
        {nightVision && <div className="compass-view__night-status">{text('Gece görüşü · gösterim desteği', 'Night vision · display aid')}</div>}
      </details>
      <details className="compass-view__controls" style={panel}>
        <summary>{text('Görünüm araçları', 'View tools')}</summary>
        <div className="compass-view__control-buttons" role="group" aria-label={text('Panorama denetimleri', 'Panorama controls')}>
        <button type="button" style={button}
          disabled={status !== 'ready'} aria-pressed={nightVision} aria-describedby="compass-night-vision-help"
          className="compass-view__night-toggle" title={text('Gri tonlu gösterim desteği; fiziksel aydınlatma değildir', 'Grayscale display aid; not physical illumination')}
          onClick={() => setNightVision(value => !value)}>{text('Gece görüşü', 'Night vision')} {nightVision ? text('açık', 'on') : text('kapalı', 'off')}</button>
        <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('sun')}>{text('Güneş’e bak', 'Look at Sun')}</button>
        <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('earth')}>{text('Dünya’ya bak', 'Look at Earth')}</button>
        <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('reset')}>{text('Sıfırla', 'Reset')}</button>
        <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('in')} aria-label={text('Yakınlaştır', 'Zoom in')}>+</button>
        <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('out')} aria-label={text('Uzaklaştır', 'Zoom out')}>−</button>
        </div>
      </details>
      {status !== 'ready' && <div role="status" style={{ ...panel, position: 'absolute', top: '45%', left: '10%', right: '10%', textAlign: 'center' }}>
        {status === 'loading' ? text('Ölçülmüş LOLA arazisi hazırlanıyor…', 'Preparing measured LOLA terrain…') : localizeError(error)}
      </div>}
      <details className="compass-view__readout" style={panel}>
        <summary style={{ cursor: 'pointer', minHeight: 24 }}>{text('Gözlem verileri · sınırlar', 'Observation data · limitations')}{textureWarnings.length ? text(' · Doku uyarısı', ' · Texture warning') : ''}</summary>
        <div style={{ lineHeight: 1.6, marginTop: 8 }}>
          <strong>{new Date(point.time_utc).toLocaleString(language === 'tr' ? 'tr-TR' : 'en-GB', { timeZone: 'UTC' })} UTC</strong>
          <div>{text('Referans küresinden yüzey', 'Surface above reference sphere')} {format(surface, 1)} m · {text('Yüzeyden API göz yüksekliği', 'API eye height above surface')} {format(eyeHeight, 1)} m</div>
          <p>{text('Yüzey başlangıcı ölçülmüş ufkun en yüksek yönüne ve biraz aşağıya bakar; göz yüksekliği API ile aynıdır. Kutup sırtlarında uzak arazi gözden aşağıda kalabilir; 200 m DEM küçük kaya ve metre ölçekli kraterleri çözmez. “Araziyi incele” ölçülmüş ağın genişletilmiş 30 km çevresini yukarıdan çerçeveler; kamera mesafesi 120 km’ye kadar yükseltilebilir. Eksik veri doldurulmaz, kabartma abartılmaz. Görsel yükseklik seçili yüzeyin teğet düzlemine göredir, kamera altındaki zeminden açıklık değildir.', 'The initial surface view faces slightly downward toward the highest measured horizon; eye height matches the API. Distant terrain may lie below eye level on polar ridges; the 200 m DEM does not resolve small rocks or metre-scale craters. “Inspect terrain” frames the expanded 30 km surroundings of the measured mesh from above; camera distance can increase to 120 km. Missing data is not filled and relief is not exaggerated. Visual height is relative to the selected surface tangent plane, not clearance above the ground beneath the camera.')}</p>
          <div>{text('Güneş', 'Sun')} {format(point.sun.azimuth_deg, 2)}° / {format(point.sun.elevation_deg, 2)}° · {text('Merkez', 'Center')} {point.sun.center_visible ? text('görünür', 'visible') : text('ufuk altında', 'below horizon')}</div>
          <div>{text('Dünya', 'Earth')} {format(point.earth.azimuth_deg, 2)}° / {format(point.earth.elevation_deg, 2)}° · {text('Merkez', 'Center')} {point.earth.center_visible ? text('görünür', 'visible') : text('ufuk altında', 'below horizon')}</div>
          <p>{text('NASA / LRO LOLA · 200 m kaynak DEM · 50 m yakın ağ örneklemesi ek ölçüm değildir · 1:1 yükseklik ve Ay eğriliği · MOON_ME_DE421. Arazi 100 km’ye kadar, API ile aynı 200 m radyal adımlar ve 0,5° açısal ağ ile çizilir; 100 km’de komşu ışın aralığı yaklaşık 873 m’dir. Bu açısal enterpolasyon dar sırtları kaçırabilir; API merkez görünürlüğü yetkilidir. Veri sınırında kesilir, boşluk doldurulmaz.', 'NASA / LRO LOLA · 200 m source DEM · 50 m near-mesh sampling is not an additional measurement · 1:1 height and lunar curvature · MOON_ME_DE421. Terrain is drawn out to 100 km with the same 200 m radial steps and 0.5° angular grid as the API; adjacent rays are approximately 873 m apart at 100 km. Angular interpolation may miss narrow ridges; API center visibility is authoritative. The mesh stops at data boundaries; gaps are not filled.')}{partial ? text(' Bu konumda kapsama kısmi.', ' Coverage is partial at this location.') : ''}</p>
          <p>{text(`DEM geometrisiyle izdüşen gölge haritası hesaplanır; GPU gölgelerinin görsel doğruluğu henüz doğrulanmadı. Gölge anahtarı yalnızca alınan izdüşen gölgeleri değiştirir; yüzey normaline bağlı gece/gündüz aydınlatması ve LROC fotoğrafındaki gölgeler kalır. Sonlu gölge haritası: en kaba eksende yaklaşık ${format(shadowResolution, 0)} m/teksel; yalnızca çizilen 100 km yarıçap içindeki ölçülmüş arazi engelleyicidir. PCF filtreleme ve gölge yanlılığı nedeniyle temas gölgeleri yaklaşıktır; Güneş diski yumuşaklığı modellenmez. Merkez görünürlüğünde API ufuk hesabı yetkilidir.`, `A projected shadow map is computed from DEM geometry; the visual accuracy of GPU shadows has not yet been validated. The shadow toggle only changes received projected shadows; surface-normal day/night illumination and shadows in the LROC photograph remain. Finite shadow map: approximately ${format(shadowResolution, 0)} m/texel on the coarsest axis; only measured terrain within the drawn 100 km radius blocks light. Contact shadows are approximate due to PCF filtering and shadow bias; solar disk softness is not modeled. The API horizon calculation is authoritative for center visibility.`)}</p>
          <p>{text('Dünya ve Güneş boyutları gerçek uzaklıktan; Dünya ortalama yarıçapı 6371 km. Çizim uzaklıkları 250 / 500 km’dir: açısal boyutu koruyan ayrı derinlikler Dünya’yı Güneş’in önüne koyar, DEM derinliği ikisini de örter. Bunlar fiziksel uzaklık modeli değildir; gerçek uzaklıklar API’dendir. +/− yalnızca görüş açısını değiştirir. Kamera yüksekliği yalnızca görsel incelemedir; API gözlemcisi ve zemin referanslı cisim açıları/görünürlük etiketleri değişmez. Dünya evresi aynı ENU çerçevesindeki Dünya–Güneş vektöründen aydınlatılır. Doku yönelimi görseldir; SPICE Dünya yönelimi değildir. LROC dokusu fotoğrafik aydınlatma içerir; fiziksel albedo veya yeni topoğrafya değildir. Atmosfer, sahte krater veya küresel yörünge yoktur. Yerel inceleme yalnızca seçili sitenin mevcut DEM ağı çevresindedir; veri sınırının ötesi boş kalır. Kamera arazi çarpışması çözmez. Gece için düzlem tabanlı uydurma maske eklenmez; mevcut eğrilikli DEM aydınlatması/gölgesi korunur.', 'Earth and Sun sizes use their true distances; Earth mean radius is 6371 km. Drawing distances are 250 / 500 km: separate depths preserving angular size put Earth in front of the Sun, while DEM depth occludes both. These are not physical distance models; actual distances come from the API. +/− changes field of view only. Camera height is for visual inspection only; the API observer and ground-referenced body angles/visibility labels do not change. Earth phase is lit by the Earth–Sun vector in the same ENU frame. Texture orientation is illustrative, not SPICE Earth orientation. LROC texture contains photographic lighting; it is not physical albedo or new topography. There is no atmosphere, invented crater or global orbit. Local inspection covers only the existing DEM mesh around the selected site; areas beyond data boundaries stay empty. The camera does not resolve terrain collisions. No invented plane-based night mask is added; existing curved DEM lighting/shadows are preserved.')}</p>
          <p>{text('Oklar / sürükleme: bakış · Shift: hızlı · PageUp/PageDown: yükseklik · O: yerel inceleme · Escape: kayıtlı panoramaya dön · R: API gözlemcisine sıfırla. Hassasiyet ok tuşlarına da uygulanır.', 'Arrows / drag: look · Shift: faster · PageUp/PageDown: height · O: local inspection · Escape: return to saved panorama · R: reset to API observer. Sensitivity also applies to arrow keys.')}</p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {text('Görsel kamera yüksekliği (API gözü–', 'Visual camera height (API eye–')}{MAX_CAMERA_ALTITUDE_M / 1000} km)
            <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('lower')}>{text('Alçal', 'Lower')}</button>
            <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('higher')}>{text('Yüksel', 'Raise')}</button>
            <button type="button" style={button} disabled={status !== 'ready'} onClick={() => act('observer')}>{text('API gözlemcisine dön', 'Return to API observer')}</button>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8 }}>
            <input type="checkbox" checked={altitudeWheel} onChange={event => setAltitudeWheel(event.target.checked)} />
            {text('Panorama tekerleği: üstel kamera yüksekliği (kapalı: görüş açısı; yerel incelemede: mesafe)', 'Panorama wheel: exponential camera height (off: field of view; local inspection: distance)')}
          </label>
          {textureWarnings.map(warning => <p key={warning}>{localizeError(warning)}</p>)}
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
            <input type="checkbox" checked={shadows} onChange={event => setShadows(event.target.checked)} />
            {text('Arazi gölgeleri (yaklaşık DEM gölge haritası)', 'Terrain shadows (approximate DEM shadow map)')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input type="checkbox" checked={inspection} onChange={event => setInspection(event.target.checked)} />
            {text('İnceleme ışığı (fiziksel değil; yalnızca arazi)', 'Inspection light (nonphysical; terrain only)')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {text('Görsel pozlama', 'Visual exposure')}
            <input type="range" min="0.9" max="1.5" step="0.01" value={exposure} onChange={event => setExposure(Number(event.target.value))} />
            {format(exposure, 2)}×
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {text('Fiziksel olmayan dolgu', 'Nonphysical fill')}
            <input type="range" min="0" max="0.3" step="0.01" disabled={!inspection} value={inspectionFill} onChange={event => setInspectionFill(Number(event.target.value))} />
            {format(inspectionFill, 2)}
          </label>
          <p id="compass-night-vision-help">{text('Gece görüşü varsayılan olarak kapalıdır. Gri tonlu, fiziksel olmayan arazi gösterimidir; karanlık yüzeylerde doku ve ölçülmüş normal yönlerini sabit yerel yönlü bir kabartma ipucuyla görselleştirir. Bu yön Güneş değildir; fiziksel aydınlatma, spektral ölçüm veya gerçek ışık değildir. Güneş vektörü, DEM gölge hesabı, API görünürlüğü ve gerçek güneşlenme ölçümleri değişmez. İnceleme ışığından bağımsızdır; kapatınca özgün arazi görünümü ve seçili pozlama/dolgu ayarları korunur. Güneş ve Dünya bu renklendirmeden etkilenmez.', 'Night vision is off by default. It is a grayscale, nonphysical terrain display; a fixed local directional relief cue visualizes texture and measured normals on dark surfaces. This direction is not the Sun; it is not physical illumination, a spectral measurement or real light. The Sun vector, DEM shadow calculation, API visibility and actual illumination measurements are unchanged. It is independent of inspection light; turning it off preserves the original terrain appearance and selected exposure/fill settings. The Sun and Earth are unaffected by this coloring.')}</p>
          <p>{text('Pozlama yalnızca görsel parlaklık ayarıdır; Güneş yönü ve DEM gölgeleri korunur, doku ve yüzey rengi değiştirilmez. Dolgu varsayılan olarak kapalıdır; açıldığında geceyi de görünür yapabilen fiziksel olmayan inceleme yardımıdır. Bu ayarlar API görünürlüğünü değiştirmez.', 'Exposure is a visual brightness adjustment only; Sun direction and DEM shadows are preserved, and texture and surface color are not changed. Fill is off by default; when enabled it is a nonphysical inspection aid that can also make night terrain visible. These settings do not change API visibility.')}</p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {text('Sürükleme hassasiyeti', 'Drag sensitivity')}
            <input type="range" min="0.25" max="2" step="0.25" value={sensitivity} onChange={event => setSensitivity(Number(event.target.value))} />
            {format(sensitivity, 2)}×
          </label>
        </div>
      </details>
    </section>
  );
}
