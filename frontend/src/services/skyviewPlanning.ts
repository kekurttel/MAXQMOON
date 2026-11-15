import { API_BASE } from './config';
import { SkySeries } from './skyview';

export interface VisibilitySummary {
  start_utc: string; end_utc: string;
  total_sunlight_hours: number; sunlight_percentage: number;
  total_earth_visible_hours: number; earth_visible_percentage: number;
  visibility_hour_bounds: Record<string, { lower_hours: number; upper_hours: number }>;
  provenance: SkySeries['provenance'];
}
export interface LocalSlope {
  slope_deg: number | null; grid_spacing_m?: number; neighborhood_projected_width_m?: number;
  fit_rms_m?: number; dem_sha256?: string; unavailable_reason?: string;
}
export type PlanningSeries = SkySeries & { planning_summary: VisibilitySummary; local_slope: LocalSlope };
export type Scenario = { site_id: string } | { lat: number; lon: number };
export type PlannerObservation = Scenario & { start_utc: string; end_utc: string; step_seconds?: number };
export type PlanningComparison = { scenarioA: PlanningSeries; scenarioB: PlanningSeries };
export type SearchLocation = { site_id: string } | { lat: number; lon: number; name?: string };
export interface SearchCriteria {
  site_ids?: string[]; locations?: SearchLocation[]; start_utc: string; end_utc: string; duration_hours: number;
  cadence_hours: number; step_seconds: number; min_sunlight_hours: number;
  min_sunlight_fraction: number; min_earth_hours: number; min_earth_fraction: number;
  max_slope_deg: number | null; max_results: number;
}
export interface SearchResult {
  results: { site: { id?: string | null; site_id?: string | null; name: string; lat: number; lon: number }; summary: VisibilitySummary; local_slope: LocalSlope;
    step_seconds?: number; horizon_coverage: SkySeries['horizon']['coverage']; dem_provenance: SkySeries['horizon']['provenance'] }[];
  metadata: { evaluated_windows: number; matched_windows: number; rejected_sites: { site_id: string | null; reason: string; location_index?: number; name?: string; lat?: number; lon?: number }[] };
}
async function post<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}/skyview/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    // Keep raw diagnostics out of visible strings (the science API currently uses English).
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { /* non-JSON proxy */ }
    console.warn('Planlama API ayrıntısı', detail);
    throw new Error(response.status === 503 ? 'Bilimsel veri kullanılamıyor: SPICE çekirdeklerini ve ölçülmüş hesaplama DEM dosyasını kontrol edin.'
      : response.status === 422 ? 'İstek veya ölçülmüş DEM kapsamı uygun değil. Tarih aralığını, örnek bütçesini ve koordinatları kontrol edin.'
      : `Planlama isteği başarısız (HTTP ${response.status}).`);
  }
  return response.json();
}
export function compareSites(a: PlannerObservation, b: PlannerObservation, signal: AbortSignal): Promise<PlanningComparison>;
export function compareSites(a: Scenario, b: Scenario, start: string, end: string, step: number, signal: AbortSignal): Promise<PlanningComparison>;
export function compareSites(a: Scenario | PlannerObservation, b: Scenario | PlannerObservation, startOrSignal: string | AbortSignal, end?: string, step?: number, signal?: AbortSignal): Promise<PlanningComparison> {
  // Retain the original shared-window call for existing integrations.
  if (typeof startOrSignal === 'string') {
    const window = { start_utc: startOrSignal, end_utc: end, step_seconds: step };
    return post<PlanningComparison>('compare-planning', { scenarioA: { ...a, ...window }, scenarioB: { ...b, ...window } }, signal!);
  }
  return post<PlanningComparison>('compare-planning', { scenarioA: a, scenarioB: b }, startOrSignal);
}
export const searchSites = (criteria: SearchCriteria, signal: AbortSignal) => post<SearchResult>('search', criteria, signal);
