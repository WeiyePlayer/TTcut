from __future__ import annotations

import pytest

from ttcut_worker.analysis_intervals import expanded_union_intervals, interval_index_for_time
from ttcut_worker.types import RallySummary


def rally(start: float, end: float) -> RallySummary:
    return RallySummary(0, 1, start, end, 2)


def test_expands_clamps_and_unions_overlapping_or_touching_rallies():
    assert expanded_union_intervals(
        [rally(0.2, 1.0), rally(1.8, 2.0), rally(4.0, 4.2)],
        5.0,
    ) == ((0.0, 2.75), (3.25, 4.95))


def test_interval_index_uses_closed_time_boundaries():
    intervals = ((0.0, 1.0), (2.0, 3.0))
    assert interval_index_for_time(intervals, 0.0) == 0
    assert interval_index_for_time(intervals, 1.0) == 0
    assert interval_index_for_time(intervals, 1.5) is None
    assert interval_index_for_time(intervals, 3.0) == 1


def test_empty_candidate_rallies_produce_no_intervals():
    assert expanded_union_intervals([], 10.0) == ()


@pytest.mark.parametrize("duration", [0.0, -1.0])
def test_duration_must_be_positive(duration: float):
    with pytest.raises(ValueError, match="duration_seconds"):
        expanded_union_intervals([], duration)
