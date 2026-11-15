"""Finite selected-coordinate/date-grid search; no global optimization."""
from datetime import timedelta

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, model_validator

from .skyview import iso_utc, parse_utc, sample_times
from .skyview_planning import MAX_BATCH_SAMPLES


class CatalogSearchLocation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    site_id: StrictStr = Field(min_length=1, max_length=120)


class CoordinateSearchLocation(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(strict=True, ge=-90, le=90)
    lon: float = Field(strict=True, ge=-180, le=180)
    name: StrictStr = Field(default="Custom coordinate", min_length=1, max_length=120)


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    site_ids: list[StrictStr] | None = Field(default=None, min_length=1, max_length=8)
    locations: list[CatalogSearchLocation | CoordinateSearchLocation] | None = Field(default=None, min_length=1, max_length=8)
    start_utc: str
    end_utc: str
    duration_hours: float = Field(default=24, ge=1, le=168)
    cadence_hours: StrictInt = Field(default=24, ge=1, le=168)
    step_seconds: StrictInt = Field(default=3600, ge=600, le=21600)
    min_sunlight_hours: float = Field(default=0, ge=0, le=168)
    min_sunlight_fraction: float = Field(default=0, ge=0, le=1)
    min_earth_hours: float = Field(default=0, ge=0, le=168)
    min_earth_fraction: float = Field(default=0, ge=0, le=1)
    max_slope_deg: float | None = Field(default=None, ge=0, le=90)
    max_results: StrictInt = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def validate_sites(self):
        supplied = self.model_fields_set & {"site_ids", "locations"}
        if len(supplied) != 1 or (self.site_ids is None and self.locations is None):
            raise ValueError("Provide exactly one of site_ids or locations")
        if self.site_ids is not None:
            if any(not s or len(s) > 120 for s in self.site_ids) or len(set(self.site_ids)) != len(self.site_ids):
                raise ValueError("site_ids must contain unique nonempty catalog identifiers")
        else:
            identities = set()
            for index, location in enumerate(self.locations):
                identity = (("catalog", location.site_id) if isinstance(location, CatalogSearchLocation)
                            else coordinate_identity(location.lat, location.lon))
                if identity in identities:
                    raise ValueError(f"locations[{index}]: duplicate location")
                identities.add(identity)
        return self

    @property
    def location_count(self) -> int:
        return len(self.site_ids if self.site_ids is not None else self.locations)


def coordinate_identity(lat: float, lon: float) -> tuple:
    """Exact identity only: wrap longitude, but never round/snap coordinates."""
    return ("coordinate", lat, 0.0 if abs(lat) == 90 else (-180.0 if lon == 180 else lon))


def search_windows(request: SearchRequest) -> list[tuple[str, str]]:
    start, end = parse_utc(request.start_utc), parse_utc(request.end_utc)
    if not timedelta(0) < end - start <= timedelta(days=90):
        raise ValueError("Search UTC window must be positive and at most 90 days")
    duration = timedelta(hours=request.duration_hours)
    if duration > end - start:
        raise ValueError("Observation duration must fit inside search UTC window")
    windows, total = [], 0
    while start + duration <= end:
        first, last = iso_utc(start), iso_utc(start + duration)
        total += len(sample_times(first, last, request.step_seconds)) * request.location_count
        if len(windows) >= 64 or total > MAX_BATCH_SAMPLES:
            raise ValueError("Search exceeds 64 date windows or 8192 site-time samples; reduce sites/window or increase cadence/step")
        windows.append((first, last))
        start += timedelta(hours=request.cadence_hours)
    return windows


def meets_criteria(summary: dict, slope: dict, request: SearchRequest) -> bool:
    return (summary["total_sunlight_hours"] >= request.min_sunlight_hours
            and summary["sunlight_percentage"] / 100 >= request.min_sunlight_fraction
            and summary["total_earth_visible_hours"] >= request.min_earth_hours
            and summary["earth_visible_percentage"] / 100 >= request.min_earth_fraction
            and (request.max_slope_deg is None or slope["slope_deg"] <= request.max_slope_deg))
