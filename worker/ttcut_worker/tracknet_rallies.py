from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from typing import Sequence

from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .types import TrajectoryPoint
from .visibility_rallies import (
    CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS,
    CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
    VisibilityMotionConfig,
    VisibilityRallySummary,
    _run_reversals,
    continuous_visibility_rallies,
)


TRACKNET_MINIMUM_RALLY_SECONDS = 0.90
TRACKNET_SHORT_RALLY_SECONDS = 2.0
TRACKNET_MINIMUM_SHORT_RALLY_EXPANDED_TABLE_RATIO = 0.25
TRACKNET_EXPANDED_TABLE_LENGTH_MARGIN_CM = 35.0
TRACKNET_EXPANDED_TABLE_WIDTH_MARGIN_CM = 25.0
TRACKNET_RELIABLE_FRAGMENT_BRIDGE_SECONDS = 0.75
TRACKNET_MINIMUM_HORIZONTAL_RUN_REVERSALS = 1


def tracknet_visibility_rallies(
    points: Sequence[TrajectoryPoint],
    fps: float,
    calibration: TableCalibration,
    *,
    motion_config: VisibilityMotionConfig,
) -> tuple[VisibilityRallySummary, ...]:
    """Apply TrackNet-specific reliability checks to the shared visibility state machine."""

    base = continuous_visibility_rallies(points, fps, motion_config=motion_config)
    if not base:
        return ()
    ordered = sorted(points, key=lambda point: point.frame)
    frames = [point.frame for point in ordered]
    reliable: list[VisibilityRallySummary] = []
    maximum_missing_frames = math.floor(fps * CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS)
    horizontal_excursion = (
        motion_config.analysis_width_pixels * CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO
    )

    for rally in base:
        duration = rally.end_time - rally.start_time
        if duration + 1e-9 < TRACKNET_MINIMUM_RALLY_SECONDS:
            continue
        segment = ordered[
            bisect_left(frames, rally.start_frame):bisect_right(frames, rally.end_frame)
        ]
        visible = [point for point in segment if point.visibility == 1]
        if not visible:
            continue
        horizontal_run_reversals = _run_reversals(
            [float(point.x) for point in visible],
            [point.frame for point in visible],
            horizontal_excursion,
            maximum_missing_frames,
        )
        if horizontal_run_reversals < TRACKNET_MINIMUM_HORIZONTAL_RUN_REVERSALS:
            continue
        if duration < TRACKNET_SHORT_RALLY_SECONDS:
            expanded_table_points = sum(
                -TRACKNET_EXPANDED_TABLE_LENGTH_MARGIN_CM <= table_x
                <= TABLE_LENGTH_CM + TRACKNET_EXPANDED_TABLE_LENGTH_MARGIN_CM
                and -TRACKNET_EXPANDED_TABLE_WIDTH_MARGIN_CM <= table_y
                <= TABLE_WIDTH_CM + TRACKNET_EXPANDED_TABLE_WIDTH_MARGIN_CM
                for table_x, table_y in (
                    calibration.image_to_table(point.x, point.y) for point in visible
                )
            )
            if (
                expanded_table_points / len(visible)
                < TRACKNET_MINIMUM_SHORT_RALLY_EXPANDED_TABLE_RATIO
            ):
                continue
        reliable.append(rally)

    merged: list[VisibilityRallySummary] = []
    for rally in reliable:
        if (
            merged
            and 0 < rally.start_time - merged[-1].end_time
            <= TRACKNET_RELIABLE_FRAGMENT_BRIDGE_SECONDS
        ):
            previous = merged[-1]
            merged[-1] = VisibilityRallySummary(
                start_frame=previous.start_frame,
                end_frame=rally.end_frame,
                start_time=previous.start_time,
                end_time=rally.end_time,
            )
        else:
            merged.append(rally)
    return tuple(merged)
