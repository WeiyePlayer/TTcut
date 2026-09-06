from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from statistics import median
from typing import Sequence

from .types import TrajectoryPoint


CONTINUOUS_VISIBILITY_START_SECONDS = 0.20
CONTINUOUS_VISIBILITY_END_SECONDS = 0.50
CONTINUOUS_VISIBILITY_CONFIDENCE_THRESHOLD = 0.30
CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO = 20.0 / 618.0
CONTINUOUS_VISIBILITY_MIN_VERTICAL_EXCURSION_RATIO = 12.0 / 347.0
CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS = 0.35
CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_TO_VERTICAL_RANGE_RATIO = 0.70
CONTINUOUS_VISIBILITY_MAX_MONOTONIC_VERTICAL_REVERSALS = 1
CONTINUOUS_VISIBILITY_MIN_MONOTONIC_HORIZONTAL_RANGE_RATIO = 200.0 / 618.0
CONTINUOUS_VISIBILITY_MIN_MONOTONIC_DURATION_SECONDS = 0.60
CONTINUOUS_VISIBILITY_SHORT_VERTICAL_FILTER_SECONDS = 1.20
CONTINUOUS_VISIBILITY_MAX_SHORT_VERTICAL_RANGE_RATIO = 0.50
CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SECONDS = 1.50
CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_DISPLACEMENT_RATIO = 0.35
CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SPEED_RATIO_PER_SECOND = 0.26
CONTINUOUS_VISIBILITY_END_ON_MIN_EDGE_BALANCE = 0.85
CONTINUOUS_VISIBILITY_END_ON_MIN_SCREEN_ASPECT_RATIO = 2.0
CONTINUOUS_VISIBILITY_MIN_VERTICAL_TO_HORIZONTAL_RANGE_RATIO = 1.0


@dataclass(frozen=True)
class VisibilityRallySummary:
    start_frame: int
    end_frame: int
    start_time: float
    end_time: float
    # Earliest automatic lead-in after an observed transfer; manual edits remain free.
    lead_in_start_time: float | None = None


@dataclass(frozen=True)
class VisibilityMotionConfig:
    analysis_width_pixels: float
    analysis_height_pixels: float
    vertical_exchange_enabled: bool = False


def is_end_on_table_view(points: Sequence[tuple[float, float]]) -> bool:
    """Return whether the calibrated table is a conservative end-on view."""

    if len(points) != 4:
        raise ValueError("table view detection requires four ordered points")
    top_left, top_right, bottom_right, bottom_left = points
    top_edge = math.dist(top_left, top_right)
    bottom_edge = math.dist(bottom_left, bottom_right)
    left_edge = math.dist(top_left, bottom_left)
    right_edge = math.dist(top_right, bottom_right)
    lengths = (top_edge, bottom_edge, left_edge, right_edge)
    if any(not math.isfinite(length) or length <= 0 for length in lengths):
        return False
    opposing_edge_balance = min(top_edge, bottom_edge) / max(top_edge, bottom_edge)
    screen_aspect_ratio = (top_edge + bottom_edge) / (left_edge + right_edge)
    return (
        opposing_edge_balance >= CONTINUOUS_VISIBILITY_END_ON_MIN_EDGE_BALANCE
        and screen_aspect_ratio >= CONTINUOUS_VISIBILITY_END_ON_MIN_SCREEN_ASPECT_RATIO
    )


def continuous_visibility_rallies(
    points: Sequence[TrajectoryPoint],
    fps: float,
    *,
    start_seconds: float = CONTINUOUS_VISIBILITY_START_SECONDS,
    end_seconds: float = CONTINUOUS_VISIBILITY_END_SECONDS,
    motion_config: VisibilityMotionConfig | None = None,
) -> tuple[VisibilityRallySummary, ...]:
    """Group visible frames, then optionally keep ball-exchange motion and bridge occlusions."""

    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("fps must be finite and positive")
    if not math.isfinite(start_seconds) or start_seconds <= 0:
        raise ValueError("start_seconds must be finite and positive")
    if not math.isfinite(end_seconds) or end_seconds <= 0:
        raise ValueError("end_seconds must be finite and positive")
    if motion_config is not None and (
        not math.isfinite(motion_config.analysis_width_pixels)
        or motion_config.analysis_width_pixels <= 0
        or not math.isfinite(motion_config.analysis_height_pixels)
        or motion_config.analysis_height_pixels <= 0
    ):
        raise ValueError("motion analysis dimensions must be finite and positive")

    start_frames = max(2, math.ceil(fps * start_seconds))
    end_frames = max(1, math.ceil(fps * end_seconds))
    ordered = sorted(points, key=lambda point: (point.frame, point.time))
    _validate_points(ordered)

    confirmed: list[VisibilityRallySummary] = []
    candidate_start: TrajectoryPoint | None = None
    last_visible: TrajectoryPoint | None = None
    visible_streak = 0
    missing_streak = 0
    active = False

    def reset_candidate() -> None:
        nonlocal candidate_start, last_visible, visible_streak
        candidate_start = None
        last_visible = None
        visible_streak = 0

    def finish_active() -> None:
        nonlocal active, missing_streak
        if candidate_start is not None and last_visible is not None and last_visible.time > candidate_start.time:
            confirmed.append(VisibilityRallySummary(
                start_frame=candidate_start.frame,
                end_frame=last_visible.frame,
                start_time=candidate_start.time,
                end_time=last_visible.time,
            ))
        active = False
        missing_streak = 0
        reset_candidate()

    for point in ordered:
        visible = point.visibility == 1
        if not active:
            if not visible:
                reset_candidate()
                continue
            if candidate_start is None:
                candidate_start = point
            last_visible = point
            visible_streak += 1
            if visible_streak >= start_frames:
                active = True
                missing_streak = 0
            continue

        if visible:
            last_visible = point
            missing_streak = 0
            continue

        missing_streak += 1
        if missing_streak >= end_frames:
            finish_active()

    if active:
        finish_active()
    if motion_config is None:
        return tuple(confirmed)

    frames = [point.frame for point in ordered]
    accepted: list[tuple[VisibilityRallySummary, TrajectoryPoint, TrajectoryPoint]] = []
    for rally in confirmed:
        start_index = bisect_left(frames, rally.start_frame)
        end_index = bisect_right(frames, rally.end_frame)
        segment = ordered[start_index:end_index]
        if not _is_ball_exchange(segment, fps, motion_config):
            continue
        visible_points = [point for point in segment if point.visibility == 1]
        accepted.append((rally, visible_points[0], visible_points[-1]))

    merged: list[tuple[VisibilityRallySummary, TrajectoryPoint, TrajectoryPoint]] = []
    for rally, first_visible, last_visible_point in accepted:
        if merged:
            previous, previous_first, previous_last = merged[-1]
            gap = rally.start_time - previous.end_time
            displacement = math.hypot(
                first_visible.x - previous_last.x,
                first_visible.y - previous_last.y,
            )
            normalized_boundary_speed = (
                displacement / motion_config.analysis_width_pixels / gap
                if gap > 0
                else math.inf
            )
            if (
                0 < gap <= CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SECONDS
                and displacement
                <= motion_config.analysis_width_pixels * CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_DISPLACEMENT_RATIO
                and normalized_boundary_speed
                <= CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SPEED_RATIO_PER_SECOND
            ):
                merged[-1] = (
                    VisibilityRallySummary(
                        start_frame=previous.start_frame,
                        end_frame=rally.end_frame,
                        start_time=previous.start_time,
                        end_time=rally.end_time,
                    ),
                    previous_first,
                    last_visible_point,
                )
                continue
        merged.append((rally, first_visible, last_visible_point))
    return tuple(rally for rally, _, _ in merged)


def _is_ball_exchange(
    points: Sequence[TrajectoryPoint],
    fps: float,
    config: VisibilityMotionConfig,
) -> bool:
    visible = [point for point in points if point.visibility == 1]
    horizontal = [float(point.x) for point in visible]
    vertical = [float(point.y) for point in visible]
    frames = [point.frame for point in visible]
    horizontal_excursion = (
        config.analysis_width_pixels * CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO
    )
    vertical_excursion = config.analysis_height_pixels * CONTINUOUS_VISIBILITY_MIN_VERTICAL_EXCURSION_RATIO
    maximum_missing_frames = math.floor(fps * CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS)
    horizontal_range = _value_range(horizontal)
    vertical_range = _value_range(vertical)
    duration = visible[-1].time - visible[0].time if len(visible) >= 2 else 0.0

    robust_exchange = (
        _significant_reversals(_median_smooth(horizontal), horizontal_excursion) >= 1
        and _run_reversals(horizontal, frames, horizontal_excursion, maximum_missing_frames) >= 1
        and horizontal_range
        >= vertical_range * CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_TO_VERTICAL_RANGE_RATIO
    )
    robust_vertical_exchange = (
        config.vertical_exchange_enabled
        and _significant_reversals(
            _median_smooth(vertical),
            config.analysis_height_pixels * CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
        ) >= 1
        and _run_reversals(
            vertical,
            frames,
            config.analysis_height_pixels * CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
            maximum_missing_frames,
        ) >= 1
        and vertical_range
        >= horizontal_range * CONTINUOUS_VISIBILITY_MIN_VERTICAL_TO_HORIZONTAL_RANGE_RATIO
    )
    monotonic_cross_table = (
        _significant_reversals(vertical, vertical_excursion)
        <= CONTINUOUS_VISIBILITY_MAX_MONOTONIC_VERTICAL_REVERSALS
        and horizontal_range
        >= config.analysis_width_pixels * CONTINUOUS_VISIBILITY_MIN_MONOTONIC_HORIZONTAL_RANGE_RATIO
    )
    qualified_monotonic_cross_table = (
        monotonic_cross_table
        and duration >= CONTINUOUS_VISIBILITY_MIN_MONOTONIC_DURATION_SECONDS
        and not (
            duration < CONTINUOUS_VISIBILITY_SHORT_VERTICAL_FILTER_SECONDS
            and vertical_range
            > config.analysis_height_pixels * CONTINUOUS_VISIBILITY_MAX_SHORT_VERTICAL_RANGE_RATIO
        )
    )
    return robust_exchange or robust_vertical_exchange or qualified_monotonic_cross_table


def _median_smooth(values: Sequence[float], radius: int = 2) -> list[float]:
    if len(values) < 3:
        return [float(value) for value in values]
    padded = (
        [float(values[0])] * radius
        + [float(value) for value in values]
        + [float(values[-1])] * radius
    )
    width = radius * 2 + 1
    return [float(median(padded[index:index + width])) for index in range(len(values))]


def _mean_smooth(values: Sequence[float], radius: int = 2) -> list[float]:
    if len(values) < 3:
        return [float(value) for value in values]
    padded = (
        [float(values[0])] * radius
        + [float(value) for value in values]
        + [float(values[-1])] * radius
    )
    width = radius * 2 + 1
    return [sum(padded[index:index + width]) / width for index in range(len(values))]


def _significant_reversals(values: Sequence[float], minimum_excursion: float) -> int:
    if len(values) < 3:
        return 0
    smoothed = _mean_smooth(values)
    anchor = smoothed[0]
    extreme = anchor
    direction = 0
    reversals = 0
    for value in smoothed[1:]:
        if direction == 0:
            delta = value - anchor
            if abs(delta) >= minimum_excursion:
                direction = 1 if delta > 0 else -1
                extreme = value
            continue
        if direction > 0:
            if value > extreme:
                extreme = value
            elif extreme - value >= minimum_excursion:
                reversals += 1
                direction = -1
                extreme = value
        else:
            if value < extreme:
                extreme = value
            elif value - extreme >= minimum_excursion:
                reversals += 1
                direction = 1
                extreme = value
    return reversals


def _run_reversals(
    values: Sequence[float],
    frames: Sequence[int],
    minimum_excursion: float,
    maximum_missing_frames: int,
) -> int:
    total = 0
    run_start = 0
    for index in range(1, len(values) + 1):
        if index == len(values) or frames[index] - frames[index - 1] - 1 > maximum_missing_frames:
            total += _significant_reversals(values[run_start:index], minimum_excursion)
            run_start = index
    return total


def _value_range(values: Sequence[float]) -> float:
    return max(values) - min(values) if values else 0.0


def _validate_points(points: Sequence[TrajectoryPoint]) -> None:
    for previous, current in zip(points, points[1:]):
        if current.frame <= previous.frame or current.time <= previous.time:
            raise ValueError("trajectory points must be strictly ordered")
    if any(not math.isfinite(point.time) for point in points):
        raise ValueError("trajectory points must have finite times")
