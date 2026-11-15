import { API_BASE } from './config';

export interface DiscoveryRequest {
  start_utc: string;
  end_utc: string;
  duration_hours?: number;
  cadence_hours?: number;
  step_seconds?: number;
  min_sunlight_hours?: number;
  min_sunlight_fraction?: number;
  min_earth_hours?: number;
  min_earth_fraction?: number;
  max_slope_deg?: number;
  spatial_resolution_m?: number;
  max_candidates?: number;
  max_results?: number;
}

export interface DiscoveryWindow {
  start_utc: string;
  end_utc: string;
  duration_hours: number;
  score: number;
  sun: {
    total_sunlight_hours: number;
    sunlight_percentage: number;
    intervals?: {
      total_visible_hours: number;
      intervals: Array<{
        start_utc: string;
        end_utc: string;
        clipped_start: boolean;
        clipped_end: boolean;
      }>;
    };
  };
  earth: {
    total_earth_visible_hours: number;
    earth_visible_percentage: number;
    intervals?: {
      total_visible_hours: number;
      intervals: Array<{
        start_utc: string;
        end_utc: string;
        clipped_start: boolean;
        clipped_end: boolean;
      }>;
    };
  };
}

export interface DiscoveryCandidate {
  region_id: string;
  lat: number;
  lon: number;
  score: number;
  local_slope: {
    slope_deg: number | null;
    fit_rms_m?: number;
    grid_spacing_m?: number;
  };
  horizon_coverage: {
    surface_elevation_m: number;
    max_radius_m: number;
    azimuth_step_deg: number;
  };
  bounds_projected_m: {
    x_min: number;
    x_max: number;
    y_min: number;
    y_max: number;
  };
  windows: DiscoveryWindow[];
}

export interface DiscoveryResponse {
  results: DiscoveryCandidate[];
  total_candidates: number;
  metadata: {
    evaluated_candidates: number;
    evaluated_windows: number;
    matched_regions: number;
    rejected_regions: number;
    rejected_reason_counts: Record<string, number>;
    unique_timestamps: number;
    limits: string[];
    ordering: string;
    coverage?: {
      dem_shape: number[];
      dem_spacing_m: number;
      dem_sha256: string;
      bounds_projected_m: { x_min: number; x_max: number; y_min: number; y_max: number };
    };
    criteria?: Record<string, unknown>;
  };
}

export async function discoverCandidates(
  request: DiscoveryRequest,
  signal?: AbortSignal
): Promise<DiscoveryResponse> {
  const response = await fetch(`${API_BASE}/skyview/discovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    let detail: unknown;
    try {
      detail = (await response.json()).detail;
    } catch {
      /* non-JSON proxy */
    }
    console.warn('Aday keşfi API hatası', detail);
    throw new Error(
      response.status === 503
        ? 'Bilimsel veri kullanılamıyor: SPICE çekirdeklerini ve ölçülmüş hesaplama DEM dosyasını kontrol edin.'
        : response.status === 422
        ? 'Aday keşfi parametreleri geçersiz. Tarih aralığını, süre ve eğim limitlerini kontrol edin.'
        : `Aday keşfi başarısız (HTTP ${response.status}).`
    );
  }

  return response.json();
}
