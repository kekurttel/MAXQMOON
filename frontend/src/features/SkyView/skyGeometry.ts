export interface Skyline {
  azimuths_deg: number[];
  elevations_deg: number[];
}

export interface ElevationRange {
  min: number;
  max: number;
}

export const FULL_ELEVATION: ElevationRange = { min: -90, max: 90 };

/** Current bodies plus every measured skyline sample, padded on a linear scale. */
export function autoElevationRange(skyline: Skyline, bodyElevations: number[]): ElevationRange {
  const values = [0, ...skyline.elevations_deg, ...bodyElevations].filter(Number.isFinite);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 6);
  const padding = span * 0.22;
  const step = elevationTickStep(span + padding * 2);
  return {
    min: Math.max(-90, Math.floor((low - padding) / step) * step),
    max: Math.min(90, Math.ceil((high + padding) / step) * step),
  };
}

export function elevationTickStep(span: number): number {
  const rough = span / 6;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

export function elevationTicks(range: ElevationRange): number[] {
  const step = elevationTickStep(range.max - range.min);
  const ticks: number[] = [];
  for (let value = Math.ceil(range.min / step) * step; value <= range.max + step * 1e-8; value += step) {
    ticks.push(Number(value.toFixed(8)));
  }
  return ticks;
}

/** Plot endpoints deliberately differ: 0 is left, 360 is right. */
export function azimuthToX(azimuthDeg: number, width: number): number {
  return (azimuthDeg / 360) * width;
}

/** Linear angular scale, never vertical exaggeration or logarithmic mapping. */
export function elevationToY(elevationDeg: number, height: number, range = FULL_ELEVATION): number {
  return ((range.max - elevationDeg) / (range.max - range.min)) * height;
}

export function wrapAzimuth(azimuthDeg: number): number {
  return ((azimuthDeg % 360) + 360) % 360;
}

/** Same periodic, piecewise-linear skyline interpolation as backend horizon_at. */
export function horizonAt(skyline: Skyline, azimuthDeg: number): number {
  const azimuths = skyline.azimuths_deg;
  const elevations = skyline.elevations_deg;
  const count = azimuths.length - (azimuths[azimuths.length - 1] === 360 ? 1 : 0);
  if (count < 1 || elevations.length !== azimuths.length) {
    throw new Error('Ufuk profili boş veya uyumsuz.');
  }
  const angle = wrapAzimuth(azimuthDeg);
  for (let index = 0; index < count - 1; index += 1) {
    if (angle >= azimuths[index] && angle < azimuths[index + 1]) {
      const fraction = (angle - azimuths[index]) / (azimuths[index + 1] - azimuths[index]);
      return elevations[index] + fraction * (elevations[index + 1] - elevations[index]);
    }
  }
  const left = azimuths[count - 1];
  const right = azimuths[0] + 360;
  const unwrapped = angle < azimuths[0] ? angle + 360 : angle;
  const fraction = (unwrapped - left) / (right - left);
  return elevations[count - 1] + fraction * (elevations[0] - elevations[count - 1]);
}

/** Include both periodic edges, even when upstream omits its repeated 360 sample. */
export function skylinePath(skyline: Skyline, width: number, height: number, range = FULL_ELEVATION): string {
  const samples = [
    { azimuth: 0, elevation: horizonAt(skyline, 0) },
    ...skyline.azimuths_deg.flatMap((azimuth, index) =>
      azimuth > 0 && azimuth < 360 ? [{ azimuth, elevation: skyline.elevations_deg[index] }] : []),
    { azimuth: 360, elevation: horizonAt(skyline, 360) },
  ];
  return samples.map(({ azimuth, elevation }, index) =>
    `${index === 0 ? 'M' : 'L'}${azimuthToX(azimuth, width)},${elevationToY(elevation, height, range)}`
  ).join(' ');
}

export function terrainPath(skyline: Skyline, width: number, height: number, range = FULL_ELEVATION): string {
  return `${skylinePath(skyline, width, height, range)} L${width},${height} L0,${height} Z`;
}

/** Repeat only markers touching periodic seam; clip copies to plot rectangle. */
export function markerXs(azimuthDeg: number, width: number, radius: number): number[] {
  const x = azimuthToX(wrapAzimuth(azimuthDeg), width);
  const result = [x];
  if (x < radius) result.push(x + width);
  if (width - x < radius) result.push(x - width);
  return result;
}
