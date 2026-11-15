import {
  azimuthToX, elevationToY, horizonAt, markerXs, skylinePath, terrainPath, wrapAzimuth,
} from './skyGeometry';

const skyline = {
  azimuths_deg: [0, 90, 180, 270, 360],
  elevations_deg: [2, 6, -2, -6, 2],
};

describe('real angular sky projection', () => {
  test('azimuth endpoints occupy opposite plot edges; cardinal directions stay linear', () => {
    expect(azimuthToX(0, 1000)).toBe(0);
    expect(azimuthToX(90, 1000)).toBe(250);
    expect(azimuthToX(180, 1000)).toBe(500);
    expect(azimuthToX(270, 1000)).toBe(750);
    expect(azimuthToX(360, 1000)).toBe(1000);
  });

  test('full elevation range is exactly -90 to +90, without exaggeration', () => {
    expect(elevationToY(90, 360)).toBe(0);
    expect(elevationToY(0, 360)).toBe(180);
    expect(elevationToY(-90, 360)).toBe(360);
    expect(elevationToY(1, 360)).toBe(178);
    expect(elevationToY(-1, 360)).toBe(182);
    expect(elevationToY(45, 360)).toBe(90);
  });

  test('near-horizon inset has its own explicit linear range; out-of-range values are not clamped', () => {
    const range = { min: -10, max: 10 };
    expect(elevationToY(10, 200, range)).toBe(0);
    expect(elevationToY(0, 200, range)).toBe(100);
    expect(elevationToY(-10, 200, range)).toBe(200);
    expect(elevationToY(20, 200, range)).toBe(-100);
  });

  test('periodic azimuth accepts negative values and multiple turns', () => {
    expect(wrapAzimuth(-1)).toBe(359);
    expect(wrapAzimuth(360)).toBe(0);
    expect(wrapAzimuth(721)).toBe(1);
  });

  test('interpolates measured skyline linearly and closes 360/0 seam', () => {
    expect(horizonAt(skyline, 45)).toBe(4);
    expect(horizonAt(skyline, 315)).toBe(-2);
    expect(horizonAt(skyline, 0)).toBe(2);
    expect(horizonAt(skyline, 360)).toBe(2);
    expect(horizonAt(skyline, -45)).toBe(-2);
    expect(horizonAt(skyline, 359.999)).toBeCloseTo(horizonAt(skyline, -0.001), 10);
  });

  test('periodic interpolation also works without repeated endpoints or zero sample', () => {
    const open = { azimuths_deg: [45, 135, 225, 315], elevations_deg: [4, 8, -8, -4] };
    expect(horizonAt(open, 0)).toBe(0);
    expect(horizonAt(open, 360)).toBe(0);
    expect(horizonAt(open, 337.5)).toBe(-2);
    expect(horizonAt(open, 22.5)).toBe(2);
    expect(skylinePath(open, 360, 180)).toMatch(/^M0,90 .*L360,90$/);
  });

  test('terrain uses actual DEM skyline, closes below it, and repeats periodic edge', () => {
    expect(skylinePath(skyline, 360, 180)).toBe('M0,88 L90,84 L180,92 L270,96 L360,88');
    expect(terrainPath(skyline, 360, 180)).toBe('M0,88 L90,84 L180,92 L270,96 L360,88 L360,180 L0,180 Z');
  });

  test('seam markers repeat at opposite edge instead of disappearing or crossing whole plot', () => {
    expect(markerXs(0, 360, 10)).toEqual([0, 360]);
    expect(markerXs(360, 360, 10)).toEqual([0, 360]);
    expect(markerXs(359, 360, 10)).toEqual([359, -1]);
    expect(markerXs(1, 360, 10)).toEqual([1, 361]);
    expect(markerXs(180, 360, 10)).toEqual([180]);
  });

  test('empty or mismatched skyline cannot silently become fabricated terrain', () => {
    expect(() => horizonAt({ azimuths_deg: [], elevations_deg: [] }, 0)).toThrow();
    expect(() => horizonAt({ azimuths_deg: [0, 90], elevations_deg: [1] }, 0)).toThrow();
  });
});
