"""Motion candidates minus positively observed invalid fragments.

All excluded intervals are half-open source-time ranges. Missing bounces never
create a boundary. Image-space rebound height is a trajectory feature, not a
measurement of physical height or a table/net-position rule.
"""
from __future__ import annotations

import math
from bisect import bisect_right
from dataclasses import dataclass
from statistics import median
from typing import Sequence

from .blurball_bounce import _BounceCandidate, detect_blurball_bounce_events
from .blurball_rallies import (
    _slow_transfer_runs, _transfer_observation_runs, blurball_visibility_rallies,
    _contiguous_visible_runs,
    _observed_exchange_times,
    _table_activity_ratios,
    _is_observed_horizontal_flight,
    observed_return_filter_provenance,
    OBSERVED_RETURN_MAXIMUM_GAP_SECONDS,
    OBSERVED_RETURN_MINIMUM_DISPLACEMENT_RATIO,
    blurball_inter_rally_filter_provenance,
    BLURBALL_SLOW_TRANSFER_MINIMUM_SECONDS,
    BLURBALL_SLOW_TRANSFER_MINIMUM_DISPLACEMENT_RATIO,
    BLURBALL_SLOW_TRANSFER_MAXIMUM_SPEED_RATIO,
    BLURBALL_SLOW_TRANSFER_FAST_FLIGHT_SPEED_RATIO,
)
from .calibration import TableCalibration
from .types import RallySummary, TrajectoryPoint
from . import visibility_rallies as visibility
from .visibility_rallies import (
    VisibilityMotionConfig, continuous_visibility_rallies,
    CONTINUOUS_VISIBILITY_START_SECONDS, CONTINUOUS_VISIBILITY_END_SECONDS,
)

MIN_BOUNCES = 3
MAX_GAP_SECONDS = 1.0
DECAY_RATIO = 0.85
MIN_DECAY_METRICS = 2
STRIKE_WINDOW_SECONDS = 0.20
STRIKE_MINIMUM_EXCURSION_RATIO = 0.04
STRIKE_MINIMUM_SPEED_RATIO = 0.35
STRIKE_LANDING_MINIMUM_SPEED_RATIO = 0.10
TRANSFER_STRIKE_CONTEXT_SECONDS = 0.25
TRANSFER_STRIKE_MINIMUM_TABLE_RATIO = 0.50


@dataclass(frozen=True)
class HybridResult:
    rallies: tuple[RallySummary, ...]
    bounce_frames: tuple[int, ...]
    excluded_fragments: tuple[dict, ...]


def hybrid_provenance(*, vertical_exchange_enabled: bool = False) -> dict:
    return {
        "method": "hybrid_motion_bounce", "version": 3,
        "candidate_refinement_version": 2,
        "observed_return_filter": observed_return_filter_provenance(),
        "detection_confidence_threshold": 0.30,
        "start_visible_seconds": CONTINUOUS_VISIBILITY_START_SECONDS,
        "end_invisible_seconds": CONTINUOUS_VISIBILITY_END_SECONDS,
        "motion_filter": {
            "minimum_horizontal_excursion_ratio": visibility.CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
            "maximum_reversal_gap_seconds": visibility.CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS,
            "minimum_horizontal_to_vertical_range_ratio": visibility.CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_TO_VERTICAL_RANGE_RATIO,
            "maximum_monotonic_vertical_reversals": visibility.CONTINUOUS_VISIBILITY_MAX_MONOTONIC_VERTICAL_REVERSALS,
            "minimum_monotonic_horizontal_range_ratio": visibility.CONTINUOUS_VISIBILITY_MIN_MONOTONIC_HORIZONTAL_RANGE_RATIO,
            "minimum_monotonic_duration_seconds": visibility.CONTINUOUS_VISIBILITY_MIN_MONOTONIC_DURATION_SECONDS,
            "short_vertical_filter_seconds": visibility.CONTINUOUS_VISIBILITY_SHORT_VERTICAL_FILTER_SECONDS,
            "maximum_short_vertical_range_ratio": visibility.CONTINUOUS_VISIBILITY_MAX_SHORT_VERTICAL_RANGE_RATIO,
            "vertical_exchange_enabled": vertical_exchange_enabled,
            "minimum_vertical_to_horizontal_range_ratio": visibility.CONTINUOUS_VISIBILITY_MIN_VERTICAL_TO_HORIZONTAL_RANGE_RATIO,
            "end_on_min_opposing_edge_balance": visibility.CONTINUOUS_VISIBILITY_END_ON_MIN_EDGE_BALANCE,
            "end_on_min_screen_aspect_ratio": visibility.CONTINUOUS_VISIBILITY_END_ON_MIN_SCREEN_ASPECT_RATIO,
        },
        "fragment_bridge": {
            "maximum_gap_seconds": visibility.CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SECONDS,
            "maximum_boundary_displacement_ratio": visibility.CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_DISPLACEMENT_RATIO,
            "maximum_boundary_speed_ratio_per_second": visibility.CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SPEED_RATIO_PER_SECOND,
        },
        "transfer_filter_version": 3,
        "slow_transfer_filter": {
            "minimum_seconds": BLURBALL_SLOW_TRANSFER_MINIMUM_SECONDS,
            "minimum_displacement_ratio": BLURBALL_SLOW_TRANSFER_MINIMUM_DISPLACEMENT_RATIO,
            "maximum_speed_ratio": BLURBALL_SLOW_TRANSFER_MAXIMUM_SPEED_RATIO,
            "fast_flight_speed_ratio": BLURBALL_SLOW_TRANSFER_FAST_FLIGHT_SPEED_RATIO,
            "strike_context_seconds": TRANSFER_STRIKE_CONTEXT_SECONDS,
            "minimum_strike_table_ratio": TRANSFER_STRIKE_MINIMUM_TABLE_RATIO,
        },
        "dead_bounce_filter": {
            "minimum_bounces": MIN_BOUNCES, "maximum_gap_seconds": MAX_GAP_SECONDS,
            "decay_ratio": DECAY_RATIO, "minimum_decay_metrics": MIN_DECAY_METRICS,
            "reenergization_veto": True,
            "strike_protection": {
                "version": 2,
                "window_seconds": STRIKE_WINDOW_SECONDS,
                "minimum_excursion_ratio": STRIKE_MINIMUM_EXCURSION_RATIO,
                "minimum_speed_ratio": STRIKE_MINIMUM_SPEED_RATIO,
                "opposed_landing_minimum_speed_ratio": STRIKE_LANDING_MINIMUM_SPEED_RATIO,
                "partial_exchange_version": 1,
            },
        },
        "transfer_filter": blurball_inter_rally_filter_provenance(),
    }


def _after(point: TrajectoryPoint, points: Sequence[TrajectoryPoint], fps: float) -> float:
    index = bisect_right([p.time for p in points], point.time)
    return points[index].time if index < len(points) else point.time + 1 / fps


def _supported(points: Sequence[TrajectoryPoint]) -> bool:
    return len(points) >= 2 and all(p.visibility for p in points) and all(
        b.frame == a.frame + 1 and b.time > a.time for a, b in zip(points, points[1:])
    )


def _flight_metrics(events: Sequence[_BounceCandidate], points: Sequence[TrajectoryPoint]):
    times = [p.time for p in points]
    heights: list[float | None] = []
    speeds: list[float | None] = []
    for a, b in zip(events, events[1:]):
        flight = points[bisect_right(times, a.point.time) - 1:bisect_right(times, b.point.time)]
        # Do not infer a rebound apex across missing detections.
        height = None
        if _supported(flight) and len(flight) >= 3:
            duration = b.point.time - a.point.time
            height = max(
                a.point.y + (b.point.y - a.point.y) * (p.time - a.point.time) / duration - p.y
                for p in flight
            )
        heights.append(height)
        # Same five-source-frame window as the detector, measured per second.
        departure = [p for p in flight if p.frame <= a.point.frame + 5]
        speed = None
        if _supported(departure):
            # Median scalar speed cannot cancel to zero when a short flight's
            # apex happens inside the five-frame window.
            speed = median(math.hypot(q.x - p.x, q.y - p.y) / (q.time - p.time)
                           for p, q in zip(departure, departure[1:]))
        speeds.append(speed)
    return heights, speeds


def _decays(values: Sequence[float | None]) -> bool:
    return len(values) >= 2 and all(v is not None and math.isfinite(v) and v > 0 for v in values) and all(
        b <= a * DECAY_RATIO + 1e-9 for a, b in zip(values, values[1:])
    )


def observed_strike_times(points: Sequence[TrajectoryPoint], config: VisibilityMotionConfig) -> tuple[float, ...]:
    """Require observed approach AND return motion, not a jump across occlusion.

    A table bounce reverses vertical velocity naturally. Only a substantial
    horizontal turn is strike evidence here; speed gain alone is not enough.
    """
    width = config.analysis_width_pixels
    strikes = []
    for run in _contiguous_visible_runs([p for p in points if p.visibility]):
        if len(run) < 7:
            continue
        xs = visibility._median_smooth([p.x for p in run], radius=1)
        times = [p.time for p in run]
        for index in range(3, len(run) - 3):
            first = bisect_right(times, times[index] - STRIKE_WINDOW_SECONDS - 1e-9)
            last = bisect_right(times, times[index] + STRIKE_WINDOW_SECONDS + 1e-9) - 1
            if index - first < 3 or last - index < 3:
                continue
            incoming, outgoing = xs[index] - xs[first], xs[last] - xs[index]
            if incoming * outgoing >= 0:
                continue
            if min(abs(incoming), abs(outgoing)) < width * STRIKE_MINIMUM_EXCURSION_RATIO:
                continue
            speed = min(abs(incoming) / (times[index] - times[first]),
                        abs(outgoing) / (times[last] - times[index])) / width
            if speed >= STRIKE_MINIMUM_SPEED_RATIO and (not strikes or times[index] - strikes[-1] > .2):
                strikes.append(times[index])
    return tuple(sorted(set(strikes) | set(_observed_exchange_times(points, width))))


def dead_bounce_fragments(
    events: Sequence[_BounceCandidate], points: Sequence[TrajectoryPoint], fps: float,
    *, motion_config: VisibilityMotionConfig | None = None,
    strike_times: Sequence[float] | None = None,
) -> list[dict]:
    heights, speeds = _flight_metrics(events, points)
    gaps = [b.point.time - a.point.time for a, b in zip(events, events[1:])]
    strikes = strike_times if strike_times is not None else (
        observed_strike_times(points, motion_config) if motion_config is not None else ()
    )
    fragments = []
    # Each start retains its longest qualifying prefix. Failure cannot recover:
    # all comparisons in a metric must qualify, and at least two metrics remain.
    for start in range(len(events) - 2):
        longest = None
        for end in range(start + 2, len(events)):
            interval = gaps[start:end]
            if any(g <= 0 or g > MAX_GAP_SECONDS + 1e-9 for g in interval):
                break
            # A deflection followed by a net rebound can reverse twice and
            # resume the original direction. Require a supported strike AND
            # opposed flight velocities at the surrounding landings.
            exchange_flight = motion_config is not None and any(
                a.after_velocity is not None and b.before_velocity is not None
                and a.after_velocity[0] * b.before_velocity[0] < 0
                and min(abs(a.after_velocity[0]), abs(b.before_velocity[0])) * fps
                / motion_config.analysis_width_pixels >= STRIKE_LANDING_MINIMUM_SPEED_RATIO
                and any(a.point.time <= time < b.point.time for time in strikes)
                for a, b in zip(events[start:end], events[start + 1:end + 1])
            )
            if exchange_flight:
                # A subsequent strike does not invalidate an earlier, fully
                # observed dead-ball prefix that already met all thresholds.
                break
            values = {"intervals": interval, "rebound_heights": heights[start:end], "departure_speeds": speeds[start:end]}
            matched = [name for name, series in values.items() if _decays(series)]
            if len(matched) < MIN_DECAY_METRICS:
                break
            longest = {
                "start_time_seconds": events[start].point.time,
                "end_time_seconds": _after(events[end].point, points, fps),
                "evidence": [{"reason": "dead_bounce_cluster", "bounce_times_seconds": [e.point.time for e in events[start:end + 1]],
                              **values, "matched_metrics": matched}],
            }
        if longest is not None:
            fragments.append(longest)
    return normalize_fragments(fragments)


def normalize_fragments(fragments: Sequence[dict]) -> list[dict]:
    merged: list[dict] = []
    for fragment in sorted(fragments, key=lambda f: (f["start_time_seconds"], f["end_time_seconds"])):
        if fragment["end_time_seconds"] <= fragment["start_time_seconds"]:
            continue
        if merged and fragment["start_time_seconds"] < merged[-1]["end_time_seconds"]:
            previous = merged[-1]
            previous["end_time_seconds"] = max(previous["end_time_seconds"], fragment["end_time_seconds"])
            previous["evidence"].extend(e for e in fragment["evidence"] if e not in previous["evidence"])
        else:
            merged.append({**fragment, "evidence": list(fragment["evidence"])})
    return merged


def slow_transfer_runs(points, calibration, config):
    """Apply positive pass evidence locally, not a whole-rally rejection.

    Keep the existing immediate opposite-flight serve protection. A later fast
    exchange must not veto an earlier independently observed transfer.
    """
    runs = _transfer_observation_runs([p for p in points if p.visibility], config.analysis_width_pixels)
    strikes = observed_strike_times(points, config)
    found = []
    for index, original in enumerate(runs):
        run = list(original)
        if (_table_activity_ratios(run, calibration)[1] >= TRANSFER_STRIKE_MINIMUM_TABLE_RATIO
                and any(run[0].time - TRANSFER_STRIKE_CONTEXT_SECONDS <= time
                        <= run[-1].time + TRANSFER_STRIKE_CONTEXT_SECONDS for time in strikes)):
            continue
        # A slow high return has low table coverage and can be followed by a
        # shorter projected return. Require the preceding observed strike AND
        # a distributed opposite flight immediately afterwards to preserve it.
        if any(run[0].time - TRANSFER_STRIKE_CONTEXT_SECONDS <= time
               <= run[0].time + TRANSFER_STRIKE_CONTEXT_SECONDS for time in strikes):
            direction = run[-1].x - run[0].x
            protected = False
            for next_index in range(index + 1, len(runs)):
                candidate = runs[next_index]
                if candidate[0].time - run[-1].time > OBSERVED_RETURN_MAXIMUM_GAP_SECONDS:
                    break
                if ((candidate[-1].x - candidate[0].x) * direction < 0
                        and _is_observed_horizontal_flight(
                            candidate, config.analysis_width_pixels,
                            minimum_displacement_ratio=OBSERVED_RETURN_MINIMUM_DISPLACEMENT_RATIO,
                        )):
                    protected = True
                    break
            if protected:
                continue
        # Held frames belong to neither side of the moving transfer interval.
        while len(run) > 2 and (run[0].x, run[0].y) == (run[1].x, run[1].y):
            run.pop(0)
        while len(run) > 2 and (run[-1].x, run[-1].y) == (run[-2].x, run[-2].y):
            run.pop()
        context = list(run)
        if index + 1 < len(runs) and runs[index + 1][0].time - run[-1].time <= 0.5:
            context.extend(runs[index + 1])
        found.extend(r for r in _slow_transfer_runs(context, calibration, config)
                     if r[0].frame == run[0].frame)
    return tuple(found)


def hybrid_motion_rallies(
    points: Sequence[TrajectoryPoint], fps: float, calibration: TableCalibration,
    *, motion_config: VisibilityMotionConfig,
    events: Sequence[_BounceCandidate] | None = None,
) -> HybridResult:
    ordered = sorted(points, key=lambda p: p.frame)
    candidates = blurball_visibility_rallies(
        ordered, fps, calibration, motion_config=motion_config, preserve_partial_exchanges=True,
    )
    events = sorted(detect_blurball_bounce_events(ordered, calibration) if events is None else events, key=lambda e: e.point.time)
    strikes = observed_strike_times(ordered, motion_config)
    fragments = []
    # Restrict clusters to individual motion candidates: no chain across an
    # already established rally boundary, regardless of distance between them.
    for candidate in candidates:
        selected = [e for e in events if candidate.start_time <= e.point.time <= candidate.end_time]
        fragments.extend(dead_bounce_fragments(
            selected, ordered, fps, motion_config=motion_config, strike_times=strikes,
        ))
    if not motion_config.vertical_exchange_enabled:
        # Match the existing side-view transfer filter and its serve protections.
        for candidate in continuous_visibility_rallies(ordered, fps):
            observed = [p for p in ordered if candidate.start_time - 0.2 <= p.time <= candidate.end_time]
            for run in slow_transfer_runs(observed, calibration, motion_config):
                duration = run[-1].time - run[0].time
                span = (max(p.x for p in run) - min(p.x for p in run)) / motion_config.analysis_width_pixels
                fragments.append({
                    "start_time_seconds": run[0].time, "end_time_seconds": _after(run[-1], ordered, fps),
                    "evidence": [{"reason": "slow_transfer", "duration_seconds": duration,
                                  "span_ratio": span, "speed_ratio_per_second": span / duration,
                                  "bounce_times_seconds": [e.point.time for e in events if run[0].time <= e.point.time <= run[-1].time]}],
                })
    fragments = normalize_fragments(fragments)
    def excluded(time: float) -> bool:
        return any(f["start_time_seconds"] <= time < f["end_time_seconds"] for f in fragments)
    valid = [e for e in events if not excluded(e.point.time)]
    rallies = []
    zero_fragments = []
    for candidate in candidates:
        end = _after(next(p for p in ordered if p.frame == candidate.end_frame), ordered, fps)
        pieces = [(candidate.start_time, end, False)]
        for fragment in fragments:
            updated = []
            a, b = fragment["start_time_seconds"], fragment["end_time_seconds"]
            for start, stop, restart in pieces:
                if b <= start or a >= stop:
                    updated.append((start, stop, restart))
                else:
                    if start < a:
                        updated.append((start, a, restart))
                    if b < stop:
                        updated.append((b, stop, True))
            pieces = updated
        for start, stop, restart in pieces:
            segment = [p for p in ordered if start <= p.time < stop]
            visible = [p for p in segment if p.visibility]
            if len(visible) < 2:
                continue
            ranges = blurball_visibility_rallies(
                segment, fps, calibration, motion_config=motion_config, preserve_partial_exchanges=True,
            ) if restart else ()
            if restart and not ranges:
                continue
            bounds = [(r.start_time, r.end_time) for r in ranges] if restart else [(visible[0].time, visible[-1].time)]
            for first, last in bounds:
                support = [p for p in visible if first <= p.time <= last]
                count = sum(first <= e.point.time <= last for e in valid)
                if count == 0:
                    zero_fragments.append({"start_time_seconds": first, "end_time_seconds": _after(support[-1], ordered, fps),
                                           "evidence": [{"reason": "zero_bounce_rally", "bounce_count": 0}]})
                elif last > first:
                    rallies.append(RallySummary(support[0].frame, support[-1].frame, first, last, count))
    return HybridResult(tuple(rallies), tuple(e.point.frame for e in valid), tuple(normalize_fragments([*fragments, *zero_fragments])))
