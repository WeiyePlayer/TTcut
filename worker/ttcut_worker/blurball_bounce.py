from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Sequence

from .bounce import DEFAULT_MINIMUM_BOUNCE_INTERVAL_SECONDS
from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .types import TrajectoryPoint


TABLE_LENGTH_MARGIN_CM = 35.0
TABLE_WIDTH_MARGIN_CM = 25.0
TRAJECTORY_WINDOW_FRAMES = 5
MAX_INTERPOLATED_GAP_FRAMES = 2
MIN_APPROACH_PIXELS_PER_FRAME = 0.0
MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME = 0.75
MIN_VERTICAL_TURN_PIXELS_PER_FRAME = 6.0
MIN_CHANGE_SCORE = 8.0
ONE_SIDED_EDGE_BAND_CM = 35.0


@dataclass(frozen=True)
class _BounceCandidate:
    point: TrajectoryPoint
    score: float
    kind: str


def landing_table_coordinates(
    landing: TrajectoryPoint,
    calibration: TableCalibration,
    table_length_margin_cm: float = TABLE_LENGTH_MARGIN_CM,
    table_width_margin_cm: float = TABLE_WIDTH_MARGIN_CM,
) -> tuple[float, float] | None:
    """Return calibrated coordinates only inside TTcut's expanded table region."""
    table_x, table_y = calibration.image_to_table(landing.x, landing.y)
    if (
        -table_length_margin_cm <= table_x <= TABLE_LENGTH_CM + table_length_margin_cm
        and -table_width_margin_cm <= table_y <= TABLE_WIDTH_CM + table_width_margin_cm
    ):
        return table_x, table_y
    return None


def _has_usable_timing(points: Sequence[TrajectoryPoint]) -> bool:
    return bool(points) and all(math.isfinite(point.time) for point in points) and all(
        first.frame < second.frame and first.time < second.time
        for first, second in zip(points, points[1:])
    )


def _has_supported_gaps(points: Sequence[TrajectoryPoint]) -> bool:
    return all(
        second.frame - first.frame - 1 <= MAX_INTERPOLATED_GAP_FRAMES
        for first, second in zip(points, points[1:])
    )


def _median_velocity(points: Sequence[TrajectoryPoint]) -> tuple[float, float] | None:
    if len(points) < 2 or not _has_usable_timing(points) or not _has_supported_gaps(points):
        return None
    x_slopes: list[float] = []
    y_slopes: list[float] = []
    for index, first in enumerate(points):
        for second in points[index + 1:]:
            frame_delta = second.frame - first.frame
            if frame_delta <= 0:
                continue
            x_slopes.append((second.x - first.x) / frame_delta)
            y_slopes.append((second.y - first.y) / frame_delta)
    if not x_slopes:
        return None
    return float(statistics.median(x_slopes)), float(statistics.median(y_slopes))


def _linear_fit_sse(points: Sequence[TrajectoryPoint]) -> float | None:
    if len(points) < 2 or not _has_usable_timing(points):
        return None
    frames = [float(point.frame) for point in points]
    mean_frame = statistics.fmean(frames)
    denominator = sum((frame - mean_frame) ** 2 for frame in frames)
    if denominator <= 0:
        return None
    total = 0.0
    for attribute in ("x", "y"):
        values = [float(getattr(point, attribute)) for point in points]
        mean_value = statistics.fmean(values)
        slope = sum(
            (frame - mean_frame) * (value - mean_value)
            for frame, value in zip(frames, values)
        ) / denominator
        intercept = mean_value - slope * mean_frame
        total += sum(
            (value - (slope * frame + intercept)) ** 2
            for frame, value in zip(frames, values)
        )
    return total


def _piecewise_fit_gain(
    before: Sequence[TrajectoryPoint],
    after: Sequence[TrajectoryPoint],
) -> float:
    combined = tuple(dict.fromkeys((*before, *after)))
    whole_sse = _linear_fit_sse(combined)
    before_sse = _linear_fit_sse(before)
    after_sse = _linear_fit_sse(after)
    if whole_sse is None or before_sse is None or after_sse is None:
        return 0.0
    return max(0.0, whole_sse - before_sse - after_sse)


def _two_sided_candidate(
    before: Sequence[TrajectoryPoint],
    after: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
    table_length_margin_cm: float,
    table_width_margin_cm: float,
) -> _BounceCandidate | None:
    landing = before[-1]
    if not after or after[0].frame != landing.frame:
        return None
    before_velocity = _median_velocity(before)
    after_velocity = _median_velocity(after)
    if before_velocity is None or after_velocity is None:
        return None
    if landing_table_coordinates(
        landing,
        calibration,
        table_length_margin_cm,
        table_width_margin_cm,
    ) is None:
        return None
    before_x, before_y = before_velocity
    after_x, after_y = after_velocity
    vertical_turn = before_y - after_y
    horizontal_change = abs(before_x - after_x)
    change_score = vertical_turn + 0.25 * horizontal_change
    if before_y < MIN_APPROACH_PIXELS_PER_FRAME:
        return None
    if vertical_turn < MIN_VERTICAL_TURN_PIXELS_PER_FRAME or change_score < MIN_CHANGE_SCORE:
        return None
    fit_gain = _piecewise_fit_gain(before, after)
    missing_penalty = 0.5 * (
        max(0, TRAJECTORY_WINDOW_FRAMES + 1 - len(before))
        + max(0, TRAJECTORY_WINDOW_FRAMES + 1 - len(after))
    )
    return _BounceCandidate(
        landing,
        change_score + 0.2 * math.sqrt(fit_gain) - missing_penalty,
        "two-sided",
    )


def _visible_segments(points: Sequence[TrajectoryPoint]) -> tuple[tuple[TrajectoryPoint, ...], ...]:
    visible = [point for point in points if point.visibility == 1 and math.isfinite(point.time)]
    if not visible:
        return ()
    segments: list[list[TrajectoryPoint]] = [[visible[0]]]
    for point in visible[1:]:
        previous = segments[-1][-1]
        if (
            point.frame <= previous.frame
            or point.time <= previous.time
            or point.frame - previous.frame - 1 > MAX_INTERPOLATED_GAP_FRAMES
        ):
            segments.append([point])
        else:
            segments[-1].append(point)
    return tuple(tuple(segment) for segment in segments)


def _one_sided_candidates(
    points: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
    table_length_margin_cm: float,
    table_width_margin_cm: float,
) -> tuple[_BounceCandidate, ...]:
    candidates: list[_BounceCandidate] = []
    segments = _visible_segments(points)
    for segment_index, segment in enumerate(segments):
        if len(segment) < 4:
            continue
        start_window = segment[:TRAJECTORY_WINDOW_FRAMES + 1]
        end_window = segment[-(TRAJECTORY_WINDOW_FRAMES + 1):]
        start_velocity = _median_velocity(start_window)
        end_velocity = _median_velocity(end_window)
        start_table = landing_table_coordinates(
            segment[0], calibration, table_length_margin_cm, table_width_margin_cm,
        )
        previous_segment = segments[segment_index - 1] if segment_index > 0 else None
        has_long_leading_gap = (
            previous_segment is None
            or segment[0].frame - previous_segment[-1].frame > TRAJECTORY_WINDOW_FRAMES + 1
        )
        if has_long_leading_gap and start_velocity is not None and start_table is not None:
            _, table_y = start_table
            near_edge = min(abs(table_y), abs(TABLE_WIDTH_CM - table_y)) <= ONE_SIDED_EDGE_BAND_CM
            if near_edge and start_velocity[1] <= -MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME:
                candidates.append(_BounceCandidate(
                    segment[0],
                    4.0 + abs(start_velocity[1]) + 0.05 * max(0.0, segment[0].confidence),
                    "track-birth",
                ))
        end_table = landing_table_coordinates(
            segment[-1], calibration, table_length_margin_cm, table_width_margin_cm,
        )
        next_segment = segments[segment_index + 1] if segment_index + 1 < len(segments) else None
        has_long_trailing_gap = (
            next_segment is None
            or next_segment[0].frame - segment[-1].frame > TRAJECTORY_WINDOW_FRAMES + 1
        )
        if has_long_trailing_gap and end_velocity is not None and end_table is not None:
            _, table_y = end_table
            near_edge = min(abs(table_y), abs(TABLE_WIDTH_CM - table_y)) <= ONE_SIDED_EDGE_BAND_CM
            if near_edge and end_velocity[1] >= MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME:
                candidates.append(_BounceCandidate(
                    segment[-1],
                    4.0 + abs(end_velocity[1]) + 0.05 * max(0.0, segment[-1].confidence),
                    "track-death",
                ))
    return tuple(candidates)


def detect_blurball_bounce_frames(
    points: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
    *,
    minimum_interval_seconds: float = DEFAULT_MINIMUM_BOUNCE_INTERVAL_SECONDS,
    table_length_margin_cm: float = TABLE_LENGTH_MARGIN_CM,
    table_width_margin_cm: float = TABLE_WIDTH_MARGIN_CM,
) -> list[int]:
    """Apply BlurBall's trajectory-change detector with TTcut's existing bounds."""
    for name, value in (
        ("minimum_interval_seconds", minimum_interval_seconds),
        ("table_length_margin_cm", table_length_margin_cm),
        ("table_width_margin_cm", table_width_margin_cm),
    ):
        if not math.isfinite(float(value)) or float(value) < 0:
            raise ValueError(f"{name} must be finite and non-negative")
    ordered = sorted(points, key=lambda point: (point.frame, point.time))
    candidates: dict[int, _BounceCandidate] = {}

    def add_or_replace(candidate: _BounceCandidate) -> None:
        existing = candidates.get(candidate.point.frame)
        if existing is None or candidate.score > existing.score:
            candidates[candidate.point.frame] = candidate

    for index, landing in enumerate(ordered):
        if landing.visibility != 1 or not math.isfinite(landing.time):
            continue
        before = [
            point for point in ordered[max(0, index - TRAJECTORY_WINDOW_FRAMES):index + 1]
            if point.visibility == 1 and landing.frame - point.frame <= TRAJECTORY_WINDOW_FRAMES
        ]
        after = [
            point for point in ordered[index:index + TRAJECTORY_WINDOW_FRAMES + 1]
            if point.visibility == 1 and point.frame - landing.frame <= TRAJECTORY_WINDOW_FRAMES
        ]
        if len(before) < 2 or len(after) < 2:
            continue
        candidate = _two_sided_candidate(
            before,
            after,
            calibration,
            table_length_margin_cm,
            table_width_margin_cm,
        )
        if candidate is not None:
            add_or_replace(candidate)
    for candidate in _one_sided_candidates(
        ordered,
        calibration,
        table_length_margin_cm,
        table_width_margin_cm,
    ):
        add_or_replace(candidate)

    selected: list[_BounceCandidate] = []
    for candidate in sorted(
        candidates.values(),
        key=lambda value: (-value.score, value.point.time, value.point.frame),
    ):
        if all(
            abs(candidate.point.time - kept.point.time) >= minimum_interval_seconds
            for kept in selected
        ):
            selected.append(candidate)
    return [
        candidate.point.frame
        for candidate in sorted(selected, key=lambda value: (value.point.time, value.point.frame))
    ]
