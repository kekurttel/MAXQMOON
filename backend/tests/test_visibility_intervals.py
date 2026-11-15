"""Sample-derived intervals preserve brackets, real durations, and body data."""
from copy import deepcopy
from datetime import timedelta
import os

import pytest

from app.skyview import (compute_skyview, iso_utc, parse_utc, sample_times,
                         visibility_intervals)
from app.skyview_planning import visibility_summary

START = "2027-01-01T00:00:00Z"
END = "2027-01-01T00:30:00Z"


def points_for(states, times=None):
    if times is None:
        times = sample_times(START, END, 600)
    return [{"time_utc": iso_utc(t), "sun": {"center_visible": state, "clearance_deg": 7},
             "earth": {"center_visible": not state, "clearance_deg": -7}}
            for t, state in zip(times, states)]


def assert_duration_matches(summary):
    for body in ("sun", "earth"):
        durations = [(parse_utc(item["end_utc"]) - parse_utc(item["start_utc"])).total_seconds()
                     for item in summary[body]["intervals"]]
        assert sum(durations) / 3600 == pytest.approx(summary[body]["total_visible_hours"])


@pytest.mark.parametrize("visible", [False, True])
def test_constant_visibility_is_empty_or_full_clipped_window(visible):
    points = points_for([visible] * 4)
    original = deepcopy(points)
    summary = visibility_intervals(points, 600)
    assert points == original
    assert summary["method"] == "sampled-center-visibility-midpoint"
    assert summary["resolution_seconds"] == 600
    for body, state in (("sun", visible), ("earth", not visible)):
        assert summary[body]["total_visible_hours"] == (0.5 if state else 0)
        assert summary[body]["intervals"] == ([{
            "start_utc": "2027-01-01T00:00:00.000Z", "end_utc": "2027-01-01T00:30:00.000Z",
            "start_bracket": None, "end_bracket": None, "clipped_start": True, "clipped_end": True,
        }] if state else [])
    assert_duration_matches(summary)


@pytest.mark.parametrize("states,edges,clipped", [
    ([False, True, True, False], [(5, 25)], [(False, False)]),
    ([True, False, True, False], [(0, 5), (15, 25)], [(True, False), (False, False)]),
    ([False, True, False, True], [(5, 15), (25, 30)], [(False, False), (False, True)]),
])
def test_toggle_runs_use_midpoint_edges_and_explicit_brackets(states, edges, clipped):
    points = points_for(states)
    original = deepcopy(points)
    summary = visibility_intervals(points, 600)
    assert points == original
    origin = parse_utc(START)
    for item, (start, end), (clipped_start, clipped_end) in zip(summary["sun"]["intervals"], edges, clipped):
        assert parse_utc(item["start_utc"]) == origin + timedelta(minutes=start)
        assert parse_utc(item["end_utc"]) == origin + timedelta(minutes=end)
        assert (item["clipped_start"], item["clipped_end"]) == (clipped_start, clipped_end)
        for side, is_clipped in (("start", clipped_start), ("end", clipped_end)):
            bracket = item[f"{side}_bracket"]
            if is_clipped:
                assert bracket is None
            else:
                before, after = parse_utc(bracket["after_utc"]), parse_utc(bracket["by_utc"])
                assert after - before == timedelta(seconds=600)
                assert before + (after - before) / 2 == parse_utc(item[f"{side}_utc"])
    assert len(summary["sun"]["intervals"]) == len(edges)
    assert_duration_matches(summary)


@pytest.mark.parametrize("states,minutes", [([True, True, False], 10.5), ([False, False, True], 0.5)])
def test_short_final_step_uses_actual_duration(states, minutes):
    times = sample_times(START, "2027-01-01T00:11:00Z", 600)
    summary = visibility_intervals(points_for(states, times), 600)
    assert summary["sun"]["total_visible_hours"] == pytest.approx(minutes / 60)
    interval = summary["sun"]["intervals"][0]
    side = "end" if states[0] else "start"
    assert interval[f"{side}_utc"] == "2027-01-01T00:10:30.000Z"
    assert interval[f"{side}_bracket"] == {
        "after_utc": "2027-01-01T00:10:00.000Z", "by_utc": "2027-01-01T00:11:00.000Z",
    }
    assert_duration_matches(summary)


def test_fractional_sample_gap_keeps_half_millisecond_midpoint():
    times = sample_times("2027-01-01T00:00:00.123Z", "2027-01-01T00:10:00.124Z", 600)
    summary = visibility_intervals(points_for([False, False, True], times), 600)
    interval = summary["sun"]["intervals"][0]
    assert interval["start_utc"] == "2027-01-01T00:10:00.123500Z"
    assert interval["end_utc"] == "2027-01-01T00:10:00.124Z"
    assert summary["sun"]["total_visible_hours"] == pytest.approx(0.0005 / 3600)
    assert_duration_matches(summary)


@pytest.mark.parametrize("value,expected", [
    ("2027-01-01T00:00:00Z", "2027-01-01T00:00:00.000Z"),
    ("2027-01-01T00:00:00.123Z", "2027-01-01T00:00:00.123Z"),
    ("2027-01-01T00:00:00.123456Z", "2027-01-01T00:00:00.123456Z"),
])
def test_iso_utc_preserves_microseconds_and_established_millisecond_format(value, expected):
    instant = parse_utc(value)
    assert iso_utc(instant) == expected
    assert parse_utc(iso_utc(instant)) == instant


@pytest.mark.parametrize("end_fraction", ["123788", "123789", "123791"])
@pytest.mark.parametrize("rising", [False, True])
def test_microsecond_final_step_preserves_order_brackets_and_trapezoid(end_fraction, rising):
    times = sample_times("2027-01-01T00:00:00.123456Z",
                         f"2027-01-01T00:10:00.{end_fraction}Z", 600)
    points = points_for([not rising, not rising, rising], times)
    assert [parse_utc(point["time_utc"]) for point in points] == times
    summary = visibility_intervals(points, 600)
    midpoint = times[-2] + (times[-1] - times[-2]) / 2
    for body, becomes_visible in (("sun", rising), ("earth", not rising)):
        interval = summary[body]["intervals"][0]
        side = "start" if becomes_visible else "end"
        assert parse_utc(interval[f"{side}_utc"]) == midpoint
        assert interval[f"{side}_bracket"] == {
            "after_utc": iso_utc(times[-2]), "by_utc": iso_utc(times[-1]),
        }
        expected_seconds = (0 if becomes_visible else 600) + (times[-1] - times[-2]).total_seconds() / 2
        assert summary[body]["total_visible_hours"] == pytest.approx(expected_seconds / 3600, rel=0, abs=1e-15)
        reported_seconds = (parse_utc(interval["end_utc"]) - parse_utc(interval["start_utc"])).total_seconds()
        # Odd-microsecond gaps have half-microsecond mathematical midpoints;
        # datetime rounds those edges, but integration retains the exact half-gap.
        assert reported_seconds == pytest.approx(expected_seconds, rel=0, abs=0.500001e-6)


@pytest.mark.parametrize("offsets", [[], [0], [0, 0], [1, 0], [0, 2, 1]])
def test_invalid_or_nonmonotonic_times_are_rejected_without_mutation(offsets):
    origin = parse_utc(START)
    points = points_for([True] * len(offsets), [origin + timedelta(seconds=s) for s in offsets])
    original = deepcopy(points)
    with pytest.raises(ValueError, match="strictly increasing"):
        visibility_intervals(points, 600)
    assert points == original


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_real_response_preserves_microsecond_request_endpoints():
    start, end = "2027-01-01T00:00:00.123456Z", "2027-01-01T00:10:00.123789Z"
    series = compute_skyview(-88.679, -68.1, start, end, 600)
    assert series["start_utc"] == start
    assert series["end_utc"] == end
    assert [point["time_utc"] for point in series["points"]] == [
        start, "2027-01-01T00:10:00.123456Z", end,
    ]
    assert series["visibility_intervals"] == visibility_intervals(series["points"], 600)


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
def test_full_real_response_has_intervals_consistent_with_actual_points():
    series = compute_skyview(-88.679, -68.1, START, "2027-02-01T00:00:00Z", 3600)
    summary = series["visibility_intervals"]
    assert summary == visibility_intervals(series["points"], series["step_seconds"])
    assert_duration_matches(summary)
    assert series["provenance"]["visibility_intervals"]["extrapolation"] is False
    assert "not solar energy" in series["provenance"]["visibility_intervals"]["total_visible_hours"]
    times = [parse_utc(point["time_utc"]) for point in series["points"]]
    for body in ("sun", "earth"):
        states = [point[body]["center_visible"] for point in series["points"]]
        assert any(states) and not all(states)
        expected = sum((after - before).total_seconds() * (int(a) + int(b)) / 2
                       for before, after, a, b in zip(times, times[1:], states, states[1:])) / 3600
        assert summary[body]["total_visible_hours"] == pytest.approx(expected)
        for item in summary[body]["intervals"]:
            assert times[0] <= parse_utc(item["start_utc"]) < parse_utc(item["end_utc"]) <= times[-1]
            for side in ("start", "end"):
                bracket = item[f"{side}_bracket"]
                if bracket is not None:
                    index = next(i for i, point in enumerate(series["points"])
                                 if point["time_utc"] == bracket["after_utc"])
                    assert series["points"][index + 1]["time_utc"] == bracket["by_utc"]
                    assert states[index] != states[index + 1]


@pytest.mark.skipif(not os.getenv("LUNAR_KERNEL_DIR"), reason="Real NAIF kernels require LUNAR_KERNEL_DIR")
@pytest.mark.parametrize("lat,lon,start,end,step,expected_hours", [
    (-89.4395, -137.1934, "2027-01-01T00:00:00Z", "2027-01-08T00:00:00Z", 600, (168, 0)),
    (-89.4395, -137.1934, "2027-07-01T00:00:00Z", "2027-07-08T00:07:00.123456Z", 600,
     (128 + 25 / 60, 139 + 55 / 60)),
    (-88.679, -68.1, "2027-01-01T00:00:00Z", "2027-02-01T00:07:00.123456Z", 3600, (708.5, 351)),
    (-89, -137, "2027-01-01T00:00:00Z", "2027-02-01T00:07:00.123456Z", 3600, (206.11670096, 0)),
])
def test_real_selected_coordinates_preserve_totals_transitions_and_root_countdowns(
        lat, lon, start, end, step, expected_hours):
    """Numeric replay: never force constant January sunlight to match a dark texture."""
    series = compute_skyview(lat, lon, start, end, step)
    points = series["points"]
    times = [parse_utc(point["time_utc"]) for point in points]
    assert times[0] == parse_utc(start)
    assert times[-1] == parse_utc(end)
    assert series["horizon"]["provenance"]["spacing_m"] == 200
    assert series["horizon"]["coverage"]["requested_max_distance_m"] == 100000
    assert series["horizon"]["coverage"]["whole_moon_horizon_certified"] is False
    planning = visibility_summary(series, 0)
    for body, field, total, expected in (
            ("sun", "hours_until_sunset", "total_sunlight_hours", expected_hours[0]),
            ("earth", "hours_until_earthset", "total_earth_visible_hours", expected_hours[1])):
        intervals = series["visibility_intervals"][body]
        assert intervals["total_visible_hours"] == pytest.approx(expected, abs=1e-10)
        assert intervals["total_visible_hours"] == pytest.approx(planning[total], abs=1e-10)
        changes = [j for j in range(1, len(points))
                   if points[j - 1][body]["center_visible"] != points[j][body]["center_visible"]]
        sets = [j for j in changes if not points[j][body]["center_visible"]]
        for i, point in enumerate(points):
            assert point[body]["center_visible"] == (point[body]["clearance_deg"] > 0)
            # Countdown is at the point root; a next rise does not replace the next set.
            assert field not in point[body]
            next_set = next((j for j in sets if j > i), None)
            if next_set is None:
                assert point[field] is None
            else:
                assert point[field] == (times[next_set] - times[i]).total_seconds() / 3600
                assert point[field] > 0
            next_change = next((j for j in changes if j > i), None)
            expected_transition = None if next_change is None else {
                "after_utc": points[next_change - 1]["time_utc"],
                "by_utc": points[next_change]["time_utc"],
                "becomes_visible": points[next_change][body]["center_visible"],
            }
            assert point[body]["next_transition"] == expected_transition
        for interval in intervals["intervals"]:
            assert times[0] <= parse_utc(interval["start_utc"]) < parse_utc(interval["end_utc"]) <= times[-1]
            if interval["clipped_start"]:
                assert parse_utc(interval["start_utc"]) == times[0]
            if interval["clipped_end"]:
                assert parse_utc(interval["end_utc"]) == times[-1]
        assert points[-1][field] is None
        assert points[-1][body]["next_transition"] is None
