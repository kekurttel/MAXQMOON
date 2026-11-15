"""Finite-range, sampled lunar DEM skylines; never a whole-Moon guarantee.

Coordinates are east-positive planetocentric degrees in MOON_ME_DE421. Heights
are metres above the 1,737,400 m reference sphere, not terrestrial sea level.
Only the shipped measured grid (or an explicitly configured local grid) is read;
missing terrain is never replaced by a sphere, noise, or extrapolated heights.
"""

from dataclasses import dataclass
from functools import lru_cache
import hashlib
import math
import os
from pathlib import Path
import struct

import numpy as np


FRAME = "MOON_ME_DE421"
MOON_RADIUS_M = 1_737_400.0
PACKAGED_SHA256 = "940998902349d937387aa7cd151dbdc704b5a820f7261a76daf490a886c9cfcd"
PACKAGED_SHA256_75S = "7210a3774f7bb0aa26e8040e681b59c388487d9d0816d8708eb833f55ca4f617"
PACKAGED_SHA256_60S = "830f54727e68f2c2c95e739a1bea21b6476a6f979876d0126c8b10a6ff73eb9e"
DEFAULT_DEM_PATH = Path(__file__).resolve().parents[2] / "frontend/public/terrain-data/pole_dem.bin"
DEFAULT_DEM_75S_PATH = Path(__file__).resolve().parents[2] / "frontend/public/terrain-data/pole_dem_75s.bin"
DEFAULT_DEM_60S_PATH = Path(__file__).resolve().parents[2] / "frontend/public/terrain-data/pole_dem_60s.bin"
_HEADER = struct.Struct("<IIffff")
_MAX_DIMENSION = 100_000
_MAX_CELLS = 100_000_000
_MAX_RAY_SAMPLES = 1_000_000


class TerrainUnavailable(ValueError):
    """The requested measured terrain or supported coordinate frame is absent."""


def project_south_polar(lat_deg: float, lon_deg: float) -> tuple[float, float]:
    """Project planetocentric degrees onto the spherical south-polar grid."""
    if not math.isfinite(lat_deg) or not math.isfinite(lon_deg) or not -90 <= lat_deg < 90:
        raise TerrainUnavailable("South-polar projection requires finite latitude in [-90, 90) and longitude.")
    rho = 2 * MOON_RADIUS_M * math.tan(math.radians(90 + lat_deg) / 2)
    lon = math.radians(lon_deg % 360)
    return rho * math.sin(lon), rho * math.cos(lon)


def inverse_south_polar(x_m: float, y_m: float) -> tuple[float, float]:
    """Inverse projection, with east-positive longitude in [-180, 180]."""
    if not math.isfinite(x_m) or not math.isfinite(y_m):
        raise TerrainUnavailable("Inverse projection requires finite projected coordinates.")
    rho = math.hypot(x_m, y_m)
    return math.degrees(2 * math.atan2(rho, 2 * MOON_RADIUS_M)) - 90, math.degrees(math.atan2(x_m, y_m))


@dataclass(frozen=True)
class _DEM:
    values: np.ndarray
    spacing: float
    line0: float
    sample0: float
    scale: float
    path: str
    sha256: str

    def grid_coordinates(self, x, y):
        return self.line0 - np.asarray(y) / self.spacing, self.sample0 + np.asarray(x) / self.spacing

    def contains(self, x, y):
        row, col = self.grid_coordinates(x, y)
        rows, cols = self.values.shape
        return np.isfinite(row) & np.isfinite(col) & (row >= 0) & (row <= rows - 1) & (col >= 0) & (col <= cols - 1)

    def sample(self, x, y):
        """Bilinear interpolation; reject footprints touching any missing cell."""
        if not np.all(self.contains(x, y)):
            raise TerrainUnavailable("Requested coordinate is outside the measured DEM footprint; choose a site inside the grid.")
        row, col = self.grid_coordinates(x, y)
        rows, cols = self.values.shape
        r = np.minimum(np.floor(row).astype(int), rows - 2)
        c = np.minimum(np.floor(col).astype(int), cols - 2)
        corners = np.array([self.values[r, c], self.values[r, c + 1], self.values[r + 1, c], self.values[r + 1, c + 1]])
        if np.any(corners <= -32767):
            raise TerrainUnavailable("DEM nodata touches a required bilinear footprint; choose another site/radius or provide a complete measured DEM. Gaps are not interpolated through.")
        fr, fc = row - r, col - c
        a, b, c0, d = corners.astype(float)
        return ((1 - fr) * ((1 - fc) * a + fc * b) + fr * ((1 - fc) * c0 + fc * d)) * self.scale


@lru_cache(maxsize=4)
def _load_dem_cached(path: str, mtime_ns: int, size: int, ctime_ns: int) -> _DEM:
    # Stat keys invalidate replaced/modified files; no caller-supplied path enters
    # a shell command. LUNAR_DEM_PATH is local administrator configuration only.
    try:
        with open(path, "rb") as source:
            header = source.read(_HEADER.size)
            if len(header) != _HEADER.size:
                raise TerrainUnavailable("Invalid DEM: incomplete 24-byte <IIffff header.")
            rows, cols, spacing, line0, sample0, scale = _HEADER.unpack(header)
            if not (2 <= rows <= _MAX_DIMENSION and 2 <= cols <= _MAX_DIMENSION and rows * cols <= _MAX_CELLS):
                raise TerrainUnavailable("Invalid DEM dimensions: at least 2x2 and at most 50 million cells are supported.")
            if not all(math.isfinite(v) for v in (spacing, line0, sample0, scale)) or spacing <= 0 or scale <= 0:
                raise TerrainUnavailable("Invalid DEM header: spacing/scale must be positive and all projection fields finite.")
            expected_size = _HEADER.size + rows * cols * 2
            if size != expected_size:
                raise TerrainUnavailable(f"Invalid DEM payload length: expected {expected_size} bytes, found {size}.")
            payload = source.read(expected_size - _HEADER.size + 1)
            if len(payload) != expected_size - _HEADER.size:
                raise TerrainUnavailable("DEM changed while reading; retry with a stable terrain file.")
    except OSError as exc:
        raise TerrainUnavailable(f"Cannot read measured DEM at {path}: {exc}. Install pole_dem.bin or set LUNAR_DEM_PATH.") from exc
    values = np.frombuffer(payload, dtype="<i2").reshape(rows, cols)
    return _DEM(values, spacing, line0, sample0, scale, path, hashlib.sha256(header + payload).hexdigest())


def _load_dem() -> _DEM:
    path = Path(os.environ.get("LUNAR_DEM_PATH", str(DEFAULT_DEM_PATH))).expanduser()
    try:
        path = path.resolve(strict=True)
        if not path.is_file():
            raise TerrainUnavailable(f"Measured DEM is not a regular file: {path}.")
        stat = path.stat()
    except OSError as exc:
        raise TerrainUnavailable(f"Measured DEM unavailable at {path}; install pole_dem.bin or set LUNAR_DEM_PATH to a local grid.") from exc
    return _load_dem_cached(str(path), stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns)


def _finite(value: float, name: str) -> float:
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise TerrainUnavailable(f"{name} must be a finite number.") from exc
    if not math.isfinite(value):
        raise TerrainUnavailable(f"{name} must be a finite number.")
    return value


def compute_horizon(
    lat_deg: float,
    lon_deg: float,
    observer_height_m: float = 2.0,
    azimuth_step_deg: float = 1.0,
    max_distance_m: float = 100000.0,
    *,
    distance_step_m: float = 200.0,
    frame: str = FRAME,
) -> dict:
    """Trace great-circle rays and return their maximum topocentric altitudes.

    Azimuth is atan2(east, north), clockwise from north. Distances are spherical
    surface arc lengths, not projection-plane distances. Near samples at one
    quarter and half a step precede regular samples. The endpoint is included.
    Grid exit truncates that ray; nodata within its sampled extent fails closed.
    Angular/radial sampling can miss narrow relief between samples; terrain
    outside this finite grid/radius is unknown, including far-side occluders.
    """
    if frame != FRAME:
        raise TerrainUnavailable(f"Unsupported terrain frame {frame!r}; only {FRAME} east-positive planetocentric coordinates are supported.")
    lat_deg = _finite(lat_deg, "lat_deg")
    lon_deg = _finite(lon_deg, "lon_deg")
    observer_height_m = _finite(observer_height_m, "observer_height_m")
    azimuth_step_deg = _finite(azimuth_step_deg, "azimuth_step_deg")
    max_distance_m = _finite(max_distance_m, "max_distance_m")
    distance_step_m = _finite(distance_step_m, "distance_step_m")
    if not -90 <= lat_deg < 90:
        raise TerrainUnavailable("Latitude must be in [-90, 90) and inside the south-polar DEM.")
    if observer_height_m < 0:
        raise TerrainUnavailable("observer_height_m must be nonnegative.")
    if not 0 < azimuth_step_deg <= 360:
        raise TerrainUnavailable("azimuth_step_deg must be positive and divide 360 evenly.")
    count_float = 360 / azimuth_step_deg
    if count_float > _MAX_RAY_SAMPLES or not math.isclose(count_float, round(count_float), rel_tol=0, abs_tol=1e-8):
        raise TerrainUnavailable("azimuth_step_deg must divide 360 evenly and respect the one-million-sample budget.")
    ray_count = round(count_float)
    if not 0 < max_distance_m < math.pi * MOON_RADIUS_M or distance_step_m <= 0:
        raise TerrainUnavailable("Distance must be positive and less than half a lunar circumference; distance_step_m must be positive.")
    dem = _load_dem()
    step = min(distance_step_m, dem.spacing)
    # Bound allocations/work before constructing either sampling array.
    radial_steps = max_distance_m / step
    if not math.isfinite(radial_steps) or radial_steps > _MAX_RAY_SAMPLES or ray_count * (math.ceil(radial_steps) + 3) > _MAX_RAY_SAMPLES:
        raise TerrainUnavailable("Horizon exceeds the one-million-sample budget; increase azimuth/distance step or reduce radius.")
    distances = np.unique(np.concatenate((np.array([step / 4, step / 2]), np.arange(step, max_distance_m, step), np.array([max_distance_m]))))
    distances = distances[distances <= max_distance_m]
    azimuths = np.arange(ray_count, dtype=float) * azimuth_step_deg
    x, y = project_south_polar(lat_deg, lon_deg)
    surface = float(dem.sample(x, y))
    if MOON_RADIUS_M + surface <= 0:
        raise TerrainUnavailable("DEM surface radius must be positive.")
    lat, lon = math.radians(lat_deg), math.radians(lon_deg % 360)
    up = np.array([math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)])
    east = np.array([-math.sin(lon), math.cos(lon), 0.0])
    north = np.array([-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)])
    observer = (MOON_RADIUS_M + surface + observer_height_m) * up
    delta = distances / MOON_RADIUS_M
    cos_delta, sin_delta = np.cos(delta), np.sin(delta)
    elevations, rays = [], []
    for azimuth in azimuths:
        az = math.radians(float(azimuth))
        direction = math.cos(az) * north + math.sin(az) * east
        units = cos_delta[:, None] * up + sin_delta[:, None] * direction
        # rho = 2R*cos(latitude)/(1-sin(latitude)); multiply by sin/cos
        # longitude directly to avoid unstable longitude at the south pole.
        denominator = 1 - units[:, 2]
        px = np.divide(2 * MOON_RADIUS_M * units[:, 1], denominator, out=np.full_like(denominator, np.inf), where=denominator > 0)
        py = np.divide(2 * MOON_RADIUS_M * units[:, 0], denominator, out=np.full_like(denominator, np.inf), where=denominator > 0)
        inside = dem.contains(px, py)
        outside_indices = np.flatnonzero(~inside)
        length = int(outside_indices[0]) if outside_indices.size else len(distances)
        if length == 0:
            raise TerrainUnavailable(f"DEM ends before the first horizon sample at azimuth {azimuth:g} degrees; choose a site farther from its boundary or a shorter radius.")
        heights = dem.sample(px[:length], py[:length])
        if np.any(MOON_RADIUS_M + heights <= 0):
            raise TerrainUnavailable("DEM surface radius must be positive along every ray.")
        relative = (MOON_RADIUS_M + heights[:, None]) * units[:length] - observer
        vertical = relative @ up
        horizontal = np.hypot(relative @ east, relative @ north)
        elevations.append(float(np.max(np.degrees(np.arctan2(vertical, horizontal)))))
        rays.append({"azimuth_deg": float(azimuth), "max_distance_m": float(distances[length - 1]), "sample_count": length, "truncated": length < len(distances)})
    azimuths_closed = [*azimuths.tolist(), 360.0]
    elevations.append(elevations[0])
    truncated = any(ray["truncated"] for ray in rays)
    rows, cols = dem.values.shape
    return {
        "frame": FRAME,
        "geodetic": "planetocentric",
        "azimuths_deg": azimuths_closed,
        "elevations_deg": elevations,
        "surface_elevation_m": surface,
        "observer_height_m": observer_height_m,
        "coverage": {
            "kind": "finite-range DEM-derived sampled skyline",
            "requested_max_distance_m": max_distance_m,
            "distance_step_m": step,
            "near_sample_distances_m": distances[:min(2, len(distances))].tolist(),
            "azimuth_step_deg": azimuth_step_deg,
            "truncated": truncated,
            "complete_within_requested_radius": not truncated,
            "rays": [*rays, {**rays[0], "azimuth_deg": 360.0}],
            "per_ray_max_distance_m": [*[r["max_distance_m"] for r in rays], rays[0]["max_distance_m"]],
            "whole_moon_horizon_certified": False,
            "beyond_sampled_extent": "Unknown: terrain beyond the DEM/window or requested radius, including far-side terrain, is not evaluated.",
            "limitations": [
                "Discrete radial and azimuth samples may miss sub-grid relief or narrow peaks; bilinear interpolation does not add measurements.",
                "No DEM bounds extrapolation or gap filling; any required nodata footprint raises TerrainUnavailable.",
                "No atmospheric refraction, solar-disk, ephemeris, or terrain uncertainty model is included.",
            ],
        },
        "provenance": {
            "file": dem.path,
            "sha256": dem.sha256,
            "packaged_sha256": PACKAGED_SHA256,
            "matches_packaged_asset": dem.sha256 in (PACKAGED_SHA256, PACKAGED_SHA256_75S),
            "hash_meaning": "Byte identity only, not scientific validation or certification of the source frame.",
            "frame": FRAME,
            "geodetic": "planetocentric",
            "longitude_convention": "east-positive",
            "reference_radius_m": MOON_RADIUS_M,
            "height_datum": "elevation above the lunar reference sphere in metres",
            "projection": "spherical south-polar stereographic",
            "source_product": (
                "LRO LOLA ldem_85s_40m; packaged grid decimated every fifth sample" if dem.sha256 == PACKAGED_SHA256
                else "LRO LOLA ldem_75s_240m; NASA PDS official 75°S-90°S 240m grid" if dem.sha256 == PACKAGED_SHA256_75S
                else "Configured local grid; source identity not established by this module"
            ),
            "source_label_url": (
                "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_85s_40m.lbl" if dem.sha256 == PACKAGED_SHA256
                else "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_75s_240m.lbl" if dem.sha256 == PACKAGED_SHA256_75S
                else None
            ),
            "source_coordinate_system_name": "MEAN EARTH/POLAR AXIS OF DE421" if dem.sha256 in (PACKAGED_SHA256, PACKAGED_SHA256_75S) else None,
            "nodata_policy": "Values <= -32767 are conservatively rejected; this guard is not a sentinel declaration from the source PDS label.",
            "rows": rows, "cols": cols, "spacing_m": dem.spacing,
            "line0": dem.line0, "sample0": dem.sample0, "scale_m": dem.scale,
            "bounds_projected_m": {
                "x_min": -dem.sample0 * dem.spacing,
                "x_max": (cols - 1 - dem.sample0) * dem.spacing,
                "y_min": (dem.line0 - rows + 1) * dem.spacing,
                "y_max": dem.line0 * dem.spacing,
            },
        },
    }


def horizon_at(horizon: dict, azimuth_deg: float) -> float:
    """Cyclic linear interpolation of a sampled skyline, including 360/0 wrap."""
    angle = _finite(azimuth_deg, "azimuth_deg") % 360
    try:
        azimuths = np.asarray(horizon["azimuths_deg"], dtype=float)
        elevations = np.asarray(horizon["elevations_deg"], dtype=float)
    except (KeyError, ValueError, TypeError) as exc:
        raise TerrainUnavailable("Horizon must contain numeric azimuths_deg and elevations_deg arrays.") from exc
    if (azimuths.ndim != 1 or elevations.ndim != 1 or len(azimuths) != len(elevations) or len(azimuths) < 2
            or not np.all(np.isfinite(azimuths)) or not np.all(np.isfinite(elevations))
            or azimuths[0] < 0 or azimuths[-1] > 360 or np.any(np.diff(azimuths) <= 0)):
        raise TerrainUnavailable("Horizon arrays must be finite, equally sized, and strictly increasing in azimuth within [0, 360].")
    if azimuths[0] == 0 and azimuths[-1] == 360:
        if not math.isclose(elevations[0], elevations[-1], abs_tol=1e-10):
            raise TerrainUnavailable("Horizon 360-degree endpoint must repeat its 0-degree elevation.")
        azimuths, elevations = azimuths[:-1], elevations[:-1]
    return float(np.interp(angle, np.concatenate(([azimuths[-1] - 360], azimuths, [azimuths[0] + 360])), np.concatenate(([elevations[-1]], elevations, [elevations[0]]))))
