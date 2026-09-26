"""A fixed observation cadence for new rally decisions, with source timestamps.

Select real observations only: never interpolate a ball across missing frames.
The detector still retains its full trajectory; only rally decisions use this
clock so a five-sample window means the same duration at 30, 60 and 120 fps.
"""
from __future__ import annotations

import math
from bisect import bisect_left
from dataclasses import replace
from statistics import median
from typing import Sequence

from .types import TrajectoryPoint
from .visibility_rallies import VisibilityMotionConfig

RALLY_CLOCK_HZ = 30.0
PAUSE_WINDOW_SECONDS = 0.5
PAUSE_MINIMUM_SECONDS = 0.75
PAUSE_MAXIMUM_OBSERVATION_GAP_SECONDS = 0.1
PAUSE_BOUNDARY_CONTEXT_SECONDS = 0.2
PAUSE_MINIMUM_SUPPORT_SECONDS = 0.3
PAUSE_MAXIMUM_SPEED_RATIO = 0.35


def rally_timebase_provenance() -> dict:
    return {
        'maximum_clock_hz': RALLY_CLOCK_HZ, 'selection': 'nearest_source_observation',
        'pause_window_seconds': PAUSE_WINDOW_SECONDS,
        'pause_minimum_seconds': PAUSE_MINIMUM_SECONDS,
        'pause_minimum_support_seconds': PAUSE_MINIMUM_SUPPORT_SECONDS,
        'pause_maximum_speed_ratio_per_second': PAUSE_MAXIMUM_SPEED_RATIO,
        'pause_maximum_observation_gap_seconds': PAUSE_MAXIMUM_OBSERVATION_GAP_SECONDS,
        'pause_boundary_context_seconds': PAUSE_BOUNDARY_CONTEXT_SECONDS,
    }


def rally_clock_points(points: Sequence[TrajectoryPoint]) -> tuple[tuple[TrajectoryPoint, ...], dict[int, TrajectoryPoint]]:
    """Cap the observation cadence, retaining missing samples and source times."""
    ordered = sorted(points, key=lambda p: p.frame)
    if any(b.frame <= a.frame or b.time <= a.time for a, b in zip(ordered, ordered[1:])):
        raise ValueError('Rally observations must have strictly increasing frames and times')
    ticks: dict[int, TrajectoryPoint] = {}
    for point in ordered:
        if not math.isfinite(point.time) or point.time < 0:
            raise ValueError('Rally timestamps must be finite and non-negative')
        tick = math.floor(point.time * RALLY_CLOCK_HZ + 0.5)
        previous = ticks.get(tick)
        if previous is None or abs(point.time - tick / RALLY_CLOCK_HZ) < abs(previous.time - tick / RALLY_CLOCK_HZ):
            ticks[tick] = point
    periods = [b.time - a.time for a, b in zip(ordered, ordered[1:]) if b.time > a.time]
    # Retain native <=30 Hz observations. Millisecond-rounded/VFR timestamps
    # can collide in adjacent bins even though no temporal reduction is needed.
    native_cadence = not periods or median(periods) >= 1 / RALLY_CLOCK_HZ - .001
    selected = ordered if native_cadence else [ticks[tick] for tick in sorted(ticks)]
    source = dict(enumerate(selected))
    return tuple(replace(point, frame=frame) for frame, point in source.items()), source


def observed_pauses(points: Sequence[TrajectoryPoint], config: VisibilityMotionConfig) -> list[tuple[float, float]]:
    """Sustained local inactivity, supported across only brief detector gaps."""
    # End-on exchanges can have very little projected motion. Retain the
    # existing conservative exemption for that view until it has video evidence.
    if config.vertical_exchange_enabled:
        return []
    visible = [p for p in points if p.visibility]
    times = [p.time for p in visible]
    spans: list[list[float]] = []
    for start, point in enumerate(visible):
        end = bisect_left(times, point.time + PAUSE_WINDOW_SECONDS - .001)
        if end >= len(visible):
            break
        window = visible[start:end + 1]
        runs: list[list[TrajectoryPoint]] = []
        for sample in window:
            if not runs or sample.frame != runs[-1][-1].frame + 1:
                runs.append([sample])
            else:
                runs[-1].append(sample)
        # A jump after a dropout is not a flight. Actual horizontal or vertical
        # flights veto a pause even if static false detections surround them.
        flight = any(len(run) >= 4 and run[-1].time - run[0].time >= .1 - .001 and (
            max(p.x for p in run) - min(p.x for p in run) >= config.analysis_width_pixels * .15
            or max(p.y for p in run) - min(p.y for p in run) >= config.analysis_height_pixels * .15
        ) for run in runs)
        support = sum(b.time - a.time for run in runs for a, b in zip(run, run[1:])
                      if math.hypot((b.x - a.x) / config.analysis_width_pixels,
                                    (b.y - a.y) / config.analysis_height_pixels) / (b.time - a.time)
                      <= PAUSE_MAXIMUM_SPEED_RATIO)
        if (flight or support < PAUSE_MINIMUM_SUPPORT_SECONDS - .001
                or any(b.time - a.time > PAUSE_MAXIMUM_OBSERVATION_GAP_SECONDS + .001 for a, b in zip(window, window[1:]))):
            continue
        if spans and point.time <= spans[-1][1]:
            spans[-1][1] = window[-1].time
        else:
            spans.append([point.time, window[-1].time])
    return [(start + PAUSE_BOUNDARY_CONTEXT_SECONDS, end - PAUSE_BOUNDARY_CONTEXT_SECONDS)
            for start, end in spans if end - start >= PAUSE_MINIMUM_SECONDS - .001]
