from __future__ import annotations

import json
from pathlib import Path

import pytest

from ttcut_worker.blurball_rallies import (
    _is_inter_rally_fragment,
    blurball_visibility_rallies,
)
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig, VisibilityRallySummary


FPS = 10.0
MOTION_CONFIG = VisibilityMotionConfig(analysis_width_pixels=200, analysis_height_pixels=100)


class StubCalibration:
    def __init__(self, *, inside_table: bool = False, fail_if_used: bool = False):
        self.inside_table = inside_table
        self.fail_if_used = fail_if_used

    def image_to_table(self, x: float, y: float) -> tuple[float, float]:
        if self.fail_if_used:
            raise AssertionError("table projection must not be used")
        return (100.0, 70.0) if self.inside_table else (400.0, 250.0)


def points(xs: list[int | None]) -> list[TrajectoryPoint]:
    return [
        TrajectoryPoint(
            frame=frame,
            time=frame / FPS,
            visibility=0 if x is None else 1,
            x=0 if x is None else x,
            y=20,
            source="missing" if x is None else "blurball",
            confidence=0.0 if x is None else 1.0,
        )
        for frame, x in enumerate(xs)
    ]


def summary(values: list[TrajectoryPoint]) -> VisibilityRallySummary:
    return VisibilityRallySummary(
        start_frame=values[0].frame,
        end_frame=values[-1].frame,
        start_time=values[0].time,
        end_time=values[-1].time,
    )


def one_way_fragment() -> list[TrajectoryPoint]:
    return points([
        0, 20, 40, 60, 80, 100, 120,
        None,
        130, 135, 140,
        None,
        145, 148, 150,
    ])


def test_blurball_filter_rejects_fragmented_one_way_pass() -> None:
    values = one_way_fragment()

    assert blurball_visibility_rallies(
        values,
        FPS,
        StubCalibration(),
        motion_config=MOTION_CONFIG,
    ) == ()


def test_blurball_filter_rejects_sparse_non_exchange_activity() -> None:
    values = points([0, 2, None, None, None, None, None, None, 4, 6, None, None,
                     None, None, None, None, None, None, None, 8, 10])

    assert _is_inter_rally_fragment(
        summary(values), values, StubCalibration(), MOTION_CONFIG
    )


def test_blurball_filter_keeps_a_coherent_return_across_short_gaps() -> None:
    values = points([
        0, 20, 40, 60, 80, 100, 120,
        None,
        120, 100, 80, 60, 40, 20, 0,
        None,
        0, 10, 20,
    ])

    assert len(blurball_visibility_rallies(
        values,
        FPS,
        StubCalibration(),
        motion_config=MOTION_CONFIG,
    )) == 1


def test_blurball_filter_keeps_continuous_one_way_motion() -> None:
    values = points(list(range(0, 151, 10)))

    assert not _is_inter_rally_fragment(
        summary(values), values, StubCalibration(), MOTION_CONFIG
    )


def test_blurball_filter_keeps_mostly_in_table_activity() -> None:
    values = one_way_fragment()

    assert not _is_inter_rally_fragment(
        summary(values), values, StubCalibration(inside_table=True), MOTION_CONFIG
    )


@pytest.mark.parametrize("end_time", [0.99, 6.01])
def test_blurball_filter_keeps_candidates_outside_its_narrow_duration_window(
    end_time: float,
) -> None:
    values = one_way_fragment()
    rally = VisibilityRallySummary(0, values[-1].frame, 0.0, end_time)

    assert not _is_inter_rally_fragment(rally, values, StubCalibration(), MOTION_CONFIG)


def test_blurball_filter_is_disabled_for_end_on_views() -> None:
    values = one_way_fragment()

    assert len(blurball_visibility_rallies(
        values,
        FPS,
        StubCalibration(fail_if_used=True),
        motion_config=VisibilityMotionConfig(200, 100, vertical_exchange_enabled=True),
    )) == 1


def test_blurball_filter_preserves_the_tracked_istanbul_regression() -> None:
    artifact = (
        Path(__file__).resolve().parents[2]
        / "artifacts"
        / "blurball-v1-istanbul"
        / "blurball_v1.json"
    )
    payload = json.loads(artifact.read_text(encoding="utf-8"))
    values = [TrajectoryPoint(**item) for item in payload["output"]["trajectory"]]
    calibration = TableCalibration.from_points(
        1920,
        1080,
        (
            (952.2999877929688, 435.83929443359375),
            (1235.5, 469.58929443359375),
            (952.2999877929688, 652.8035888671875),
            (606.7000122070312, 590.125),
        ),
    )

    rallies = blurball_visibility_rallies(
        values,
        60.0,
        calibration,
        motion_config=VisibilityMotionConfig(820, 469),
    )
    durations = [rally.end_time - rally.start_time for rally in rallies]

    assert len(rallies) == 43
    assert [
        sum(duration > threshold for duration in durations)
        for threshold in (2.7, 4.0, 4.8)
    ] == [19, 8, 3]
