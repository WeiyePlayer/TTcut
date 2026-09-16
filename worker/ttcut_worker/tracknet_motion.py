"""Conservative, TrackNet-only refinement of accepted visibility candidates.

Missing detections do not establish a break. Splits require an observed dwell
followed by a slow pass; long bridges require observed high-flight motion.
All distances are relative to the unchanged analysis ROI and all windows use
source timestamps. No BlurBall tuning or reference intervals enter this policy.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import replace
from typing import Sequence

from .types import TrajectoryPoint
from .visibility_rallies import VisibilityRallySummary

TRACKNET_MOTION_POLICY_VERSION = 2
TRACKNET_OBSERVATION_GAP_SECONDS = 0.10
TRACKNET_SUPPORTED_BRIDGE_SECONDS = 4.50
TRACKNET_UNCERTAIN_TAIL_CONTEXT_SECONDS = 1.0
TRACKNET_MINIMUM_REFINED_RALLY_SECONDS = 0.75

Run = Sequence[TrajectoryPoint]
Window = tuple[TrajectoryPoint, TrajectoryPoint]


def _visible_runs(points: Run) -> list[list[TrajectoryPoint]]:
    groups: list[list[TrajectoryPoint]] = []
    for point in points:
        if point.visibility != 1:
            continue
        if not groups or point.time - groups[-1][-1].time > TRACKNET_OBSERVATION_GAP_SECONDS + 1e-3:
            groups.append([])
        groups[-1].append(point)
    return groups


def _span(run: Run, axis: str) -> float:
    values = [getattr(point, axis) for point in run]
    return max(values) - min(values)


def _active_windows(points: Run, width: float) -> list[Window]:
    """Local horizontal flights, including flights inside long mixed runs."""
    windows: list[Window] = []
    for run in _visible_runs(points):
        times = [point.time for point in run]
        for index, first in enumerate(run):
            left = max(index + 3, bisect_left(times, first.time + 0.099))
            right = bisect_right(times, first.time + 0.201)
            for last in run[left:right]:
                elapsed = last.time - first.time
                displacement = abs(last.x - first.x) / width
                if displacement >= 0.10 and displacement / elapsed >= 0.75:
                    windows.append((first, last))
                    break
    return windows


def _slow_passes(runs: Sequence[Run], width: float) -> list[Run]:
    passes: list[Run] = []
    for run in runs:
        elapsed = run[-1].time - run[0].time
        displacement = abs(run[-1].x - run[0].x)
        if (elapsed >= 0.60 and displacement >= width * 0.25
                and sum(abs(right.x - left.x) for left, right in zip(run, run[1:])) <= displacement * 1.08
                and displacement / width / elapsed < 0.75):
            passes.append(run)
    return passes


def _dwells(runs: Sequence[Run], width: float, height: float) -> list[tuple[float, float]]:
    """Observed low-motion windows, never a run of missing detections."""
    windows: list[tuple[float, float]] = []
    for run in runs:
        times = [point.time for point in run]
        for index, first in enumerate(run):
            stop = bisect_right(times, first.time + 0.55)
            sample = run[index:stop]
            if len(sample) < 4 or sample[-1].time - first.time < 0.45:
                continue
            if _span(sample, "x") < width * 0.09 and _span(sample, "y") < height * 0.15:
                if windows and first.time <= windows[-1][1]:
                    windows[-1] = (windows[-1][0], sample[-1].time)
                else:
                    windows.append((first.time, sample[-1].time))
    return [(start, end) for start, end in windows if end - start >= 0.65]


def _motion_groups(windows: Sequence[Window]) -> list[Window]:
    groups: list[Window] = []
    for first, last in windows:
        if groups and first.time - groups[-1][1].time <= 0.50:
            groups[-1] = (groups[-1][0], max(groups[-1][1], last, key=lambda point: point.time))
        else:
            groups.append((first, last))
    return groups


def _short_pass_only(segment: Run, passes: Sequence[Run], windows: Sequence[Window], fps: float) -> bool:
    if not passes or segment[-1].time - segment[0].time >= 2.0:
        return False
    # One brief false jump must not turn a long monotonic transfer into a rally.
    observed = {point.frame for first, last in windows for point in segment
                if first.frame <= point.frame <= last.frame}
    return len(observed) / fps < 0.25


def _split_after_pass(
    segment: Run, passes: Sequence[Run], width: float, height: float,
) -> list[tuple[Run, float | None]]:
    pieces: list[tuple[Run, float | None]] = [(segment, None)]
    for start, end in _dwells(_visible_runs(segment), width, height):
        following = [run for run in passes if (
            0 <= run[0].time - end <= 1.0
            and run[-1].time < segment[-1].time - TRACKNET_MINIMUM_REFINED_RALLY_SECONDS
        )]
        if not following:
            continue
        next_pieces: list[tuple[Run, float | None]] = []
        for piece, lead_in in pieces:
            left = [point for point in piece if point.time < start + 0.15]
            # Keep the next serve, but do not reintroduce the pass via export padding.
            pass_end = following[-1][-1].time
            right = [point for point in piece if point.time > max(end, pass_end + 0.20)]
            if (left and right
                    and left[-1].time - left[0].time >= TRACKNET_MINIMUM_REFINED_RALLY_SECONDS
                    and right[-1].time - right[0].time >= TRACKNET_MINIMUM_REFINED_RALLY_SECONDS
                    and _active_windows(left, width) and _active_windows(right, width)):
                next_pieces.extend(((left, lead_in), (right, pass_end + 0.20)))
            else:
                next_pieces.append((piece, lead_in))
        pieces = next_pieces
    return pieces


def _trim_tail(segment: Run, width: float, height: float, table_bottom: float) -> Run:
    groups = _motion_groups(_active_windows(segment, width))
    if not groups:
        return segment
    core = [groups[0]]
    for first, last in groups[1:]:
        # Sparse isolated movement several seconds after the last supported
        # exchange can be a returned ball. Short occlusions stay untouched.
        if first.time - core[-1][1].time > 4.0 and last.time - first.time < 0.55:
            break
        core.append((first, last))
    last = core[-1][1]
    duration = sum(end.time - start.time for start, end in core)
    tail = [point for point in segment if point.time > last.time]
    if duration < 0.55 or segment[-1].time - last.time <= 0.75 or len(tail) < 4:
        return segment
    tail_runs = _visible_runs(tail)
    passes = _slow_passes(_visible_runs(segment), width)
    slow_after = any(run[0].time >= last.time + 0.5 for run in passes)
    late_drop = any(
        run[0].time > last.time + 1.0 and run[-1].time - run[0].time >= 0.4
        and _span(run, "x") < width * 0.2 and _span(run, "y") > height * 0.3
        and run[-1].y > table_bottom for run in tail_runs
    )
    sparse_tail = all(run[-1].time - run[0].time < 0.3 and _span(run, "x") < width * 0.15
                      for run in tail_runs)
    if not (slow_after or late_drop or len(core) < len(groups) or sparse_tail):
        return segment
    end_run = next(run[-1].time for run in _visible_runs(segment)
                   if run[0].time <= last.time <= run[-1].time)
    cutoff = max(last.time + 0.3, min(end_run, last.time + 0.6))
    if not slow_after:
        # A weak/missing tail is less conclusive than an observed slow pass.
        # Protect the final stroke with a larger uncertainty allowance.
        cutoff = max(cutoff, last.time + TRACKNET_UNCERTAIN_TAIL_CONTEXT_SECONDS)
    result = [point for point in segment if point.time <= cutoff]
    if not result or result[-1].time - result[0].time < TRACKNET_MINIMUM_REFINED_RALLY_SECONDS:
        return segment
    return result


def _high_flight_support(points: Run, width: float, height: float) -> bool:
    return any(
        len(run) >= 4 and run[-1].time - run[0].time >= 0.3
        and _span(run, "y") > height * 0.4 and _span(run, "x") > width * 0.15
        for run in _visible_runs(points)
    )


def refine_tracknet_candidates(
    points: Run,
    candidates: Sequence[VisibilityRallySummary],
    fps: float,
    *,
    width: float,
    height: float,
    table_bottom: float,
) -> tuple[VisibilityRallySummary, ...]:
    """Refine accepted TrackNet candidates without treating absence as a break."""
    visible = sorted((point for point in points if point.visibility == 1), key=lambda point: point.time)
    times = [point.time for point in visible]
    result: list[VisibilityRallySummary] = []
    for candidate in candidates:
        segment = visible[bisect_left(times, candidate.start_time):bisect_right(times, candidate.end_time)]
        if len(segment) < 2:
            continue
        passes = _slow_passes(_visible_runs(segment), width)
        if _short_pass_only(segment, passes, _active_windows(segment, width), fps):
            continue
        for piece, lead_in in _split_after_pass(segment, passes, width, height):
            refined = _trim_tail(piece, width, height, table_bottom)
            result.append(replace(
                candidate, start_frame=refined[0].frame, end_frame=refined[-1].frame,
                start_time=refined[0].time, end_time=refined[-1].time,
                lead_in_start_time=lead_in if lead_in is not None else candidate.lead_in_start_time,
            ))
    merged: list[VisibilityRallySummary] = []
    for candidate in result:
        if merged:
            previous = merged[-1]
            gap = candidate.start_time - previous.end_time
            if 1.5 < gap <= TRACKNET_SUPPORTED_BRIDGE_SECONDS and candidate.lead_in_start_time is None:
                middle = visible[bisect_right(times, previous.end_time):bisect_left(times, candidate.start_time)]
                if _high_flight_support(middle, width, height):
                    merged[-1] = replace(previous, end_frame=candidate.end_frame, end_time=candidate.end_time)
                    continue
        merged.append(candidate)
    return tuple(merged)
