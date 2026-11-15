# Measured DEM calculation coverage

## Why a ready/catalog site could report “Official PDS DEM unavailable”

Previously `/api/skyview/custom`, custom scenarios in `/compare` (and
`/compare-planning`), and `/schedule-shock` opened a separate raw
`backend/data/ldem_85s_40m.img` through a generated rasterio VRT **only to gate
coordinates**. The actual horizon and local slope calculations already used
`frontend/public/terrain-data/pole_dem.bin`. Catalog `/series` did not apply
that raw-file gate, creating inconsistent behavior at identical coordinates.
`/status` checks SPICE dependencies, not terrain support for every coordinate.

Coverage validation now reads the same measured grid and bilinear center
footprint as the calculation. The raw 40 m image and `LUNAR_PDS_DEM_PATH` are
not required by these routes. No raw download, new dependency, nearest catalog
substitution, fabricated terrain, or global geometric fallback is involved.

## What is actually measured

The checked packaged asset is 4,602,602 bytes, 1517 × 1517 signed little-endian
int16 samples, 200 m projected spacing, 0.5 m height scale, with zero-based
line/sample origin 758.2999877929688 (float32 header). Its SHA-256 is
`940998902349d937387aa7cd151dbdc704b5a820f7261a76daf490a886c9cfcd`.
It is the existing every-fifth-sample decimation of LRO LOLA
`ldem_85s_40m`, not a newly available 40 m calculation. Coordinates use spherical
south-polar stereographic projection, radius 1,737,400 m, east-positive
planetocentric coordinates in `MOON_ME_DE421`.

The supported area is the **finite rectangle of sample centers**, calculated
from the binary header, not the full Moon or the original image's outer pixel
bounds. Arbitrary requested coordinates inside that rectangle are evaluated at
those coordinates; catalog coordinates need no different science engine.
Longitude is normalized to [-180, 180) by the calculation engine. At the exact
south pole the requested longitude defines the ENU azimuth convention.

`LUNAR_DEM_PATH` can explicitly select another compatible local grid. Its actual
hash/header/resolution are reported, and source identity is not asserted unless
its hash matches the packaged asset. Coverage metadata and horizon provenance
identify the actual file/hash/spacing. Bilinear interpolation adds no measured
resolution.

## Fail-closed behavior and remaining limitations

- Missing/unreadable/malformed calculation grids fail custom coverage preflight
  with HTTP 503, including invalid dimensions, truncated payloads, and nonfinite
  or nonpositive spacing/scale.
- Outside coordinates return HTTP 422 with
  `Girilen koordinat DEM kapsama alanı dışında.` Required bilinear corners with
  values <= -32767 also fail; no holes are filled.
- Center coverage is not a promise that every calculation neighborhood exists.
  Horizon checks every sampled footprint; rays exiting the finite grid truncate
  and explicitly report per-ray extent. A ray ending before its first sample
  fails. Terrain beyond the grid/radius is unknown, not certified visible.
- Local slope uses the same grid, with nine bilinear samples over a two-cell-wide
  projected neighborhood. An unsupported neighborhood remains unavailable;
  compare-planning returns null slope/reason, while search rejects that site.
- SPICE date/frame coverage is still mandatory. Visibility is sampled geometric
  Sun/Earth-center visibility, not energy, link budget, continuous guarantees,
  or landing certification.

## Applying the change

Restart the backend process importing `backend/app/skyview_router.py` (normally
uvicorn `app.main:app` from `backend`). A browser refresh alone cannot replace
Python modules already loaded in an existing server; uvicorn with `--reload`
should reload automatically, otherwise stop/start that backend. No raw image
installation or frontend rebuild is required to apply this backend fix.

## Regression verification (2026-11-15)

Using existing temporary dependencies with Python 3.14 and existing local DE421
kernels, 136 tests passed across `test_dem_coverage.py`, `test_horizon.py`,
`test_skyview_planning.py`, and `test_skyview_search.py`. This includes real SPICE
catalog-series/custom equality without a raw image, an arbitrary noncatalog
coordinate, the exact south pole, planning comparisons/schedule, outside points,
corrupt headers/payloads, nodata, and finite-boundary behavior.

The Windows CSPICE binary cannot open this machine's non-ASCII user path even
though Python inventory can. Direct real-kernel tests initially returned
SPICE(NOSUCHFILE). Verification therefore used an external test-only wrapper
converting inventory paths to Windows ASCII short paths immediately before
CSPICE loads them; no kernel download, fixture science substitution, or production
path-handling change was made. Simply configuring a short directory path is not
enough because inventory resolves it back to the long path. This separate runtime
issue may require an ASCII-only physical kernel directory on this machine.

`test_skyview.py` separately yielded 23 passed / 1 failed under that wrapper.
The remaining analytic compass test sees floating-point azimuth 360 instead of
0 at a due-north direction; it is unrelated to DEM gating and is not hidden or
weakened by this change. Existing dependency deprecation warnings remain.
