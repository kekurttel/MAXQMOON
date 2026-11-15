import type { SkySite } from '../../services/skyview';
import { normalizeLongitude } from './lunarLocation';
import type { LunarLocation } from './lunarLocation';

export type SelectedLocation = LunarLocation & { siteId?: string };
export type ObservationTime = { date: string; time?: string; days: number; endUtc?: string; stepSeconds?: number };

export function observationStartUtc(request: Pick<ObservationTime, 'date' | 'time'>): string {
  const clock = request.time || '00:00';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.date) || !/^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(clock)) throw new Error('Geçerli UTC başlangıç zamanı seçin.');
  const start = new Date(`${request.date}T${clock.length === 5 ? `${clock}:00` : clock}Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== request.date) throw new Error('Geçerli UTC başlangıç zamanı seçin.');
  return start.toISOString();
}

export function observationWindow(request: ObservationTime): { start_utc: string; end_utc: string; step_seconds: number } {
  const start = new Date(observationStartUtc(request));
  const end = request.endUtc ? new Date(request.endUtc) : new Date(start.getTime() + request.days * 86400000);
  const step = request.stepSeconds ?? 600;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('Geçerli UTC başlangıç ve bitiş zamanı seçin.');
  if (!Number.isInteger(step) || step < 60 || step > 86400 || Math.ceil((end.getTime() - start.getTime()) / (step * 1000)) + 1 > 2049) throw new Error('En çok 2049 örnek hesaplanabilir. Aralığı kısaltın veya örnek adımını büyütün.');
  return { start_utc: start.toISOString(), end_utc: end.toISOString(), step_seconds: step };
}

export function observationFromPlanner(scenario: { site_id?: string; lat?: number; lon?: number; start_utc: string; end_utc: string; step_seconds?: number }): ObservationRequest {
  const start = new Date(scenario.start_utc), end = new Date(scenario.end_utc);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('Planlayıcı UTC aralığı geçersiz.');
  const iso = start.toISOString();
  const time = { date: iso.slice(0, 10), time: iso.slice(11, 23), days: (end.getTime() - start.getTime()) / 86400000, endUtc: end.toISOString(), stepSeconds: scenario.step_seconds ?? 600 };
  observationWindow(time);
  if (scenario.site_id) return { ...time, kind: 'catalog', siteId: scenario.site_id };
  if (!Number.isFinite(scenario.lat) || !Number.isFinite(scenario.lon) || scenario.lat! < -90 || scenario.lat! > 90 || scenario.lon! < -180 || scenario.lon! > 180) throw new Error('Planlayıcı koordinatı geçersiz.');
  return { ...time, kind: 'custom', lat: scenario.lat!, lon: scenario.lon! };
}
export type ObservationRequest = ObservationTime & (
  { kind: 'catalog'; siteId: string } | { kind: 'custom'; lat: number; lon: number }
);

// Floating-point round trips only (~0.3 mm on the Moon), never nearest-site snapping.
const COORDINATE_TOLERANCE_DEG = 1e-8;
export function matchCatalogLocation(location: LunarLocation, sites: readonly SkySite[]): SkySite | undefined {
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return undefined;
  return sites.find(site => Math.abs(site.lat - location.lat) <= COORDINATE_TOLERANCE_DEG
    && Math.abs(normalizeLongitude(site.lon - location.lon)) <= COORDINATE_TOLERANCE_DEG);
}

export function resolveLocation(location: LunarLocation, sites: readonly SkySite[]): SelectedLocation {
  const catalog = matchCatalogLocation(location, sites);
  // Coordinates, not an unverified/stale ID, establish catalog identity.
  const lon = location.lon < -180 || location.lon > 180 ? normalizeLongitude(location.lon) : location.lon;
  return catalog ? { ...catalog, siteId: catalog.id } : { lat: location.lat, lon, name: location.name };
}

export function observationForLocation(location: LunarLocation, sites: readonly SkySite[], time: ObservationTime): ObservationRequest {
  const selected = resolveLocation(location, sites);
  return selected.siteId
    ? { ...time, kind: 'catalog', siteId: selected.siteId }
    : { ...time, kind: 'custom', lat: selected.lat, lon: selected.lon };
}
