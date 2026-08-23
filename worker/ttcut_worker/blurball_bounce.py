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
MIN_APPROACH_PIXELS_PER_FRAME = -5.0
MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME = 0.75
MIN_ONE_SIDED_HORIZONTAL_SPEED_PIXELS_PER_FRAME = 6.0
MIN_TWO_SIDED_SPEED_PIXELS_PER_FRAME = 2.5
MIN_SLOW_APPROACH_SPEED_PIXELS_PER_FRAME = 1.0
MIN_SLOW_APPROACH_LANDING_CONFIDENCE = 10.0
MIN_SLOW_DEPARTURE_SPEED_PIXELS_PER_FRAME = 2.0
MIN_SLOW_DEPARTURE_LANDING_CONFIDENCE = 15.0
MAX_TWO_SIDED_SPEED_GAIN = 2.0
MAX_TWO_SIDED_ABSOLUTE_SPEED_GAIN = 5.0
MIN_VERTICAL_TURN_PIXELS_PER_FRAME = 4.0
MIN_CHANGE_SCORE = 4.0
MIN_STANDARD_VERTICAL_TURN_PIXELS_PER_FRAME = 6.0
MIN_STANDARD_CHANGE_SCORE = 7.4
MIN_DIRECTION_COSINE = 0.15
MAX_NEAR_VERTICAL_X_SPEED_PIXELS_PER_FRAME = 3.5
MAX_DUPLICATE_WINDOW_SECONDS = 0.20
SPATIAL_DUPLICATE_WINDOW_SECONDS = 0.35
SPATIAL_DUPLICATE_MIN_SECONDS = 0.15
SPATIAL_DUPLICATE_DISTANCE_PIXELS = 30.0
ONE_SIDED_EDGE_BAND_CM = 35.0
ONE_SIDED_WINDOW_POINTS = 4
SHORT_GAP_LENGTH_EDGE_BAND_CM = 45.0


@dataclass(frozen=True)
class _BounceCandidate:
    point: TrajectoryPoint
    score: float
    kind: str
    before_velocity: tuple[float, float] | None = None
    after_velocity: tuple[float, float] | None = None


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


def _supported_suffix(points: Sequence[TrajectoryPoint]) -> list[TrajectoryPoint]:
    """Keep the nearest gap-supported run ending at a candidate landing."""

    if not points:
        return []
    start = len(points) - 1
    while start > 0:
        if points[start].frame - points[start - 1].frame - 1 > MAX_INTERPOLATED_GAP_FRAMES:
            break
        start -= 1
    return list(points[start:])


def _supported_prefix(points: Sequence[TrajectoryPoint]) -> list[TrajectoryPoint]:
    """Keep the nearest gap-supported run starting at a candidate landing."""

    if not points:
        return []
    end = 1
    while end < len(points):
        if points[end].frame - points[end - 1].frame - 1 > MAX_INTERPOLATED_GAP_FRAMES:
            break
        end += 1
    return list(points[:end])


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


def _add_or_replace_candidate(
    candidates: dict[int, _BounceCandidate], candidate: _BounceCandidate,
) -> None:
    existing = candidates.get(candidate.point.frame)
    if existing is None or candidate.score > existing.score:
        candidates[candidate.point.frame] = candidate


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
    before_speed = math.hypot(before_x, before_y)
    after_speed = math.hypot(after_x, after_y)
    near_vertical_v = (
        abs(before_x) <= MAX_NEAR_VERTICAL_X_SPEED_PIXELS_PER_FRAME
        and abs(after_x) <= MAX_NEAR_VERTICAL_X_SPEED_PIXELS_PER_FRAME
    )
    slow_approach_supported = (
        before_speed >= MIN_SLOW_APPROACH_SPEED_PIXELS_PER_FRAME
        and landing.confidence >= MIN_SLOW_APPROACH_LANDING_CONFIDENCE
        and near_vertical_v
    )
    if after_speed < MIN_SLOW_DEPARTURE_SPEED_PIXELS_PER_FRAME:
        return None
    if before_speed < MIN_TWO_SIDED_SPEED_PIXELS_PER_FRAME and not slow_approach_supported:
        return None
    direction_cosine = (before_x * after_x + before_y * after_y) / (
        before_speed * after_speed
    )
    slow_departure_supported = (
        after_speed < MIN_TWO_SIDED_SPEED_PIXELS_PER_FRAME
        and landing.confidence >= MIN_SLOW_DEPARTURE_LANDING_CONFIDENCE
        and direction_cosine >= MIN_DIRECTION_COSINE
    )
    if after_speed < MIN_TWO_SIDED_SPEED_PIXELS_PER_FRAME and not slow_departure_supported:
        return None
    if not near_vertical_v and after_speed > before_speed * MAX_TWO_SIDED_SPEED_GAIN:
        return None
    if direction_cosine < MIN_DIRECTION_COSINE and not near_vertical_v:
        return None

    vertical_turn = before_y - after_y
    horizontal_change = abs(before_x - after_x)
    change_score = vertical_turn + 0.25 * horizontal_change
    if before_y < MIN_APPROACH_PIXELS_PER_FRAME:
        return None
    upward_acceleration = (
        before_y <= 0.0
        and vertical_turn >= MIN_VERTICAL_TURN_PIXELS_PER_FRAME
        and change_score >= MIN_CHANGE_SCORE
    )
    standard_turn = (
        before_y >= 0.0
        and vertical_turn >= MIN_STANDARD_VERTICAL_TURN_PIXELS_PER_FRAME
        and change_score >= MIN_STANDARD_CHANGE_SCORE
    )
    if not upward_acceleration and not standard_turn:
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
        before_velocity=before_velocity,
        after_velocity=after_velocity,
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
        start_window = segment[:ONE_SIDED_WINDOW_POINTS]
        end_window = segment[-ONE_SIDED_WINDOW_POINTS:]
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
            near_depth_edge = min(abs(table_y), abs(TABLE_WIDTH_CM - table_y)) <= ONE_SIDED_EDGE_BAND_CM
            if (
                near_depth_edge
                and abs(start_velocity[0]) >= MIN_ONE_SIDED_HORIZONTAL_SPEED_PIXELS_PER_FRAME
                and start_velocity[1] <= -MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME
            ):
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
            table_x, table_y = end_table
            near_depth_edge = min(abs(table_y), abs(TABLE_WIDTH_CM - table_y)) <= ONE_SIDED_EDGE_BAND_CM
            strictly_inside_table = 0.0 <= table_x <= TABLE_LENGTH_CM and 0.0 <= table_y <= TABLE_WIDTH_CM
            if (
                near_depth_edge
                and strictly_inside_table
                and abs(end_velocity[0]) >= MIN_ONE_SIDED_HORIZONTAL_SPEED_PIXELS_PER_FRAME
                and end_velocity[1] >= MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME
            ):
                candidates.append(_BounceCandidate(
                    segment[-1],
                    4.0 + abs(end_velocity[1]) + 0.05 * max(0.0, segment[-1].confidence),
                    "track-death",
                ))
    return tuple(candidates)


def _short_gap_candidates(
    points: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
    table_length_margin_cm: float,
    table_width_margin_cm: float,
) -> tuple[_BounceCandidate, ...]:
    """Recover a strong edge contact hidden by exactly three missing frames."""

    candidates: list[_BounceCandidate] = []
    segments = _visible_segments(points)
    for before_segment, after_segment in zip(segments, segments[1:]):
        missing_frames = after_segment[0].frame - before_segment[-1].frame - 1
        if missing_frames != MAX_INTERPOLATED_GAP_FRAMES + 1:
            continue
        before = before_segment[-ONE_SIDED_WINDOW_POINTS:]
        after = after_segment[:ONE_SIDED_WINDOW_POINTS]
        before_velocity = _median_velocity(before)
        after_velocity = _median_velocity(after)
        if before_velocity is None or after_velocity is None:
            continue

        before_x, before_y = before_velocity
        after_x, after_y = after_velocity
        before_speed = math.hypot(before_x, before_y)
        after_speed = math.hypot(after_x, after_y)
        if (
            before_speed < MIN_TWO_SIDED_SPEED_PIXELS_PER_FRAME
            or after_speed < MIN_TWO_SIDED_SPEED_PIXELS_PER_FRAME
            or after_y > -MIN_ONE_SIDED_SPEED_PIXELS_PER_FRAME
        ):
            continue
        direction_cosine = (before_x * after_x + before_y * after_y) / (
            before_speed * after_speed
        )
        if direction_cosine < MIN_DIRECTION_COSINE:
            continue

        vertical_turn = before_y - after_y
        horizontal_change = abs(before_x - after_x)
        change_score = vertical_turn + 0.25 * horizontal_change
        upward_acceleration = (
            before_y <= 0.0
            and vertical_turn >= MIN_VERTICAL_TURN_PIXELS_PER_FRAME
            and change_score >= MIN_CHANGE_SCORE
        )
        standard_turn = (
            before_y >= 0.0
            and vertical_turn >= MIN_STANDARD_VERTICAL_TURN_PIXELS_PER_FRAME
            and change_score >= MIN_STANDARD_CHANGE_SCORE
        )
        if not upward_acceleration and not standard_turn:
            continue

        edge_points: list[tuple[float, TrajectoryPoint]] = []
        for point in (before_segment[-1], after_segment[0]):
            table_coordinates = landing_table_coordinates(
                point, calibration, table_length_margin_cm, table_width_margin_cm,
            )
            if table_coordinates is None:
                continue
            table_x, _ = table_coordinates
            length_edge_distance = min(abs(table_x), abs(TABLE_LENGTH_CM - table_x))
            if length_edge_distance <= SHORT_GAP_LENGTH_EDGE_BAND_CM:
                edge_points.append((length_edge_distance, point))
        if not edge_points:
            continue

        _, landing = min(edge_points, key=lambda value: (value[0], -value[1].confidence))
        candidates.append(_BounceCandidate(
            landing,
            change_score + 0.05 * max(0.0, landing.confidence),
            "short-gap",
            before_velocity=before_velocity,
            after_velocity=after_velocity,
        ))
    return tuple(candidates)


def _suppress_spatial_duplicate_artifacts(
    candidates: Sequence[_BounceCandidate],
) -> list[_BounceCandidate]:
    """Drop close same-location candidates with implausible departure motion."""

    kept: list[_BounceCandidate] = []
    for candidate in sorted(candidates, key=lambda value: (value.point.time, value.point.frame)):
        nearby_previous = any(
            SPATIAL_DUPLICATE_MIN_SECONDS
            <= candidate.point.time - previous.point.time
            <= SPATIAL_DUPLICATE_WINDOW_SECONDS
            and math.hypot(
                candidate.point.x - previous.point.x,
                candidate.point.y - previous.point.y,
            ) <= SPATIAL_DUPLICATE_DISTANCE_PIXELS
            for previous in kept
        )
        if nearby_previous and candidate.after_velocity is not None and candidate.before_velocity is not None:
            before_speed = math.hypot(*candidate.before_velocity)
            after_speed = math.hypot(*candidate.after_velocity)
            downward_departure = candidate.after_velocity[1] > 0.0
            abrupt_speed_gain = (
                after_speed > before_speed * MAX_TWO_SIDED_SPEED_GAIN
                and after_speed - before_speed > MAX_TWO_SIDED_ABSOLUTE_SPEED_GAIN
            )
            if downward_departure or abrupt_speed_gain:
                continue
        kept.append(candidate)
    return kept


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
        before = _supported_suffix(before)
        after = _supported_prefix(after)
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
            _add_or_replace_candidate(candidates, candidate)
    for candidate in _one_sided_candidates(
        ordered,
        calibration,
        table_length_margin_cm,
        table_width_margin_cm,
    ):
        _add_or_replace_candidate(candidates, candidate)
    for candidate in _short_gap_candidates(
        ordered,
        calibration,
        table_length_margin_cm,
        table_width_margin_cm,
    ):
        _add_or_replace_candidate(candidates, candidate)

    duplicate_window = min(float(minimum_interval_seconds), MAX_DUPLICATE_WINDOW_SECONDS)
    selected: list[_BounceCandidate] = []
    for candidate in sorted(
        candidates.values(),
        key=lambda value: (-value.score, value.point.time, value.point.frame),
    ):
        if all(
            abs(candidate.point.time - kept.point.time) > duplicate_window
            for kept in selected
        ):
            selected.append(candidate)
    selected = _suppress_spatial_duplicate_artifacts(selected)
    return [
        candidate.point.frame
        for candidate in sorted(selected, key=lambda value: (value.point.time, value.point.frame))
    ]
