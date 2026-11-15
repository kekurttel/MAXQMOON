import { fetchTerrainAsset } from './terrainAsset';
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { SkyPoint, SkySeries, SkySite } from '../../services/skyview';
import { useI18n } from '../../i18n';
import { lunarLocationToScene, lunarSphereBasis, visibleLunarSurfaceLocation, LunarLocation, DEFAULT_GLOBE_SITE, measuredDemBounds, measuredDemBoundary, inverseLunarSouth, measuredDemMatches, measuredDemSupport } from './lunarLocation';
import { CompassDem, parseCompassDem } from './compassTerrain';
import { DEFAULT_SYSTEM_FOCUS, interpolateSystemCamera, reconstructSystem, systemFocusFit, SYSTEM_RADII_KM, SystemCameraPose, SystemFocus, Vec3 } from './systemGeometry';
import './SystemView.css';
export type { LunarLocation, LocationSlot, MarkedLocations } from './lunarLocation';

export interface SystemViewProps {
  series: SkySeries | null;
  point: SkyPoint | null;
  /** Explicit hand-off only; this component never fetches science data. */
  onSurface?: () => void;
  onEnterPanorama?: (location: LunarLocation) => void;
  selectedLocation?: LunarLocation;
  onRejectLocation?: (location: LunarLocation, message: string) => void;
  catalogSites?: SkySite[];
  selectionTarget?: 'A' | 'B' | null;
  onSelectForPlanner?: (target: 'A' | 'B', location: LunarLocation) => void;
  onCancelPlannerPick?: () => void;
}
type Focus = SystemFocus;

/** Kilometres at true radii/distances. Local ENU-equivalent reconstruction only. */
export default function SystemView({ series, point, onSurface, onEnterPanorama, selectedLocation, onRejectLocation, catalogSites = [], selectionTarget, onSelectForPlanner, onCancelPlannerPick }: SystemViewProps) {
  const { language } = useI18n();
  const text = (tr: string, en: string) => language === 'tr' ? tr : en;
  const localizeError = (message: string) => {
    const messages: Record<string, [string, string]> = {
      'WebGL veya sahne verisi kullanılamıyor.': ['WebGL veya sahne verisi kullanılamıyor.', 'WebGL or scene data is unavailable.'],
      'Doku yüklenemedi: dokusuz küre gösteriliyor; coğrafya uydurulmuyor.': ['Doku yüklenemedi: dokusuz küre gösteriliyor; coğrafya uydurulmuyor.', 'Texture could not be loaded: an untextured sphere is shown; no geography is invented.'],
      'Ölçülmüş DEM yüklenemedi.': ['Ölçülmüş DEM yüklenemedi.', 'Measured DEM could not be loaded.'],
      'Küre DEM’i ile analiz DEM’i uyuşmuyor. Seçim doğrulanamıyor.': ['Küre DEM’i ile analiz DEM’i uyuşmuyor. Seçim doğrulanamıyor.', 'Globe DEM does not match the analysis DEM. Selection cannot be verified.'],
      'DEM kimliği bu tarayıcıda doğrulanamadı. Güvenli bağlantıyla yeniden deneyin.': ['DEM kimliği bu tarayıcıda doğrulanamadı. Güvenli bağlantıyla yeniden deneyin.', 'DEM identity could not be verified in this browser. Retry over a secure connection.'],
      'Küre DEM’i ile analiz DEM’inin dosya kimliği farklı.': ['Küre DEM’i ile analiz DEM’inin dosya kimliği farklı.', 'Globe DEM and analysis DEM file identities differ.'],
      'DEM kapsamı doğrulanamadı.': ['DEM kapsamı doğrulanamadı.', 'DEM coverage could not be verified.'],
    };
    return messages[message] ? text(...messages[message]) : message;
  };
  const [dem, setDem] = useState<CompassDem | null>(null);
  const [coverageError, setCoverageError] = useState('');
  const [draft, setDraft] = useState<LunarLocation | null>(selectedLocation || null);
  const [hover, setHover] = useState<LunarLocation | null>(null);
  const provenance = series?.horizon.provenance;
  useEffect(() => {
    const controller = new AbortController();
    setDem(null); setCoverageError('');
    (async () => {
      try {
        const targetFile = (provenance && (provenance.sha256 === '830f54727e68f2c2c95e739a1bea21b6476a6f979876d0126c8b10a6ff73eb9e' || provenance.rows === 7760))
          ? 'pole_dem_60s.bin'
          : (provenance && (provenance.sha256 === '7210a3774f7bb0aa26e8040e681b59c388487d9d0816d8708eb833f55ca4f617' || provenance.rows === 3812))
          ? 'pole_dem_75s.bin'
          : 'pole_dem.bin';
        const buffer = await fetchTerrainAsset(process.env.PUBLIC_URL || '', targetFile, controller.signal);
        const grid = parseCompassDem(buffer);
        if (provenance) {
          if (!measuredDemMatches(grid, provenance)) throw new Error('Küre DEM’i ile analiz DEM’i uyuşmuyor. Seçim doğrulanamıyor.');
          if (!globalThis.crypto?.subtle) throw new Error('DEM kimliği bu tarayıcıda doğrulanamadı. Güvenli bağlantıyla yeniden deneyin.');
          const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
          const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
          if (hash !== provenance.sha256) throw new Error('Küre DEM’i ile analiz DEM’inin dosya kimliği farklı.');
        }
        if (!controller.signal.aborted) setDem(grid);
      } catch (cause) {
        if (!controller.signal.aborted) setCoverageError(cause instanceof Error ? cause.message : 'DEM kapsamı doğrulanamadı.');
      }
    })();
    return () => controller.abort();
  }, [provenance]);
  const coordinates = (location: LunarLocation) => `${location.lat.toFixed(5)}°, ${location.lon.toFixed(5)}°`;
  const pick = (location: LunarLocation) => { setDraft(location); };
  const applyDraft = () => {
    if (!draft) return;
    if (selectionTarget) {
      onSelectForPlanner?.(selectionTarget, draft);
      setDraft(null);
      return;
    }
    const support = measuredDemSupport(dem, draft);
    if (support !== 'supported') {
      onRejectLocation?.(draft, support === 'unavailable' ? text('Arazi verisi doğrulanamadı. Lütfen yeniden deneyin.', 'Terrain data could not be verified. Please try again.') : text('Bu konum için ayrıntılı arazi verisi yok; mevcut veri güney kutbunu kapsıyor.', 'No detailed terrain data is available for this location; current data covers the south pole.'));
      return;
    }
    onEnterPanorama?.(draft);
    setDraft(null);
  };
  const live = useRef({ pick, draft });
  live.current = { pick, draft };
  const refreshMarkers = useRef<(() => void) | null>(null);
  useEffect(() => { refreshMarkers.current?.(); }, [draft]);
  const host = useRef<HTMLDivElement>(null);
  const currentObservation = useRef({ series, point });
  currentObservation.current = { series, point };
  const updateObservation = useRef<(() => void) | null>(null);
  useEffect(() => {
    updateObservation.current?.();
    refreshMarkers.current?.();
  }, [series, point]);
  const siteLat = series?.site.lat_deg ?? DEFAULT_GLOBE_SITE.lat;
  const siteLon = series?.site.lon_deg ?? DEFAULT_GLOBE_SITE.lon;
  const hasObservation = !!(series && point);
  const actions = useRef<{ focus: (focus: Focus) => void; zoom: (factor: number) => void; align: () => void } | null>(null);
  const [error, setError] = useState('');
  const [textureWarning, setTextureWarning] = useState('');
  const [nearMoon, setNearMoon] = useState(false);
  const [focus, setFocus] = useState<Focus>(DEFAULT_SYSTEM_FOCUS);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setError(''); setTextureWarning(''); setFocus(DEFAULT_SYSTEM_FOCUS); setNearMoon(false);
    let model: ReturnType<typeof reconstructSystem> | null;
    const moonCenter: Vec3 = [0, 0, 0];
    let renderer: THREE.WebGLRenderer;
    try {
      const observation = currentObservation.current;
      model = observation.series && observation.point ? reconstructSystem(observation.series.site, observation.point) : null;
      renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, alpha: true });
    } catch (cause) {
      setError('WebGL veya sahne verisi kullanılamıyor.');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
    container.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e10);
    // Separate scenes, not light layers: each body's phase uses its own Sun vector.
    const moonScene = new THREE.Scene(), earthScene = new THREE.Scene(), sunScene = new THREE.Scene();
    const geometry = new THREE.SphereGeometry(1, 96, 64);
    const moonMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const earthMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0c4 });
    const v = (tuple: Vec3) => new THREE.Vector3(...tuple);
    const makeBody = (scene: THREE.Scene, center: Vec3, radius: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(v(center)); mesh.scale.setScalar(radius); scene.add(mesh); return mesh;
    };
    const site = { lat: siteLat, lon: siteLon };
    const moon = makeBody(moonScene, moonCenter, SYSTEM_RADII_KM.moon, moonMaterial);
    const coverageGeometry = new THREE.BufferGeometry();
    const coverageMaterial = new THREE.LineBasicMaterial({ color: 0x8fffb8, transparent: true, opacity: 0.6 });
    if (dem) coverageGeometry.setFromPoints(measuredDemBoundary(dem).map(location => v(lunarLocationToScene(location, site)).multiplyScalar(SYSTEM_RADII_KM.moon + 2)));
    moonScene.add(new THREE.LineLoop(coverageGeometry, coverageMaterial));
    const basis = lunarSphereBasis(site).map(v);
    moon.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(basis[0], basis[1], basis[2]));
    // Coordinates use the explicit local frame, never texture pixels or UV inference.
    const markerGeometry = new THREE.SphereGeometry(1, 16, 12);
    const markerMaterials = [
      new THREE.MeshBasicMaterial({ color: 0xffc857 }),
      new THREE.MeshBasicMaterial({ color: 0x48d9ff }),
    ];
    const markerMeshes = markerMaterials.map(material => {
      const marker = new THREE.Mesh(markerGeometry, material);
      marker.scale.setScalar(20); moonScene.add(marker); return marker;
    });
    refreshMarkers.current = () => {
      const draft = live.current.draft;
      const observation = currentObservation.current;
      const observedLocation = observation.series?.site;
      markerMeshes[0].visible = !!draft;
      if (draft) markerMeshes[0].position.copy(v(lunarLocationToScene(draft, site))).multiplyScalar(SYSTEM_RADII_KM.moon + 8);
      markerMeshes[1].visible = !!observedLocation;
      if (observedLocation) {
        markerMeshes[1].position.copy(v(lunarLocationToScene({ lat: observedLocation.lat_deg, lon: observedLocation.lon_deg }, site)))
          .multiplyScalar(SYSTEM_RADII_KM.moon + 8);
      }
      invalidate();
    };
    const earthBody = model ? makeBody(earthScene, model.earth, SYSTEM_RADII_KM.earth, earthMaterial) : null;
    const sunBody = model ? makeBody(sunScene, model.sun, SYSTEM_RADII_KM.sun, sunMaterial) : null;
    const illuminate = (scene: THREE.Scene, center: Vec3, direction: Vec3) => {
      const light = new THREE.DirectionalLight(0xffffff, 2.5);
      light.target.position.copy(v(center));
      light.position.copy(v(center)).addScaledVector(v(direction), 10000);
      scene.add(light, light.target);
      return light;
    };
    const moonLight = model ? illuminate(moonScene, moonCenter, model.moonLight) : null;
    const earthLight = model ? illuminate(earthScene, model.earth, model.earthLight) : null;
    if (!model) {
      // Unlit cartographic locator only: no invented Sun direction or phase.
      moonScene.add(new THREE.AmbientLight(0xffffff, 2));
    }
    let disposed = false, frame = 0;
    let distance = 1e6, yaw = 0, pitch = 0.35;
    const target = new THREE.Vector3();
    const normal = v(model?.planeNormal ?? [0, 0, 1]);
    const up = model ? v(model.earth).addScaledVector(normal, -v(model.earth).dot(normal)) : v([0, 1, 0]);
    if (up.lengthSq() < 1e-12) {
      up.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0);
      up.addScaledVector(normal, -up.dot(normal));
    }
    up.normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    const minDistance = () => focusValue === 'moon' ? SYSTEM_RADII_KM.moon + 2 : focusValue === 'earth' ? SYSTEM_RADII_KM.earth + 10 : 10;
    let focusValue: Focus = DEFAULT_SYSTEM_FOCUS;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let transition: { from: SystemCameraPose; to: SystemCameraPose; start: number } | null = null;
    const pose = (): SystemCameraPose => ({ target: target.toArray() as Vec3, distance, yaw, pitch });
    const applyPose = (value: SystemCameraPose) => {
      target.set(...value.target); distance = value.distance; yaw = value.yaw; pitch = value.pitch;
    };
    const transitionTo = (to: SystemCameraPose, immediate = false) => {
      if (motion.matches || immediate) { transition = null; applyPose(to); }
      else transition = { from: pose(), to, start: performance.now() };
      invalidate();
    };
    const motionChanged = () => {
      if (motion.matches && transition) { applyPose(transition.to); transition = null; invalidate(); }
    };
    motion.addEventListener('change', motionChanged);
    const updateCamera = () => {
      const direction = normal.clone().multiplyScalar(Math.cos(pitch) * Math.cos(yaw))
        .addScaledVector(right, Math.cos(pitch) * Math.sin(yaw)).addScaledVector(up, Math.sin(pitch));
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.up.copy(Math.abs(direction.dot(up)) > 0.99 ? right : up); camera.lookAt(target);
      setNearMoon(camera.position.length() - SYSTEM_RADII_KM.moon < 100);
    };
    const render = (now: number) => {
      frame = 0;
      if (disposed) return;
      if (transition) {
        const progress = (now - transition.start) / 650;
        applyPose(interpolateSystemCamera(transition.from, transition.to, progress));
        if (progress >= 1) transition = null;
      }
      updateCamera(); renderer.clear();
      renderer.render(moonScene, camera); renderer.render(earthScene, camera); renderer.render(sunScene, camera);
      if (transition) invalidate();
    };
    const invalidate = () => { if (!disposed && !frame) frame = requestAnimationFrame(render); };
    const textures: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    const load = (file: string, material: THREE.MeshLambertMaterial) => {
      loader.load(`${process.env.PUBLIC_URL}/textures/${file}`, texture => {
        if (disposed) { texture.dispose(); return; }
        textures.push(texture); texture.colorSpace = THREE.SRGBColorSpace;
        material.map = texture; material.needsUpdate = true; invalidate();
      }, undefined, () => { if (!disposed) setTextureWarning('Doku yüklenemedi: dokusuz küre gösteriliyor; coğrafya uydurulmuyor.'); });
    };
    load('moon-lroc-4k.jpg', moonMaterial); load('earth.jpg', earthMaterial);
    const selectFocus = (next: Focus, immediate = false) => {
      const fit = systemFocusFit(next, model, camera.fov, camera.aspect);
      if (!fit) return;
      focusValue = next; setFocus(next);
      transitionTo({ target: fit.center, distance: fit.distance, yaw, pitch }, immediate);
    };
    const zoom = (factor: number) => { transition = null; distance = THREE.MathUtils.clamp(distance * factor, minDistance(), 3e9); invalidate(); };
    updateObservation.current = () => {
      const observation = currentObservation.current;
      if (!observation.series || !observation.point || !earthBody || !sunBody || !moonLight || !earthLight) return;
      model = reconstructSystem(observation.series.site, observation.point);
      earthBody.position.copy(v(model.earth)); sunBody.position.copy(v(model.sun));
      moonLight.position.copy(v(model.moonLight)).multiplyScalar(10000);
      earthLight.target.position.copy(v(model.earth));
      earthLight.position.copy(v(model.earth)).addScaledVector(v(model.earthLight), 10000);
      // Keep the presented camera/orbit basis while scrubbing time or drafting a location.
      invalidate();
    };
    actions.current = { focus: selectFocus, zoom, align: () => transitionTo({ ...pose(), yaw: 0, pitch: 0 }) };
    const resize = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); invalidate();
    });
    camera.aspect = Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    resize.observe(container); selectFocus(DEFAULT_SYSTEM_FOCUS, true);
    if (dem) {
      // Frame the actual file footprint, never a hard-coded latitude cap or catalog radius.
      const bounds = measuredDemBounds(dem);
      const center = inverseLunarSouth((bounds.x_min + bounds.x_max) / 2, (bounds.y_min + bounds.y_max) / 2);
      const direction = v(lunarLocationToScene(center, site));
      const surface = direction.clone().multiplyScalar(SYSTEM_RADII_KM.moon);
      const radius = Math.max(...measuredDemBoundary(dem).map(location => v(lunarLocationToScene(location, site)).multiplyScalar(SYSTEM_RADII_KM.moon).distanceTo(surface)));
      const halfFov = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
      transitionTo({ target: moonCenter, distance: SYSTEM_RADII_KM.moon + radius / Math.tan(halfFov) * 1.2,
        yaw: Math.atan2(direction.dot(right), direction.dot(normal)), pitch: Math.asin(THREE.MathUtils.clamp(direction.dot(up), -1, 1)) }, true);
    }
    refreshMarkers.current?.();
    const canvas = renderer.domElement;
    let drag: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
    const down = (event: PointerEvent) => { if (event.button !== 0) return; transition = null; container.focus(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false }; canvas.setPointerCapture(event.pointerId); };
    const locationAt = (event: PointerEvent): LunarLocation | null => {
      updateCamera(); camera.updateMatrixWorld(); moon.updateMatrixWorld();
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      // Exact reference sphere avoids triangulation-dependent coordinate drift at close zoom.
      const hit = ray.ray.intersectSphere(new THREE.Sphere(v(moonCenter), SYSTEM_RADII_KM.moon), new THREE.Vector3());
      return hit ? visibleLunarSurfaceLocation(ray.ray.origin.toArray() as Vec3, hit.toArray() as Vec3, site, model ? [{ center: model.earth, radius: SYSTEM_RADII_KM.earth }] : []) : null;
    };
    let hoverTime = 0;
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) {
        if (performance.now() - hoverTime > 80) { hoverTime = performance.now(); setHover(locationAt(event)); }
        return;
      }
      drag.moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5;
      yaw -= (event.clientX - drag.x) * 0.005; pitch = THREE.MathUtils.clamp(pitch + (event.clientY - drag.y) * 0.005, -1.5, 1.5);
      drag.x = event.clientX; drag.y = event.clientY; invalidate();
    };
    const end = (event: PointerEvent) => {
      if (drag?.id === event.pointerId && !drag.moved && event.type === 'pointerup') {
        const location = locationAt(event);
        if (location) {
          if (focusValue !== 'moon') selectFocus('moon');
          else live.current.pick(location);
        }
      }
      drag = null;
    };
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoom(Math.exp(THREE.MathUtils.clamp(event.deltaY, -200, 200) * 0.002)); };
    const key = (event: KeyboardEvent) => {
      if (event.target !== container) return;
      if (['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); transition = null;
        if (event.key === '+' || event.key === '=') zoom(0.8);
        else if (event.key === '-') zoom(1.25);
        else { yaw += event.key === 'ArrowLeft' ? -0.08 : event.key === 'ArrowRight' ? 0.08 : 0; pitch = THREE.MathUtils.clamp(pitch + (event.key === 'ArrowUp' ? 0.08 : event.key === 'ArrowDown' ? -0.08 : 0), -1.5, 1.5); invalidate(); }
      }
    };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', wheel, { passive: false }); container.addEventListener('keydown', key);
    return () => {
      disposed = true; transition = null; actions.current = null; refreshMarkers.current = null; updateObservation.current = null; cancelAnimationFrame(frame); resize.disconnect();
      motion.removeEventListener('change', motionChanged);
      coverageGeometry.dispose(); coverageMaterial.dispose();
      markerGeometry.dispose(); markerMaterials.forEach(material => material.dispose());
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end); canvas.removeEventListener('pointercancel', end);
      canvas.removeEventListener('wheel', wheel); container.removeEventListener('keydown', key);
      textures.forEach(texture => texture.dispose()); geometry.dispose();
      moonMaterial.dispose(); earthMaterial.dispose(); sunMaterial.dispose(); renderer.dispose();
      canvas.remove();
    };
  }, [siteLat, siteLon, hasObservation, dem]);

  return <section className="sv-system" aria-label={text('Ay Dünya Güneş sistemi', 'Moon Earth Sun system')}>
    {selectionTarget && (
      <aside className="sv-system-planner-picker-banner sv-system-frost" role="status">
        <div className="sv-planner-picker-info">
          <span className="sv-planner-badge">📍 {text(`Planlayıcı için ${selectionTarget} Noktası Seçimi`, `Select point ${selectionTarget} for the planner`)}</span>
          <p>{text('Ay küresinde dilediğiniz konuma dokunun veya sağ alttaki katalogdan bir nokta seçin.', 'Tap a location on the lunar globe or choose a point from the catalog at the bottom right.')}</p>
          {draft ? <strong>{text('Seçili:', 'Selected:')} {coordinates(draft)} {draft.name ? `(${draft.name})` : ''}</strong> : <em>{text('Henüz nokta seçilmedi (küreye dokunun).', 'No point selected yet (tap the globe).')}</em>}
        </div>
        <div className="sv-planner-picker-actions">
          <button
            className="sv-primary"
            disabled={!draft}
            onClick={() => {
              if (draft) {
                onSelectForPlanner?.(selectionTarget, draft);
                setDraft(null);
              }
            }}
          >
            ✅ {text(`${selectionTarget} Noktası Olarak Ata ve Dön`, `Assign as point ${selectionTarget} and return`)}
          </button>
          {onCancelPlannerPick && <button type="button" onClick={onCancelPlannerPick}>{text('İptal', 'Cancel')}</button>}
        </div>
      </aside>
    )}
    <div className="sv-system-canvas" ref={host} tabIndex={0} aria-label={text('Sistem kamerası: sürükleyerek veya oklarla döndürün, artı ve eksi ile yakınlaşın', 'System camera: drag or use arrows to rotate, plus and minus to zoom')} />
    <nav className="sv-system-nav sv-system-frost" aria-label={text('Cisimler arasında gezinme', 'Navigate between bodies')}>
      {(['moon', 'earth', 'all'] as Focus[]).map(name => <button key={name} disabled={name === 'earth' && !(series && point)} title={name === 'moon' ? text('Ay’a odaklanın; yüzeyden konum seçin', 'Focus on the Moon; select a surface location') : name === 'earth' ? text('Dünya’ya git; Ay bağlantısıyla geri dönün', 'Go to Earth; use the Moon link to return') : text('Tüm cisimleri gerçek uzaklıklarıyla göster', 'Show all bodies at their true distances')} aria-pressed={focus === name} onClick={() => actions.current?.focus(name)}>{name === 'all' ? text('Sistem · 1:1', 'System · 1:1') : name === 'moon' ? text('Ay', 'Moon') : text('Dünya', 'Earth')}</button>)}
    </nav>
    <div className="sv-system-picker sv-system-frost">
      <strong>{text('Güney kutbunda nokta seçin', 'Select a point at the south pole')}</strong>
      <p>{text('İşaretli arazi alanına dokunun; koordinatı kontrol edip gözlemi başlatın.', 'Tap the marked terrain area; check the coordinates and start the observation.')}</p>
      {catalogSites.length > 0 && <label>{text('Hazır gözlem noktası', 'Catalog observation point')}<select aria-label={text('Katalogdan Ay konumu seç', 'Select lunar location from catalog')} value="" onChange={event => { const site = catalogSites.find(site => site.id === event.target.value); if (site) pick({ lat: site.lat, lon: site.lon, name: site.name }); }}>
        <option value="">{text('Nokta seçin', 'Select a point')}</option>{catalogSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>}
      <div className="sv-system-draft" aria-live="polite">{draft ? <><span>{text('Seçilen nokta', 'Selected point')}</span><strong>{coordinates(draft)}</strong>{draft.name && <span>{draft.name}</span>}{measuredDemSupport(dem, draft) !== 'supported' && <p>{dem ? text('Bu konum için arazi verisi yok.', 'No terrain data for this location.') : coverageError ? text('Arazi verisi doğrulanamadı.', 'Terrain data could not be verified.') : text('Arazi verisi kontrol ediliyor…', 'Checking terrain data…')}</p>}</> : <span>{text('Henüz yeni nokta seçilmedi.', 'No new point selected yet.')}</span>}</div>
      <button className="sv-primary" disabled={!draft || (!dem && !coverageError)} onClick={applyDraft}>{selectionTarget ? text(`${selectionTarget} Noktası Olarak Ata`, `Assign as point ${selectionTarget}`) : text('Bu noktayı gözle', 'Observe this point')}</button>
      <small>{text('Arazi verisi yalnız Ay’ın güney kutbundaki sınırlı alanlarda mevcut. Seçiminiz başka bir noktaya taşınmaz.', 'Terrain data is available only in limited areas at the lunar south pole. Your selection will not be moved to another point.')}</small>
    </div>
    <details className="sv-system-tools sv-system-frost">
      <summary>{text('Kamera ve kaynaklar', 'Camera and sources')}</summary>
      <div className="sv-system-scroll">
        <div className="sv-system-row">
          <button disabled={!(series && point)} onClick={() => actions.current?.align()}>{text('Sistem düzlemi', 'System plane')}</button>
          <button aria-label={text('Yakınlaş', 'Zoom in')} onClick={() => actions.current?.zoom(0.7)}>+</button>
          <button aria-label={text('Uzaklaş', 'Zoom out')} onClick={() => actions.current?.zoom(1 / 0.7)}>−</button>
          {onSurface && <button disabled={!nearMoon || !(series && point)} title={text('Mevcut gözlem konumuna dönmek için Ay’a 100 km yaklaşın', 'Approach within 100 km of the Moon to return to the current observation location')} onClick={onSurface}>{text('Mevcut panoramaya dön', 'Return to current panorama')}</button>}
        </div>
        {hover && <p>{text('İmleç:', 'Cursor:')} {coordinates(hover)}</p>}
        <details className="sv-system-provenance">
          <summary>{text('Bilimsel çerçeve ve görsel kaynaklar', 'Scientific frame and visual sources')}</summary>
          <p>{point ? `${new Date(point.time_utc).toLocaleString(language === 'tr' ? 'tr-TR' : 'en-GB', { timeZone: 'UTC' })} UTC` : text('Konum haritası · MOON_ME_DE421', 'Location map · MOON_ME_DE421')} · {text('Sürükleme / oklar: döndür · Tekerlek / ±: yakınlaştır. Gerçek ölçekte Ay ve Dünya, tüm cisimler görünümünde pikselden küçük olabilir.', 'Drag / arrows: rotate · Wheel / ±: zoom. At true scale, the Moon and Earth may be smaller than a pixel in the all-bodies view.')}</p>
          <p>{text('Ay merkezli yerel ENU eşdeğeri (+X doğu, +Y yukarı, −Z kuzey); eylemsiz çerçeve dönüşümü değildir. Güneş/Dünya azimut, yükselim ve uzaklıkları gözlemci vektörüne eklenir. Cisimler ayrı aydınlatılır; karşılıklı tutulmalar modellenmez.', 'Moon-centered local ENU equivalent (+X east, +Y up, −Z north); not an inertial frame transformation. Sun/Earth azimuths, elevations and distances are added to the observer vector. Bodies are illuminated separately; mutual eclipses are not modeled.')}</p>
          <p>{text('İşaretler ve küre MOON_ME_DE421 konumunun yerel bazına kaydedilir. Ay dokusu eşdikdörtgensel harita varsayımıyla yönlendirilir; piksel düzeyinde çerçeve doğruluğu veya SPICE doku yönelimi iddiası yoktur. Dünya dokusunun yönelimi görseldir.', 'Markers and globe are registered to the local basis of the MOON_ME_DE421 location. Lunar texture orientation assumes an equirectangular map; no pixel-level frame accuracy or SPICE texture orientation is claimed. Earth texture orientation is illustrative.')}</p>
          <p>{text('Ay:', 'Moon:')} NASA / GSFC / ASU <a href="https://svs.gsfc.nasa.gov/4720/" target="_blank" rel="noreferrer">LROC</a> {text('(gömülü fotoğrafik aydınlatma). Dünya:', '(embedded photographic lighting). Earth:')} <a href="https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg" target="_blank" rel="noreferrer">{text('Three.js örnek haritası', 'Three.js example map')}</a>{text(', statik; özgün NASA atfı doğrulanmadı. Güneş: dokusuz, ışıldayan küre.', ', static; original NASA attribution not verified. Sun: untextured, luminous sphere.')}</p>
        </details>
      </div>
    </details>
    <div className="sv-system-status" aria-live="polite">
      {error && <p className="sv-system-frost" role="alert">{text('Sistem görüntülenemiyor:', 'System cannot be displayed:')} {localizeError(error)}</p>}

      {!(series && point) && <p className="sv-system-frost">{text('Gözlem verisi yok: yalnız eşit aydınlatılmış Ay konum haritası. Dünya/Güneş konumları ve fiziksel evre gösterilmez.', 'No observation data: only an evenly lit lunar location map. Earth/Sun positions and physical phases are not shown.')}</p>}
      {textureWarning && <p className="sv-system-frost">{localizeError(textureWarning)}</p>}
    </div>
  </section>;
}
