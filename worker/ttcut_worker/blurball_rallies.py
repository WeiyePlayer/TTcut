from __future__ import annotations

from bisect import bisect_left, bisect_right
from typing import Sequence

from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .types import TrajectoryPoint
from .visibility_rallies import (
    VisibilityMotionConfig,
    VisibilityRallySummary,
    _median_smooth,
    _significant_reversals,
    continuous_visibility_rallies,
)


BLURBALL_INTER_RALLY_FILTER_MINIMUM_CANDIDATE_SECONDS = 1.0
BLURBALL_INTER_RALLY_FILTER_MAXIMUM_CANDIDATE_SECONDS = 6.0
BLURBALL_INTER_RALLY_FILTER_MAXIMUM_EXPANDED_TABLE_RATIO = 0.45
BLURBALL_INTER_RALLY_FILTER_MINIMUM_VISIBLE_RUN_COUNT = 3
BLURBALL_INTER_RALLY_FILTER_MINIMUM_ONE_WAY_RANGE_RATIO = 0.55
BLURBALL_INTER_RALLY_FILTER_MAXIMUM_SPARSE_VISIBILITY_RATIO = 0.30
BLURBALL_INTER_RALLY_FILTER_MINIMUM_CONTIGUOUS_FLIGHT_SECONDS = 0.15
BLURBALL_INTER_RALLY_FILTER_MINIMUM_COHERENT_REVERSAL_RATIO = 0.20
BLURBALL_INTER_RALLY_FILTER_MINIMUM_COHERENT_FLIGHT_DISPLACEMENT_RATIO = 0.15
BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_LENGTH_MARGIN_CM = 35.0
BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_WIDTH_MARGIN_CM = 25.0


def blurball_inter_rally_filter_provenance() -> dict[str, float | int | bool]:
    return {
        "side_on_views_only": True,
        "minimum_candidate_seconds": BLURBALL_INTER_RALLY_FILTER_MINIMUM_CANDIDATE_SECONDS,
        "maximum_candidate_seconds": BLURBALL_INTER_RALLY_FILTER_MAXIMUM_CANDIDATE_SECONDS,
        "maximum_expanded_table_ratio": (
            BLURBALL_INTER_RALLY_FILTER_MAXIMUM_EXPANDED_TABLE_RATIO
        ),
        "minimum_visible_run_count": BLURBALL_INTER_RALLY_FILTER_MINIMUM_VISIBLE_RUN_COUNT,
        "minimum_one_way_range_ratio": BLURBALL_INTER_RALLY_FILTER_MINIMUM_ONE_WAY_RANGE_RATIO,
        "maximum_sparse_visibility_ratio": (
            BLURBALL_INTER_RALLY_FILTER_MAXIMUM_SPARSE_VISIBILITY_RATIO
        ),
        "minimum_contiguous_flight_seconds": (
            BLURBALL_INTER_RALLY_FILTER_MINIMUM_CONTIGUOUS_FLIGHT_SECONDS
        ),
        "minimum_coherent_reversal_ratio": (
            BLURBALL_INTER_RALLY_FILTER_MINIMUM_COHERENT_REVERSAL_RATIO
        ),
        "minimum_coherent_flight_displacement_ratio": (
            BLURBALL_INTER_RALLY_FILTER_MINIMUM_COHERENT_FLIGHT_DISPLACEMENT_RATIO
        ),
        "expanded_table_length_margin_cm": (
            BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_LENGTH_MARGIN_CM
        ),
        "expanded_table_width_margin_cm": (
            BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_WIDTH_MARGIN_CM
        ),
    }


def blurball_visibility_rallies(
    points: Sequence[TrajectoryPoint],
    fps: float,
    calibration: TableCalibration,
    *,
    motion_config: VisibilityMotionConfig,
) -> tuple[VisibilityRallySummary, ...]:
    """Apply a conservative BlurBall inter-rally-fragment filter."""

    base = continuous_visibility_rallies(points, fps, motion_config=motion_config)
    if not base or motion_config.vertical_exchange_enabled:
        return base

    ordered = sorted(points, key=lambda point: point.frame)
    frames = [point.frame for point in ordered]
    accepted: list[VisibilityRallySummary] = []
    for rally in base:
        segment = ordered[
            bisect_left(frames, rally.start_frame):bisect_right(frames, rally.end_frame)
        ]
        if not _is_inter_rally_fragment(rally, segment, calibration, motion_config):
            accepted.append(rally)
    return tuple(accepted)


def _is_inter_rally_fragment(
    rally: VisibilityRallySummary,
    points: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
    motion_config: VisibilityMotionConfig,
) -> bool:
    duration = rally.end_time - rally.start_time
    if (
        duration + 1e-9 < BLURBALL_INTER_RALLY_FILTER_MINIMUM_CANDIDATE_SECONDS
        or duration - 1e-9 > BLURBALL_INTER_RALLY_FILTER_MAXIMUM_CANDIDATE_SECONDS
    ):
        return False

    visible = [point for point in points if point.visibility == 1]
    if not visible:
        return False
    runs = _contiguous_visible_runs(visible)
    if len(runs) < BLURBALL_INTER_RALLY_FILTER_MINIMUM_VISIBLE_RUN_COUNT:
        return False

    expanded_table_points = sum(
        -BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_LENGTH_MARGIN_CM
        <= table_x
        <= TABLE_LENGTH_CM + BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_LENGTH_MARGIN_CM
        and -BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_WIDTH_MARGIN_CM
        <= table_y
        <= TABLE_WIDTH_CM + BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_WIDTH_MARGIN_CM
        for table_x, table_y in (
            calibration.image_to_table(point.x, point.y) for point in visible
        )
    )
    expanded_table_ratio = expanded_table_points / len(visible)
    if expanded_table_ratio >= BLURBALL_INTER_RALLY_FILTER_MAXIMUM_EXPANDED_TABLE_RATIO:
        return False

    if _has_coherent_horizontal_exchange(runs, motion_config.analysis_width_pixels):
        return False

    maximum_contiguous_range_ratio = max(
        (
            (max(point.x for point in run) - min(point.x for point in run))
            / motion_config.analysis_width_pixels
            for run in runs
            if run[-1].time - run[0].time + 1e-9
            >= BLURBALL_INTER_RALLY_FILTER_MINIMUM_CONTIGUOUS_FLIGHT_SECONDS
        ),
        default=0.0,
    )
    visibility_ratio = len(visible) / (visible[-1].frame - visible[0].frame + 1)
    return (
        maximum_contiguous_range_ratio + 1e-9
        >= BLURBALL_INTER_RALLY_FILTER_MINIMUM_ONE_WAY_RANGE_RATIO
        or visibility_ratio < BLURBALL_INTER_RALLY_FILTER_MAXIMUM_SPARSE_VISIBILITY_RATIO
    )


def _contiguous_visible_runs(
    visible: Sequence[TrajectoryPoint],
) -> tuple[tuple[TrajectoryPoint, ...], ...]:
    if not visible:
        return ()
    runs: list[tuple[TrajectoryPoint, ...]] = []
    start = 0
    for index in range(1, len(visible) + 1):
        if index == len(visible) or visible[index].frame != visible[index - 1].frame + 1:
            runs.append(tuple(visible[start:index]))
            start = index
    return tuple(runs)


def _has_coherent_horizontal_exchange(
    runs: Sequence[Sequence[TrajectoryPoint]],
    analysis_width_pixels: float,
) -> bool:
    reversal_excursion = (
        analysis_width_pixels
        * BLURBALL_INTER_RALLY_FILTER_MINIMUM_COHERENT_REVERSAL_RATIO
    )
    if any(
        _significant_reversals(
            _median_smooth([float(point.x) for point in run]),
            reversal_excursion,
        )
        >= 1
        for run in runs
    ):
        return True

    directions: list[int] = []
    for run in runs:
        duration = run[-1].time - run[0].time
        displacement = float(run[-1].x - run[0].x)
        if (
            duration + 1e-9
            >= BLURBALL_INTER_RALLY_FILTER_MINIMUM_CONTIGUOUS_FLIGHT_SECONDS
            and abs(displacement) + 1e-9
            >= analysis_width_pixels
            * BLURBALL_INTER_RALLY_FILTER_MINIMUM_COHERENT_FLIGHT_DISPLACEMENT_RATIO
        ):
            directions.append(1 if displacement > 0 else -1)
    return any(first != second for first, second in zip(directions, directions[1:]))
