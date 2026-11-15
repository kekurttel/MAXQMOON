import { API_BASE } from './config';

export interface SkySite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  dem_covered?: boolean;
}

export interface SkyBody {
  azimuth_deg: number;
  elevation_deg: number;
  distance_km: number;
  horizon_elevation_deg: number;
  clearance_deg: number;
  center_visible: boolean;
  next_transition: {
    after_utc: string;
    by_utc: string;
    becomes_visible: boolean;
  } | null;
}

export interface SkyPoint {
  time_utc: string;
  sun: SkyBody;
  earth: SkyBody;
  // Root-level hours to the next visible-to-hidden bracket's by_utc,
  // even while currently hidden. Null means no set found in this window.
  // Optional only for older responses; missing is unknown, never zero.
  hours_until_sunset?: number | null;
  hours_until_earthset?: number | null;
}

export interface SkyHorizon {
  frame: string;
  geodetic: string;
  azimuths_deg: number[];
  elevations_deg: number[];
  surface_elevation_m: number;
  observer_height_m: number;
  coverage: {
    kind: string;
    requested_max_distance_m: number;
    distance_step_m: number;
    near_sample_distances_m: number[];
    azimuth_step_deg: number;
    truncated: boolean;
    complete_within_requested_radius: boolean;
    rays: {
      azimuth_deg: number;
      max_distance_m: number;
      sample_count: number;
      truncated: boolean;
    }[];
    per_ray_max_distance_m: number[];
    whole_moon_horizon_certified: boolean;
    beyond_sampled_extent: string;
    limitations: string[];
  };
  provenance: {
    file: string;
    sha256: string;
    packaged_sha256: string;
    matches_packaged_asset: boolean;
    hash_meaning: string;
    frame: string;
    geodetic: string;
    longitude_convention: string;
    reference_radius_m: number;
    height_datum: string;
    projection: string;
    source_product: string;
    source_label_url: string | null;
    source_coordinate_system_name: string | null;
    nodata_policy: string;
    rows: number;
    cols: number;
    spacing_m: number;
    line0: number;
    sample0: number;
    scale_m: number;
    bounds_projected_m: { x_min: number; x_max: number; y_min: number; y_max: number };
  };
}

export interface VisibilityInterval {
  start_utc: string;
  end_utc: string;
  start_bracket: { after_utc: string; by_utc: string } | null;
  end_bracket: { after_utc: string; by_utc: string } | null;
  clipped_start: boolean;
  clipped_end: boolean;
}

export interface SkyVisibilityIntervals {
  sun: { intervals: VisibilityInterval[]; total_visible_hours: number };
  earth: { intervals: VisibilityInterval[]; total_visible_hours: number };
  method: 'sampled-center-visibility-midpoint';
  resolution_seconds: number;
}

export interface LocalSlope {
  slope_deg: number | null;
  method?: string;
  frame?: string;
  sample_count?: number;
  grid_spacing_m?: number;
  neighborhood_projected_width_m?: number;
  fit_rms_m?: number;
  dem_sha256?: string;
  limits?: string;
  unavailable_reason?: string;
}

export interface SkySeries {
  frame: string;
  site: {
    lat_deg: number;
    lon_deg: number;
    surface_elevation_m: number;
    observer_height_m: number;
  };
  start_utc: string;
  end_utc: string;
  step_seconds: number;
  horizon: SkyHorizon;
  points: SkyPoint[];
  visibility_intervals?: SkyVisibilityIntervals;
  local_slope?: LocalSlope;
  provenance: {
    engine: string;
    frame: string;
    time_input: string;
    aberration_correction: string;
    coordinates: string;
    kernels: { file: string; sha256: string }[];
    visibility_definition: string;
    limits: string[];
  };
}

export interface SkySeriesRequest {
  site_id: string;
  start_utc: string;
  end_utc: string;
  step_seconds: number;
  observer_height_m: number;
}

export interface CustomSkyRequest {
  lat: number;
  lon: number;
  start_utc: string;
  end_utc: string;
  step_seconds: number;
}

export function fetchCustomSkySeries(params: CustomSkyRequest, signal?: AbortSignal): Promise<SkySeries> {
  return request<SkySeries>('/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
}

function errorDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item: { loc?: (string | number)[]; msg?: string }) =>
      `${item.loc?.join('.') || 'İstek'}: ${item.msg || 'Geçersiz değer'}`
    ).join('; ');
  }
  return '';
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/skyview${path}`, init);
  if (!response.ok) {
    let message = '';
    try {
      const body: { detail?: unknown } = await response.json();
      message = errorDetail(body.detail);
    } catch {
      // Proxies can return HTML or no body; retain HTTP status in that case.
    }
    throw new Error(message || `Gökyüzü API hatası: HTTP ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchSkySites(signal?: AbortSignal): Promise<SkySite[]> {
  const result = await request<{ sites: SkySite[]; limits: string }>('/sites', { signal });
  return result.sites;
}

export function fetchSkySeries(params: SkySeriesRequest, signal?: AbortSignal): Promise<SkySeries> {
  return request<SkySeries>('/series', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
}
