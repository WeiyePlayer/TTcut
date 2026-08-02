from __future__ import annotations

import math
from typing import Sequence

from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .types import TrajectoryPoint


DEFAULT_MINIMUM_BOUNCE_INTERVAL_SECONDS = 0.315
MAXIMUM_BRIDGED_DUAL_GAP_SECONDS = 0.1
MAXIMUM_BRIDGED_DUAL_MISSING_FRAMES = 5


def _valid_window(window: Sequence[TrajectoryPoint]) -> bool:
    first_frame = window[0].frame
    return (
        all(point.frame == first_frame + offset for offset, point in enumerate(window))
        and all(math.isfinite(point.time) for point in window)
        and all(window[index].time < window[index + 1].time for index in range(len(window) - 1))
    )


def _add_candidate(
    candidates: dict[int, TrajectoryPoint], landing: TrajectoryPoint,
    calibration: TableCalibration, length_margin: float, width_margin: float,
) -> bool:
    if landing.frame in candidates:
        return True
    table_x, table_y = calibration.image_to_table(landing.x, landing.y)
    if (
        -length_margin <= table_x <= TABLE_LENGTH_CM + length_margin
        and -width_margin <= table_y <= TABLE_WIDTH_CM + width_margin
    ):
        candidates[landing.frame] = landing
        return True
    return False


def _bridge_short_dual_gaps(
    points: Sequence[TrajectoryPoint],
) -> tuple[TrajectoryPoint, ...]:
    bridged = list(points)
    index = 0
    while index < len(points):
        if points[index].visibility:
            index += 1
            continue
        gap_start = index
        while index < len(points) and not points[index].visibility:
            index += 1
        gap_end = index - 1
        left_index = gap_start - 1
        right_index = index
        if left_index < 0 or right_index >= len(points):
            continue
        left = points[left_index]
        right = points[right_index]
        missing_count = gap_end - gap_start + 1
        elapsed = right.time - left.time
        if (
            left.source != "uplifting_dual"
            or right.source != "uplifting_dual"
            or missing_count > MAXIMUM_BRIDGED_DUAL_MISSING_FRAMES
            or elapsed <= 0
            or elapsed > MAXIMUM_BRIDGED_DUAL_GAP_SECONDS + 1e-9
            or right.frame - left.frame != missing_count + 1
        ):
            continue
        confidence = min(left.confidence, right.confidence)
        for missing_index in range(gap_start, gap_end + 1):
            missing = points[missing_index]
            ratio = (missing.time - left.time) / elapsed
            bridged[missing_index] = TrajectoryPoint(
                frame=missing.frame,
                time=missing.time,
                visibility=1,
                x=int(round(left.x + (right.x - left.x) * ratio)),
                y=int(round(left.y + (right.y - left.y) * ratio)),
                source="uplifting_dual",
                confidence=confidence,
                time_source=missing.time_source,
            )
    return tuple(bridged)


def detect_bounce_frames(
    points: Sequence[TrajectoryPoint], calibration: TableCalibration,
    *, minimum_interval_seconds: float = DEFAULT_MINIMUM_BOUNCE_INTERVAL_SECONDS,
    table_length_margin_cm: float = 35.0, table_width_margin_cm: float = 25.0,
) -> list[int]:
    points = _bridge_short_dual_gaps(points)
    candidates: dict[int, TrajectoryPoint] = {}
    index = 1
    while index < len(points) - 1:
        if not points[index].visibility:
            index += 1
            continue
        plateau_start = index
        plateau_end = index
        while (
            plateau_end + 1 < len(points)
            and points[plateau_end + 1].visibility
            and points[plateau_end + 1].y == points[plateau_start].y
        ):
            plateau_end += 1
        if plateau_end > plateau_start:
            left = plateau_start - 1
            right = plateau_end + 1
            window = points[left:right + 1]
            if (
                right < len(points)
                and points[left].visibility
                and points[right].visibility
                and _valid_window(window)
                and points[left].y < points[plateau_start].y
                and points[right].y < points[plateau_start].y
            ):
                for landing in points[plateau_start:plateau_end + 1]:
                    if _add_candidate(
                        candidates, landing, calibration,
                        table_length_margin_cm, table_width_margin_cm,
                    ):
                        break
        index = plateau_end + 1
    for start in range(max(0, len(points) - 4)):
        window = points[start:start + 5]
        if len(window) != 5 or not window[0].visibility or not window[4].visibility or not _valid_window(window):
            continue
        visible_middle = [index for index in (1, 2, 3) if window[index].visibility]
        if not visible_middle:
            continue
        landing_index = min(visible_middle, key=lambda index: (-window[index].y, abs(index - 2), index))
        landing = window[landing_index]
        if window[0].y < landing.y and window[4].y < landing.y:
            _add_candidate(candidates, landing, calibration, table_length_margin_cm, table_width_margin_cm)

    for start in range(max(0, len(points) - 2)):
        window = points[start:start + 3]
        if len(window) != 3 or any(not point.visibility for point in window) or not _valid_window(window):
            continue
        first, landing, third = window
        if first.y < landing.y and third.y < landing.y:
            _add_candidate(candidates, landing, calibration, table_length_margin_cm, table_width_margin_cm)

    bounces: list[int] = []
    last_time = -math.inf
    for landing in sorted(candidates.values(), key=lambda point: (point.time, point.frame)):
        if landing.time - last_time >= minimum_interval_seconds:
            bounces.append(landing.frame)
            last_time = landing.time
    return bounces
