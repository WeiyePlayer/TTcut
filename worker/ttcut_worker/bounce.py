from __future__ import annotations

import math
from typing import Sequence

from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .types import TrajectoryPoint


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
) -> None:
    if landing.frame in candidates:
        return
    table_x, table_y = calibration.image_to_table(landing.x, landing.y)
    if (
        -length_margin <= table_x <= TABLE_LENGTH_CM + length_margin
        and -width_margin <= table_y <= TABLE_WIDTH_CM + width_margin
    ):
        candidates[landing.frame] = landing


def detect_bounce_frames(
    points: Sequence[TrajectoryPoint], calibration: TableCalibration,
    *, minimum_interval_seconds: float = 0.12,
    table_length_margin_cm: float = 35.0, table_width_margin_cm: float = 25.0,
) -> list[int]:
    candidates: dict[int, TrajectoryPoint] = {}
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

