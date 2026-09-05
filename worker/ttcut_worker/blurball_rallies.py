from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Sequence

from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .types import TrajectoryPoint
from .visibility_rallies import (
    VisibilityMotionConfig,
    VisibilityRallySummary,
    _is_ball_exchange,
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
BLURBALL_LONG_CANDIDATE_MINIMUM_SECONDS = 10.0
BLURBALL_MOTION_RUN_MINIMUM_SECONDS = 0.15
BLURBALL_MOTION_RUN_MINIMUM_HORIZONTAL_RANGE_RATIO = 0.15
BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS = 1.25
BLURBALL_MOTION_CLUSTER_LONG_GAP_SECONDS = 2.25
BLURBALL_MOTION_CLUSTER_MINIMUM_VISIBLE_GAP_RATIO = 0.36
BLURBALL_MOTION_CLUSTER_MINIMUM_STATIONARY_RUN_SECONDS = 0.50
BLURBALL_MOTION_CLUSTER_BOUNDARY_CONTEXT_SECONDS = 0.25
BLURBALL_LEADING_PASS_MINIMUM_MOTION_SECONDS = 2.50
BLURBALL_LEADING_PASS_MINIMUM_RUN_COUNT = 3
BLURBALL_LEADING_PASS_MAXIMUM_EXPANDED_TABLE_RATIO = 0.36
BLURBALL_INTERNAL_TRANSFER_MINIMUM_MOTION_SECONDS = 1.0
BLURBALL_INTERNAL_TRANSFER_MINIMUM_STRICT_TABLE_RATIO = 0.90


@dataclass(frozen=True)
class _MotionCluster:
    rally: VisibilityRallySummary
    evidence_run_count: int
    evidence_duration: float
    segmented: bool


def blurball_inter_rally_filter_provenance() -> dict[str, object]:
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
        "long_candidate_segmentation": {
            "minimum_candidate_seconds": BLURBALL_LONG_CANDIDATE_MINIMUM_SECONDS,
            "minimum_motion_run_seconds": BLURBALL_MOTION_RUN_MINIMUM_SECONDS,
            "minimum_motion_run_horizontal_range_ratio": (
                BLURBALL_MOTION_RUN_MINIMUM_HORIZONTAL_RANGE_RATIO
            ),
            "short_gap_seconds": BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS,
            "long_gap_seconds": BLURBALL_MOTION_CLUSTER_LONG_GAP_SECONDS,
            "minimum_visible_gap_ratio": (
                BLURBALL_MOTION_CLUSTER_MINIMUM_VISIBLE_GAP_RATIO
            ),
            "minimum_stationary_run_seconds": (
                BLURBALL_MOTION_CLUSTER_MINIMUM_STATIONARY_RUN_SECONDS
            ),
            "boundary_context_seconds": (
                BLURBALL_MOTION_CLUSTER_BOUNDARY_CONTEXT_SECONDS
            ),
            "leading_pass_minimum_motion_seconds": (
                BLURBALL_LEADING_PASS_MINIMUM_MOTION_SECONDS
            ),
            "leading_pass_minimum_run_count": (
                BLURBALL_LEADING_PASS_MINIMUM_RUN_COUNT
            ),
            "leading_pass_maximum_expanded_table_ratio": (
                BLURBALL_LEADING_PASS_MAXIMUM_EXPANDED_TABLE_RATIO
            ),
            "internal_transfer_minimum_motion_seconds": (
                BLURBALL_INTERNAL_TRANSFER_MINIMUM_MOTION_SECONDS
            ),
            "internal_transfer_minimum_strict_table_ratio": (
                BLURBALL_INTERNAL_TRANSFER_MINIMUM_STRICT_TABLE_RATIO
            ),
        },
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
        clusters = _long_candidate_motion_clusters(
            rally,
            segment,
            fps,
            motion_config.analysis_width_pixels,
        )
        for cluster_index, cluster in enumerate(clusters):
            candidate = cluster.rally
            candidate_segment = ordered[
                bisect_left(frames, candidate.start_frame):
                bisect_right(frames, candidate.end_frame)
            ]
            if cluster.segmented and not _is_ball_exchange(
                candidate_segment,
                fps,
                motion_config,
            ):
                continue
            if cluster.segmented and _is_long_candidate_pass_fragment(
                cluster,
                cluster_index,
                len(clusters),
                candidate_segment,
                calibration,
                motion_config,
            ):
                continue
            if not _is_inter_rally_fragment(
                candidate,
                candidate_segment,
                calibration,
                motion_config,
            ):
                accepted.append(candidate)
    return tuple(accepted)


def _long_candidate_motion_clusters(
    rally: VisibilityRallySummary,
    points: Sequence[TrajectoryPoint],
    fps: float,
    analysis_width_pixels: float,
) -> tuple[_MotionCluster, ...]:
    duration = rally.end_time - rally.start_time
    original = _MotionCluster(rally, 0, duration, False)
    if duration + 1e-9 < BLURBALL_LONG_CANDIDATE_MINIMUM_SECONDS:
        return (original,)

    visible = [point for point in points if point.visibility == 1]
    evidence = [
        run
        for run in _contiguous_visible_runs(visible)
        if (
            run[-1].time - run[0].time + 1e-9
            >= BLURBALL_MOTION_RUN_MINIMUM_SECONDS
            and max(point.x for point in run) - min(point.x for point in run) + 1e-9
            >= (
                analysis_width_pixels
                * BLURBALL_MOTION_RUN_MINIMUM_HORIZONTAL_RANGE_RATIO
            )
        )
    ]
    if not evidence:
        return (original,)

    ordered = sorted(points, key=lambda point: point.frame)
    frames = [point.frame for point in ordered]
    grouped: list[list[tuple[TrajectoryPoint, ...]]] = []
    for run in evidence:
        if not grouped or _motion_runs_have_rally_break(
            grouped[-1][-1],
            run,
            ordered,
            frames,
        ):
            grouped.append([run])
        else:
            grouped[-1].append(run)

    context_frames = math.ceil(
        fps * BLURBALL_MOTION_CLUSTER_BOUNDARY_CONTEXT_SECONDS
    )
    clusters: list[_MotionCluster] = []
    for group in grouped:
        start_frame = max(rally.start_frame, group[0][0].frame - context_frames)
        end_frame = min(rally.end_frame, group[-1][-1].frame + context_frames)
        candidate_points = ordered[
            bisect_left(frames, start_frame):bisect_right(frames, end_frame)
        ]
        candidate_visible = [
            point for point in candidate_points if point.visibility == 1
        ]
        if len(candidate_visible) < 2:
            continue
        clusters.append(_MotionCluster(
            rally=VisibilityRallySummary(
                start_frame=candidate_visible[0].frame,
                end_frame=candidate_visible[-1].frame,
                start_time=candidate_visible[0].time,
                end_time=candidate_visible[-1].time,
            ),
            evidence_run_count=len(group),
            evidence_duration=group[-1][-1].time - group[0][0].time,
            segmented=True,
        ))
    return tuple(clusters) or (original,)


def _motion_runs_have_rally_break(
    previous: Sequence[TrajectoryPoint],
    current: Sequence[TrajectoryPoint],
    points: Sequence[TrajectoryPoint],
    frames: Sequence[int],
) -> bool:
    gap_seconds = current[0].time - previous[-1].time
    if gap_seconds + 1e-9 >= BLURBALL_MOTION_CLUSTER_LONG_GAP_SECONDS:
        return True
    if gap_seconds + 1e-9 < BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS:
        return False

    gap = points[
        bisect_right(frames, previous[-1].frame):
        bisect_left(frames, current[0].frame)
    ]
    frame_span = current[0].frame - previous[-1].frame - 1
    visible = [point for point in gap if point.visibility == 1]
    visibility_ratio = len(visible) / frame_span if frame_span > 0 else 0.0
    longest_visible_run_seconds = max(
        (run[-1].time - run[0].time for run in _contiguous_visible_runs(visible)),
        default=0.0,
    )
    return (
        visibility_ratio + 1e-9
        >= BLURBALL_MOTION_CLUSTER_MINIMUM_VISIBLE_GAP_RATIO
        or longest_visible_run_seconds + 1e-9
        >= BLURBALL_MOTION_CLUSTER_MINIMUM_STATIONARY_RUN_SECONDS
    )


def _is_long_candidate_pass_fragment(
    cluster: _MotionCluster,
    cluster_index: int,
    cluster_count: int,
    points: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
    motion_config: VisibilityMotionConfig,
) -> bool:
    visible = [point for point in points if point.visibility == 1]
    if not visible or cluster_count < 2:
        return False

    strict_table_ratio, expanded_table_ratio = _table_activity_ratios(
        visible,
        calibration,
    )
    coherent_exchange = _has_coherent_horizontal_exchange(
        _contiguous_visible_runs(visible),
        motion_config.analysis_width_pixels,
    )
    leading_pass = (
        cluster_index == 0
        and cluster.evidence_run_count
        >= BLURBALL_LEADING_PASS_MINIMUM_RUN_COUNT
        and cluster.evidence_duration + 1e-9
        >= BLURBALL_LEADING_PASS_MINIMUM_MOTION_SECONDS
        and expanded_table_ratio
        < BLURBALL_LEADING_PASS_MAXIMUM_EXPANDED_TABLE_RATIO
    )
    internal_table_transfer = (
        0 < cluster_index < cluster_count - 1
        and cluster.evidence_run_count == 1
        and cluster.evidence_duration + 1e-9
        >= BLURBALL_INTERNAL_TRANSFER_MINIMUM_MOTION_SECONDS
        and strict_table_ratio + 1e-9
        >= BLURBALL_INTERNAL_TRANSFER_MINIMUM_STRICT_TABLE_RATIO
        and not coherent_exchange
    )
    return leading_pass or internal_table_transfer


def _table_activity_ratios(
    visible: Sequence[TrajectoryPoint],
    calibration: TableCalibration,
) -> tuple[float, float]:
    coordinates = [
        calibration.image_to_table(point.x, point.y) for point in visible
    ]
    strict = sum(
        0 <= table_x <= TABLE_LENGTH_CM and 0 <= table_y <= TABLE_WIDTH_CM
        for table_x, table_y in coordinates
    ) / len(visible)
    expanded = sum(
        -BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_LENGTH_MARGIN_CM
        <= table_x
        <= TABLE_LENGTH_CM + BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_LENGTH_MARGIN_CM
        and -BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_WIDTH_MARGIN_CM
        <= table_y
        <= TABLE_WIDTH_CM + BLURBALL_INTER_RALLY_FILTER_EXPANDED_TABLE_WIDTH_MARGIN_CM
        for table_x, table_y in coordinates
    ) / len(visible)
    return strict, expanded


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
