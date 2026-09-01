from __future__ import annotations

from dataclasses import dataclass

from ttcut_worker.tracknet_rallies import tracknet_visibility_rallies
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


FPS = 10.0
MOTION_CONFIG = VisibilityMotionConfig(analysis_width_pixels=200, analysis_height_pixels=100)


@dataclass
class FakeCalibration:
    inside: bool = True

    def image_to_table(self, x: float, y: float) -> tuple[float, float]:
        return (100.0, 50.0) if self.inside else (-100.0, -100.0)


@dataclass
class ThresholdCalibration:
    minimum_inside_x: float

    def image_to_table(self, x: float, y: float) -> tuple[float, float]:
        return (100.0, 50.0) if x >= self.minimum_inside_x else (-100.0, -100.0)


def points(xs: list[int], *, start_frame: int = 0) -> list[TrajectoryPoint]:
    return [
        TrajectoryPoint(frame, frame / FPS, 1, x, 20, "tracknet", 0.9)
        for frame, x in zip(range(start_frame, start_frame + len(xs)), xs, strict=True)
    ]


def test_tracknet_filter_rejects_a_subsecond_exchange() -> None:
    trajectory = points([0, 30, 60, 90, 60, 30, 0, 30, 60])

    assert tracknet_visibility_rallies(
        trajectory, FPS, FakeCalibration(), motion_config=MOTION_CONFIG,
    ) == ()


def test_tracknet_filter_rejects_a_monotonic_pass_without_a_run_reversal() -> None:
    trajectory = points(list(range(0, 165, 15)))

    assert tracknet_visibility_rallies(
        trajectory, FPS, FakeCalibration(), motion_config=MOTION_CONFIG,
    ) == ()


def test_tracknet_filter_requires_short_exchanges_to_visit_the_expanded_table() -> None:
    trajectory = points([0, 30, 60, 90, 60, 30, 0, 30, 60, 90, 60, 30, 0])

    assert len(tracknet_visibility_rallies(
        trajectory, FPS, FakeCalibration(inside=True), motion_config=MOTION_CONFIG,
    )) == 1
    assert tracknet_visibility_rallies(
        trajectory, FPS, FakeCalibration(inside=False), motion_config=MOTION_CONFIG,
    ) == ()


def test_tracknet_filter_accepts_exactly_twenty_percent_short_table_visits() -> None:
    trajectory = points([0, 30, 60, 90, 60, 30, 0, 30, 60, 90])

    assert len(tracknet_visibility_rallies(
        trajectory,
        FPS,
        ThresholdCalibration(minimum_inside_x=90),
        motion_config=MOTION_CONFIG,
    )) == 1
    assert tracknet_visibility_rallies(
        trajectory,
        FPS,
        ThresholdCalibration(minimum_inside_x=91),
        motion_config=MOTION_CONFIG,
    ) == ()


def test_tracknet_filter_bridges_two_reliable_fragments_across_a_short_occlusion() -> None:
    first = points([0, 30, 60, 90, 60, 30, 0, 30, 60, 0])
    missing = [
        TrajectoryPoint(frame, frame / FPS, 0, 0, 0)
        for frame in range(10, 15)
    ]
    second = points([100, 130, 160, 190, 160, 130, 100, 130, 160, 100], start_frame=15)

    rallies = tracknet_visibility_rallies(
        [*first, *missing, *second],
        FPS,
        FakeCalibration(),
        motion_config=MOTION_CONFIG,
    )

    assert [(rally.start_frame, rally.end_frame) for rally in rallies] == [(0, 24)]


def test_tracknet_filter_bridges_reliable_fragments_up_to_one_and_a_half_seconds() -> None:
    first = points([0, 30, 60, 90, 60, 30, 0, 30, 60, 0])
    missing = [
        TrajectoryPoint(frame, frame / FPS, 0, 0, 0)
        for frame in range(10, 24)
    ]
    second = points([100, 130, 160, 190, 160, 130, 100, 130, 160, 100], start_frame=24)

    rallies = tracknet_visibility_rallies(
        [*first, *missing, *second],
        FPS,
        FakeCalibration(),
        motion_config=MOTION_CONFIG,
    )

    assert [(rally.start_frame, rally.end_frame) for rally in rallies] == [(0, 33)]


def test_tracknet_filter_keeps_fragments_separate_beyond_one_and_a_half_seconds() -> None:
    first = points([0, 30, 60, 90, 60, 30, 0, 30, 60, 0])
    missing = [
        TrajectoryPoint(frame, frame / FPS, 0, 0, 0)
        for frame in range(10, 25)
    ]
    second = points([100, 130, 160, 190, 160, 130, 100, 130, 160, 100], start_frame=25)

    rallies = tracknet_visibility_rallies(
        [*first, *missing, *second],
        FPS,
        FakeCalibration(),
        motion_config=MOTION_CONFIG,
    )

    assert [(rally.start_frame, rally.end_frame) for rally in rallies] == [(0, 9), (25, 34)]
