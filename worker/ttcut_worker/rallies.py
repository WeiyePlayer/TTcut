from __future__ import annotations

import math
from typing import Sequence

from .types import RallySummary, TrajectoryPoint

RALLY_MAX_GAP_SECONDS = 3.0


def group_rallies(
    bounce_frames: Sequence[int], points: Sequence[TrajectoryPoint],
    maximum_gap_seconds: float = RALLY_MAX_GAP_SECONDS,
) -> tuple[RallySummary, ...]:
    if not math.isfinite(maximum_gap_seconds) or maximum_gap_seconds < 0:
        raise ValueError("maximum_gap_seconds must be finite and non-negative")
    by_frame = {point.frame: point for point in points}
    bounces = sorted(
        {frame: by_frame[frame] for frame in bounce_frames if frame in by_frame}.values(),
        key=lambda point: (point.time, point.frame),
    )
    groups: list[list[TrajectoryPoint]] = []
    current: list[TrajectoryPoint] = []
    for bounce in bounces:
        if current and bounce.time - current[-1].time > maximum_gap_seconds:
            if len(current) >= 2:
                groups.append(current)
            current = []
        current.append(bounce)
    if len(current) >= 2:
        groups.append(current)
    return tuple(
        RallySummary(
            start_frame=group[0].frame,
            end_frame=group[-1].frame,
            start_time=group[0].time,
            end_time=group[-1].time,
            bounce_count=len(group),
        )
        for group in groups
    )

