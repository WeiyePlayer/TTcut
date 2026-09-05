from __future__ import annotations

import math
from bisect import bisect_left, bisect_right
from dataclasses import replace
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
BLURBALL_MOTION_MINIMUM_SPEED_RATIO_PER_SECOND = 0.35
BLURBALL_MOTION_REVERSAL_RANGE_RATIO = 0.06
BLURBALL_MOTION_GAP_MINIMUM_RANGE_RATIO = 0.04
BLURBALL_MOTION_GAP_MINIMUM_SUPPORT_RATIO = 0.35
BLURBALL_MOTION_RUN_MINIMUM_SECONDS = 0.15
BLURBALL_MOTION_RUN_MINIMUM_HORIZONTAL_RANGE_RATIO = 0.05
BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS = 1.25
BLURBALL_MOTION_CLUSTER_LONG_GAP_SECONDS = 2.25
BLURBALL_MOTION_CLUSTER_MINIMUM_STATIONARY_RUN_SECONDS = 0.50
BLURBALL_MOTION_CLUSTER_BOUNDARY_CONTEXT_SECONDS = 0.25
BLURBALL_SLOW_TRANSFER_MINIMUM_SECONDS = 0.85
BLURBALL_SLOW_TRANSFER_MINIMUM_DISPLACEMENT_RATIO = 0.30
BLURBALL_SLOW_TRANSFER_MAXIMUM_SPEED_RATIO = 0.85
BLURBALL_SLOW_TRANSFER_FAST_FLIGHT_SPEED_RATIO = 1.0


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
        "motion_refinement": {
            "version": 4,
            "minimum_motion_run_seconds": BLURBALL_MOTION_RUN_MINIMUM_SECONDS,
            "minimum_horizontal_range_ratio": BLURBALL_MOTION_RUN_MINIMUM_HORIZONTAL_RANGE_RATIO,
            "minimum_speed_ratio_per_second": BLURBALL_MOTION_MINIMUM_SPEED_RATIO_PER_SECOND,
            "reversal_range_ratio": BLURBALL_MOTION_REVERSAL_RANGE_RATIO,
            "gap_minimum_motion_range_ratio": BLURBALL_MOTION_GAP_MINIMUM_RANGE_RATIO,
            "gap_minimum_motion_support_ratio": BLURBALL_MOTION_GAP_MINIMUM_SUPPORT_RATIO,
            "short_gap_seconds": BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS,
            "long_gap_seconds": BLURBALL_MOTION_CLUSTER_LONG_GAP_SECONDS,
            "stationary_run_seconds": BLURBALL_MOTION_CLUSTER_MINIMUM_STATIONARY_RUN_SECONDS,
            "boundary_context_seconds": BLURBALL_MOTION_CLUSTER_BOUNDARY_CONTEXT_SECONDS,
        },
    }


def blurball_visibility_rallies(
    points: Sequence[TrajectoryPoint],
    fps: float,
    calibration: TableCalibration,
    *,
    motion_config: VisibilityMotionConfig,
) -> tuple[VisibilityRallySummary, ...]:
    """Refine visible candidates using sustained motion, pauses and transfers.

    Missing detections are never movement evidence. All boundaries remain real
    visible source frames. A separate lead-in hint keeps observed transfers out
    of automatic padding without changing the detector or the serve boundary.
    """
    base = continuous_visibility_rallies(points, fps, motion_config=motion_config)
    if not base or motion_config.vertical_exchange_enabled:
        return base
    ordered = sorted(points, key=lambda point: point.frame)
    frames = [point.frame for point in ordered]
    # Preserve positive transfer boundaries even when the motion gate rejects
    # the candidate before the later refinement/slow-pass stages can see it.
    pass_ends: list[float] = []
    for candidate in continuous_visibility_rallies(ordered, fps):
        observed = ordered[
            bisect_left(frames, candidate.start_frame - math.ceil(fps * 0.2)):
            bisect_right(frames, candidate.end_frame)
        ]
        if _slow_transfer_runs(observed, calibration, motion_config):
            pass_ends.append(candidate.end_time)
    accepted: list[VisibilityRallySummary] = []
    for rally in base:
        segment = ordered[bisect_left(frames, rally.start_frame):bisect_right(frames, rally.end_frame)]
        if _is_inter_rally_fragment(rally, segment, calibration, motion_config):
            continue
        accepted.extend(_refine_motion_candidate(rally, segment, fps, calibration, motion_config))
    refined: list[VisibilityRallySummary] = []
    last_rejected: VisibilityRallySummary | None = None
    for rally in accepted:
        if rally.end_time - rally.start_time < 0.6:
            continue
        # Confirmation may start after a brief detector dropout. Include only
        # the small observed prefix when checking whether this is a slow pass.
        segment = ordered[bisect_left(frames, rally.start_frame - math.ceil(fps * 0.2)):bisect_right(frames, rally.end_frame)]
        if _slow_transfer_runs(segment, calibration, motion_config):
            last_rejected = rally
            continue
        # Only trim automatic padding, never move the observed rally/serve start.
        # A recent observed slow pass is positive evidence; missing frames alone
        # cannot shorten the configured lead-in.
        preceding = [point for point in ordered[
            bisect_left(frames, rally.start_frame - math.ceil(fps * 3)):bisect_left(frames, rally.start_frame)
        ] if point.time >= rally.start_time - 3 and (
            not refined or point.time > refined[-1].end_time
        )]
        transfers = _slow_transfer_runs(preceding, calibration, motion_config)
        if transfers and rally.start_time - transfers[-1][-1].time <= BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS:
            boundary = transfers[-1][-1].time + 1 / fps
            rally = replace(rally, lead_in_start_time=min(rally.start_time, boundary))
        if last_rejected is not None and 0 <= rally.start_time - last_rejected.end_time <= 3:
            # Removing a candidate also removes its overlap with the next clip.
            # Do not let the next clip's automatic padding restore that pass.
            boundary = min(rally.start_time, last_rejected.end_time + 1 / fps)
            rally = replace(rally, lead_in_start_time=max(rally.lead_in_start_time or 0, boundary))
        previous_pass = bisect_right(pass_ends, rally.start_time) - 1
        if previous_pass >= 0 and rally.start_time - pass_ends[previous_pass] <= 3:
            boundary = min(rally.start_time, pass_ends[previous_pass] + 1 / fps)
            rally = replace(rally, lead_in_start_time=max(rally.lead_in_start_time or 0, boundary))
        refined.append(rally)
    return tuple(refined)


def _transfer_observation_runs(
    visible: Sequence[TrajectoryPoint], width: float,
) -> tuple[tuple[TrajectoryPoint, ...], ...]:
    groups: list[list[TrajectoryPoint]] = []
    for run in _contiguous_visible_runs(visible):
        if (groups and run[0].time - groups[-1][-1].time <= 0.1 + 1e-9
                and abs(run[0].x - groups[-1][-1].x) <= width * 0.2
                and (run[-1].x - run[0].x) * (groups[-1][-1].x - groups[-1][0].x) >= 0):
            groups[-1].extend(run)
        else:
            groups.append(list(run))
    return tuple(tuple(group) for group in groups)


def _slow_transfer_runs(
    points: Sequence[TrajectoryPoint], calibration: TableCalibration,
    config: VisibilityMotionConfig,
) -> tuple[tuple[TrajectoryPoint, ...], ...]:
    """Positive slow-flight evidence, with sparse serves/returns protected.

    Repeated passes can reverse direction between visible runs. A reversal alone
    is therefore insufficient; genuine fast flights and observed table flights
    veto this conservative filter. Speeds use elapsed source time and ROI width.
    """
    width = config.analysis_width_pixels
    runs = [run for run in _transfer_observation_runs([
        point for point in points if point.visibility == 1
    ], width) if run[-1].time - run[0].time + 1e-9 >= 0.1]
    slow: list[tuple[TrajectoryPoint, ...]] = []
    for run in runs:
        duration = run[-1].time - run[0].time
        displacement = abs(run[-1].x - run[0].x) / width
        span = (max(point.x for point in run) - min(point.x for point in run)) / width
        if _motion_reversals(run, width):
            return ()
        if span >= 0.15 and span / duration >= BLURBALL_SLOW_TRANSFER_FAST_FLIGHT_SPEED_RATIO:
            return ()
        if displacement >= 0.30 and _table_activity_ratios(run, calibration)[1] >= 0.60:
            return ()
        sample_seconds = min((b.time - a.time for a, b in zip(run, run[1:]) if b.time > a.time), default=0)
        if (duration + sample_seconds >= BLURBALL_SLOW_TRANSFER_MINIMUM_SECONDS
                and displacement >= BLURBALL_SLOW_TRANSFER_MINIMUM_DISPLACEMENT_RATIO
                and span / duration < BLURBALL_SLOW_TRANSFER_MAXIMUM_SPEED_RATIO):
            slow.append(run)
    if slow and any(
        run[0].time - slow[-1][-1].time > BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS
        and run[-1].time - run[0].time >= BLURBALL_MOTION_RUN_MINIMUM_SECONDS
        and max(point.x for point in run) - min(point.x for point in run) >= width * 0.15
        for run in runs
    ):
        # A pass followed by a separate serve/exchange is a mixed candidate,
        # not a reason to delete the entire interval.
        return ()
    if len(slow) == 1:
        flight = slow[0]
        # A slow serve followed immediately by a shorter opposite flight is
        # still an exchange even if neither flight meets the fast-flight gate.
        if any(
            0 <= run[0].time - flight[-1].time <= 0.5
            and run[-1].time - run[0].time <= 0.75
            and abs(run[-1].x - run[0].x) >= width * 0.30
            and (run[-1].x - run[0].x) * (flight[-1].x - flight[0].x) < 0
            for run in runs
        ):
            return ()
    return tuple(slow)


def _trim_slow_run_tail(
    run: Sequence[TrajectoryPoint], fps: float, config: VisibilityMotionConfig,
) -> tuple[tuple[TrajectoryPoint, ...], bool]:
    if run[-1].time - run[0].time < 0.5:
        return tuple(run), False
    xs = _median_smooth([point.x for point in run])
    ys = _median_smooth([point.y for point in run])
    step = max(1, round(fps * 0.1))
    active: list[int] = []
    for index in range(len(run) - step):
        elapsed = run[index + step].time - run[index].time
        speed = math.hypot(
            (xs[index + step] - xs[index]) / config.analysis_width_pixels,
            (ys[index + step] - ys[index]) / config.analysis_height_pixels,
        ) / elapsed
        if speed >= BLURBALL_MOTION_MINIMUM_SPEED_RATIO_PER_SECOND:
            active.extend((index, index + step))
    if not active:
        return tuple(run), False
    context = round(fps * 0.1)
    start = max(0, min(active) - context)
    end = min(len(run) - 1, max(active) + context)
    trimmed_tail = run[-1].time - run[end].time >= 0.4
    return tuple(run[start:end + 1]), trimmed_tail


def _motion_reversals(run: Sequence[TrajectoryPoint], width: float) -> int:
    return _significant_reversals(
        _median_smooth([point.x for point in run]),
        width * BLURBALL_MOTION_REVERSAL_RANGE_RATIO,
    )


def _motion_runs_have_rally_break(
    previous: Sequence[TrajectoryPoint], current: Sequence[TrajectoryPoint],
    points: Sequence[TrajectoryPoint], frames: Sequence[int], width: float,
    height: float | None = None,
) -> bool:
    height = height or width
    elapsed = current[0].time - previous[-1].time
    if elapsed < BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS:
        return False
    gap = points[bisect_right(frames, previous[-1].frame):bisect_left(frames, current[0].frame)]
    runs = _contiguous_visible_runs([point for point in gap if point.visibility == 1])
    moving = [run for run in runs if (
        run[-1].time - run[0].time >= BLURBALL_MOTION_RUN_MINIMUM_SECONDS
        and max(point.x for point in run) - min(point.x for point in run)
        >= width * BLURBALL_MOTION_GAP_MINIMUM_RANGE_RATIO
    )]
    support = sum(run[-1].time - run[0].time for run in moving) / elapsed
    if len(moving) >= 3 and support >= BLURBALL_MOTION_GAP_MINIMUM_SUPPORT_RATIO:
        return False
    # A visible ball is not necessarily stationary. Check movement before using
    # a held-ball interval as a break; sparse occlusions alone remain bridgeable.
    stationary = any(
        run[-1].time - run[0].time >= BLURBALL_MOTION_CLUSTER_MINIMUM_STATIONARY_RUN_SECONDS
        and max(point.x for point in run) - min(point.x for point in run)
        < width * BLURBALL_MOTION_GAP_MINIMUM_RANGE_RATIO
        and max(point.y for point in run) - min(point.y for point in run)
        < height * BLURBALL_MOTION_GAP_MINIMUM_RANGE_RATIO
        for run in runs
    )
    # A side-on rally can temporarily move mostly vertically in screen space.
    # Repeated observed flights support continuity across that short interval.
    vertical = [run for run in runs if (
        run[-1].time - run[0].time + 1e-9 >= 0.1
        and max(point.y for point in run) - min(point.y for point in run) >= height * 0.15
    )]
    if (not stationary and elapsed <= 3.0 and len(vertical) >= 2
            and sum(run[-1].time - run[0].time for run in vertical) / elapsed >= 0.15):
        return False
    return elapsed >= BLURBALL_MOTION_CLUSTER_LONG_GAP_SECONDS or stationary


def _has_rhythmic_exchange(runs: Sequence[Sequence[TrajectoryPoint]], width: float) -> bool:
    for run in runs:
        reversals = _motion_reversals(run, width)
        if reversals and (run[-1].time - run[0].time) / (reversals + 1) <= 1.0:
            return True
    directions = [
        run[-1].x - run[0].x for run in runs
        if abs(run[-1].x - run[0].x) >= width * 0.08
        and run[-1].time - run[0].time <= 1.0
    ]
    return any(first * second < 0 for first, second in zip(directions, directions[1:]))


def _refine_motion_candidate(
    rally: VisibilityRallySummary, points: Sequence[TrajectoryPoint], fps: float,
    calibration: TableCalibration, config: VisibilityMotionConfig,
) -> tuple[VisibilityRallySummary, ...]:
    width = config.analysis_width_pixels
    visible = [point for point in points if point.visibility == 1]
    evidence: list[tuple[TrajectoryPoint, ...]] = []
    transfers: list[tuple[TrajectoryPoint, ...]] = []
    for original in _contiguous_visible_runs(visible):
        run, trimmed_tail = _trim_slow_run_tail(original, fps, config)
        if trimmed_tail:
            transfers.append(tuple(point for point in original if point.frame >= run[-1].frame))
        duration = run[-1].time - run[0].time
        span = max(point.x for point in run) - min(point.x for point in run)
        if duration < BLURBALL_MOTION_RUN_MINIMUM_SECONDS or span < width * BLURBALL_MOTION_RUN_MINIMUM_HORIZONTAL_RANGE_RATIO:
            continue
        strict, _ = _table_activity_ratios(run, calibration)
        if duration >= 1.0 and strict >= 0.90 and _motion_reversals(run, width) == 0:
            transfers.append(run)
        else:
            evidence.append(run)
    if not evidence:
        # Long, partially observed rallies need more than lack of large motion
        # to reject them. Short candidates consisting of static detections and
        # disconnected jumps have no sustained flight evidence.
        short_flights = [run for run in _contiguous_visible_runs(visible) if (
            run[-1].time - run[0].time + 1e-9 >= 0.1
            and max(point.x for point in run) - min(point.x for point in run) >= width * 0.08
        )]
        vertical_flight = any(
            run[-1].time - run[0].time >= BLURBALL_MOTION_RUN_MINIMUM_SECONDS
            and max(point.y for point in run) - min(point.y for point in run)
            >= config.analysis_height_pixels * 0.15
            for run in _contiguous_visible_runs(visible)
        )
        table_flight = any(_table_activity_ratios(run, calibration)[1] >= 0.6 for run in short_flights)
        return (rally,) if (
            rally.end_time - rally.start_time > 3.0 or len(short_flights) >= 2
            or vertical_flight or table_flight
        ) else ()

    strong = [run for run in evidence if (
        max(point.x for point in run) - min(point.x for point in run) >= width * 0.15
    )]
    isolated: list[tuple[TrajectoryPoint, ...]] = []
    for index, run in enumerate(strong):
        before = run[0].time - strong[index - 1][-1].time if index else math.inf
        after = strong[index + 1][0].time - run[-1].time if index + 1 < len(strong) else math.inf
        if (len(strong) > 1 and _motion_reversals(run, width) == 0
                and before >= 1.5 and after >= 1.5):
            observed_prefix = [point for point in points
                               if run[0].time - 0.2 <= point.time <= run[-1].time]
            # Trimming slow edge samples must not make an observed pass appear
            # too short to separate from the following serve.
            if run[-1].time - run[0].time >= 0.9 or _slow_transfer_runs(observed_prefix, calibration, config):
                isolated.append(run)
    if isolated:
        evidence = [run for run in evidence if not any(
            transfer[0].time - 0.25 <= run[0].time and run[-1].time <= transfer[-1].time + 0.25
            for transfer in isolated
        )]
        transfers.extend(isolated)
    if not evidence:
        return ()

    frames = [point.frame for point in points]
    groups: list[list[tuple[TrajectoryPoint, ...]]] = []
    for run in evidence:
        if not groups or _motion_runs_have_rally_break(
            groups[-1][-1], run, points, frames, width, config.analysis_height_pixels,
        ):
            groups.append([run])
        else:
            groups[-1].append(run)
    if len(groups) == 1 and not transfers and rally.end_time - rally.start_time < 5.0:
        # Missing tail detections do not establish an idle/transfer boundary.
        # Preserve the validated visibility interval when there is no positive
        # reason to split it or remove a slow/isolated flight.
        return (rally,)
    accepted: list[VisibilityRallySummary] = []
    context = round(fps * BLURBALL_MOTION_CLUSTER_BOUNDARY_CONTEXT_SECONDS)
    for index, group in enumerate(groups):
        first, last = group[0][0], group[-1][-1]
        # Short exchanges may contain only one detected fast flight. Include
        # neighboring short runs, which were too brief to form a motion group.
        nearby_runs = _contiguous_visible_runs([
            point for point in visible if first.time - 0.5 <= point.time <= last.time + 0.25
        ])
        fast_short_flight = last.time - first.time < 1.5 and any(
            (max(point.x for point in run) - min(point.x for point in run))
            / width / (run[-1].time - run[0].time) >= 0.9
            for run in nearby_runs
            if run[-1].time - run[0].time + 1e-9 >= 0.1
        )
        if len(groups) > 1 and not fast_short_flight and not _has_rhythmic_exchange(group, width):
            continue
        start = max(rally.start_frame, first.frame - context)
        end = min(rally.end_frame, last.frame + context)
        if index == 0 and first.time - rally.start_time < BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS:
            start = rally.start_frame
        if (index == len(groups) - 1
                and rally.end_time - last.time < BLURBALL_MOTION_CLUSTER_SHORT_GAP_SECONDS
                and not any(run[0].time >= last.time for run in transfers)):
            end = rally.end_frame
        segment = points[bisect_left(frames, start):bisect_right(frames, end)]
        observed = [point for point in segment if point.visibility == 1]
        if not observed or observed[-1].time - observed[0].time < 0.6:
            continue
        candidate = VisibilityRallySummary(
            observed[0].frame, observed[-1].frame, observed[0].time, observed[-1].time,
        )
        if _is_ball_exchange(segment, fps, config) and not _is_inter_rally_fragment(candidate, segment, calibration, config):
            accepted.append(candidate)
    sparse_groups = len(groups) > 1 and all(
        group[-1][-1].time - group[0][0].time < 0.6 for group in groups
    )
    if not accepted and not transfers and (
        rally.end_time - rally.start_time < 4.0 or sparse_groups
    ):
        # Do not erase an already validated rally because its sparse motion
        # samples cannot independently establish new start/end boundaries.
        return (rally,)
    return tuple(accepted)


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
