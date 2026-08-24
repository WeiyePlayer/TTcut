from __future__ import annotations

import math
from collections.abc import Sequence

from .types import RallySummary


REFINEMENT_EXPANSION_SECONDS = 0.75


def expanded_union_intervals(
    rallies: Sequence[RallySummary],
    duration_seconds: float,
    expansion_seconds: float = REFINEMENT_EXPANSION_SECONDS,
) -> tuple[tuple[float, float], ...]:
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("duration_seconds must be finite and positive")
    if not math.isfinite(expansion_seconds) or expansion_seconds < 0:
        raise ValueError("expansion_seconds must be finite and non-negative")
    expanded: list[tuple[float, float]] = []
    for rally in rallies:
        start = max(0.0, float(rally.start_time) - expansion_seconds)
        end = min(duration_seconds, float(rally.end_time) + expansion_seconds)
        if math.isfinite(start) and math.isfinite(end) and end >= start:
            expanded.append((start, end))
    expanded.sort(key=lambda interval: (interval[0], interval[1]))
    merged: list[list[float]] = []
    for start, end in expanded:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return tuple((start, end) for start, end in merged)


def interval_index_for_time(
    intervals: Sequence[tuple[float, float]],
    time_seconds: float,
) -> int | None:
    if not math.isfinite(time_seconds):
        return None
    for index, (start, end) in enumerate(intervals):
        if start <= time_seconds <= end:
            return index
        if time_seconds < start:
            break
    return None
