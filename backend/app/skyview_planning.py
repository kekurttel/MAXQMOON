"""Validated planning requests and sampled visibility summaries, never substitutes."""
from datetime import datetime, timedelta, timezone
import re

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from .skyview import iso_utc, parse_utc, sample_times

MAX_BATCH_SAMPLES = 8192
VERDICT_RULE = {
    "basis": "minimum of sunlight_percentage and earth_visible_percentage",
    "green_min_percent": 80,
    "yellow_min_percent": 50,
    "scientific_certainty": False,
    "description": "Mission planning heuristic, not a scientific safety guarantee",
}


class CompareScenario(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    site_id: str | None = Field(default=None, min_length=1, max_length=120)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    start_utc: str
    end_utc: str
    step_seconds: StrictInt = Field(default=600, ge=60, le=86400)

    @model_validator(mode="after")
    def coordinate_choice(self):
        if "site_id" in self.model_fields_set:
            if self.site_id is None or {"lat", "lon"} & self.model_fields_set:
                raise ValueError("Provide exactly site_id OR complete lat/lon, not both")
        elif self.lat is None or self.lon is None:
            raise ValueError("Provide exactly site_id OR complete lat/lon")
        return self


class CompareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenarioA: CompareScenario
    scenarioB: CompareScenario


class ScheduleShockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    base_date: str
    duration_days: float = Field(default=7, gt=0, le=365)
    delay_days: list[StrictInt] = Field(default_factory=lambda: [0, 7, 14, 21, 30], min_length=1, max_length=16)
    step_seconds: StrictInt = Field(default=600, ge=60, le=86400)

    @model_validator(mode="after")
    def unique_delays(self):
        if any(not 0 <= delay <= 3650 for delay in self.delay_days):
            raise ValueError("delay_days must contain integers between 0 and 3650")
        if len(set(self.delay_days)) != len(self.delay_days):
            raise ValueError("delay_days must be unique")
        return self


def schedule_windows(request: ScheduleShockRequest) -> list[tuple[int, str, str]]:
    """Preflight every window and total work before any DEM/SPICE calculation."""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", request.base_date):
        base = datetime.strptime(request.base_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        base = parse_utc(request.base_date)
    windows = []
    total_samples = 0
    try:
        duration = timedelta(days=request.duration_days)
        for delay in request.delay_days:
            start = base + timedelta(days=delay)
            end = start + duration
            first, last = iso_utc(start), iso_utc(end)
            total_samples += len(sample_times(first, last, request.step_seconds))
            if total_samples > MAX_BATCH_SAMPLES:
                raise ValueError(f"Batch exceeds {MAX_BATCH_SAMPLES} samples; reduce delays/range or increase step")
            windows.append((delay, first, last))
    except OverflowError as exc:
        raise ValueError("Schedule dates exceed supported datetime range") from exc
    return windows


def visibility_summary(result: dict, delay_days: int) -> dict:
    """Integrate Boolean endpoint samples using actual adjacent UTC deltas."""
    points = result["points"]
    times = [parse_utc(point["time_utc"]) for point in points]
    microsecond = timedelta(microseconds=1)
    duration_us = (times[-1] - times[0]) // microsecond
    totals = {}
    bounds = {}
    weighted_totals = []
    for body, name in (("sun", "sunlight"), ("earth", "earth_visible")):
        # Twice the integrated microseconds keeps midpoint halves exact.
        weighted_us = lower_us = upper_us = 0
        for left, right, first, last in zip(points, points[1:], times, times[1:]):
            delta_us = (last - first) // microsecond
            a, b = int(left[body]["center_visible"]), int(right[body]["center_visible"])
            weighted_us += delta_us * (a + b)
            lower_us += delta_us * min(a, b)
            upper_us += delta_us * max(a, b)
        totals[f"total_{name}_hours"] = weighted_us / 7_200_000_000
        totals[f"{name}_percentage"] = weighted_us * 100 / (2 * duration_us)
        bounds[name] = {"lower_hours": lower_us / 3_600_000_000, "upper_hours": upper_us / 3_600_000_000}
        weighted_totals.append(weighted_us)
    minimum_scaled = min(weighted_totals) * 100
    return {"delay_days": delay_days, "start_utc": result["start_utc"], "end_utc": result["end_utc"],
            **totals, "verdict": "green" if minimum_scaled >= 80 * 2 * duration_us else "yellow" if minimum_scaled >= 50 * 2 * duration_us else "red",
            "visibility_hour_bounds": bounds, "provenance": result["provenance"]}


def schedule_metadata(request: ScheduleShockRequest, coverage: dict) -> dict:
    return {"duration_days": request.duration_days, "step_seconds": request.step_seconds,
            "verdict_rule": dict(VERDICT_RULE), "coordinate_coverage": coverage,
            "integration": {
                "method": "trapezoid of Boolean endpoint visibility using actual adjacent UTC delta hours",
                "transition_model": "sampled midpoint model; changed endpoint states place the crossing at the midpoint",
                "unseen_crossings_detected": False,
                "exact": False,
                "bounds": "Endpoint min/max envelopes only, not guaranteed physical bounds; unseen crossings may occur even when endpoints agree.",
                "limits": "Sampled geometric target-center visibility above the DEM skyline, not exact illumination or a scientific safety guarantee.",
            }}
