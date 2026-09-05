from __future__ import annotations

import json
from pathlib import Path

import pytest

from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import (
    VisibilityMotionConfig,
    continuous_visibility_rallies,
    is_end_on_table_view,
)


MOTION_CONFIG = VisibilityMotionConfig(analysis_width_pixels=200, analysis_height_pixels=100)


def point(
    frame: int,
    visible: int,
    *,
    fps: float = 10.0,
    x: int = 100,
    y: int = 20,
) -> TrajectoryPoint:
    return TrajectoryPoint(frame, frame / fps, visible, x, y, "blurball", 1.0)


def boundaries(points: list[TrajectoryPoint], fps: float = 10.0) -> list[tuple[int, int, float, float]]:
    return [
        (rally.start_frame, rally.end_frame, rally.start_time, rally.end_time)
        for rally in continuous_visibility_rallies(points, fps)
    ]


def test_candidate_resets_before_start_confirmation() -> None:
    assert boundaries([point(0, 1), point(1, 0), point(2, 1)]) == []


def test_confirms_at_exact_start_threshold_and_uses_first_visible_boundary() -> None:
    assert boundaries([point(0, 1), point(1, 1), point(2, 0), point(3, 0), point(4, 0), point(5, 0), point(6, 0)]) == [
        (0, 1, 0.0, 0.1),
    ]


def test_short_missing_gap_is_bridged_and_end_backtracks_to_last_visible_frame() -> None:
    points = [point(0, 1), point(1, 1), *[point(frame, 0) for frame in range(2, 6)], point(6, 1)]
    assert boundaries(points) == [(0, 6, 0.0, 0.6)]


def test_exact_end_threshold_ends_at_last_visible_frame() -> None:
    points = [point(0, 1), point(1, 1), *[point(frame, 0) for frame in range(2, 7)]]
    assert boundaries(points) == [(0, 1, 0.0, 0.1)]


def test_eof_finishes_an_active_rally_but_discards_unconfirmed_candidate() -> None:
    assert boundaries([point(0, 1), point(1, 1), point(2, 1)]) == [(0, 2, 0.0, 0.2)]
    assert boundaries([point(0, 1)]) == []


def test_low_fps_uses_minimum_start_and_end_frames() -> None:
    assert boundaries([point(0, 1, fps=1), point(1, 1, fps=1), point(2, 0, fps=1)], 1) == [(0, 1, 0.0, 1.0)]


@pytest.mark.parametrize("fps", [0, -1, float("nan"), float("inf")])
def test_invalid_fps_is_rejected(fps: float) -> None:
    with pytest.raises(ValueError, match="fps"):
        continuous_visibility_rallies([], fps)


def test_zero_duration_candidate_is_discarded() -> None:
    same_time = [
        TrajectoryPoint(0, 1.0, 1, 100, 20, "blurball", 1.0),
        TrajectoryPoint(1, 1.0, 1, 100, 20, "blurball", 1.0),
    ]
    with pytest.raises(ValueError, match="strictly ordered"):
        continuous_visibility_rallies(same_time, 10)


def test_motion_filter_rejects_one_way_inter_rally_pass() -> None:
    points = [
        point(frame, 1, x=frame * 20, y=20 if frame % 2 == 0 else 60)
        for frame in range(10)
    ]
    assert continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG) == ()


def test_motion_filter_keeps_a_robust_horizontal_exchange() -> None:
    xs = [0, 30, 60, 90, 60, 30, 0, 30, 60]
    points = [point(frame, 1, x=x, y=20) for frame, x in enumerate(xs)]
    assert len(continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG)) == 1


def test_end_on_view_enables_a_dominant_robust_vertical_exchange() -> None:
    ys = [0, 30, 60, 90, 60, 30, 0, 30, 60]
    points = [point(frame, 1, x=20, y=y) for frame, y in enumerate(ys)]

    assert continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG) == ()
    assert len(continuous_visibility_rallies(
        points,
        10,
        motion_config=VisibilityMotionConfig(200, 100, vertical_exchange_enabled=True),
    )) == 1


def test_end_on_vertical_exchange_must_dominate_horizontal_range() -> None:
    ys = [0, 30, 60, 30, 0, 30, 60, 30, 0]
    points = [point(frame, 1, x=frame * 20, y=y) for frame, y in enumerate(ys)]

    assert continuous_visibility_rallies(
        points,
        10,
        motion_config=VisibilityMotionConfig(200, 100, vertical_exchange_enabled=True),
    ) == ()


def test_end_on_view_detection_is_conservative() -> None:
    assert is_end_on_table_view(((764, 410), (1193, 413), (1208, 599), (740, 599)))
    assert not is_end_on_table_view(((692, 298), (933, 314), (827, 416), (465, 381)))


def test_motion_filter_keeps_a_short_robust_horizontal_exchange() -> None:
    xs = [0, 0, 30, 60, 90, 90, 60, 30, 0, 0, 30, 60, 90, 90, 60, 30, 0]
    points = [point(frame, 1, fps=30, x=x, y=20) for frame, x in enumerate(xs)]
    assert len(continuous_visibility_rallies(points, 30, motion_config=MOTION_CONFIG)) == 1


def test_motion_filter_ignores_an_isolated_horizontal_jump() -> None:
    xs = [0, 10, 20, 30, 40, 150, 50, 60, 70, 80]
    points = [
        point(frame, 1, x=x, y=20 if frame % 2 == 0 else 60)
        for frame, x in enumerate(xs)
    ]
    assert continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG) == ()


def test_motion_filter_does_not_count_a_reversal_across_a_long_detection_gap() -> None:
    points = [
        *[point(frame, 1, x=100 - frame * 20, y=20 if frame % 2 == 0 else 60) for frame in range(5)],
        *[point(frame, 0) for frame in range(5, 9)],
        point(9, 1, x=150, y=20),
        point(10, 1, x=130, y=60),
        point(11, 1, x=110, y=20),
    ]
    gap_only_config = VisibilityMotionConfig(analysis_width_pixels=500, analysis_height_pixels=100)
    assert continuous_visibility_rallies(points, 10, motion_config=gap_only_config) == ()


def test_motion_filter_keeps_a_simple_monotonic_cross_table_flight() -> None:
    points = [point(frame, 1, x=frame * 15, y=20) for frame in range(7)]
    assert len(continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG)) == 1


def test_motion_filter_rejects_a_too_short_monotonic_cross_table_flight() -> None:
    points = [point(frame, 1, x=frame * 15, y=20) for frame in range(6)]
    assert continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG) == ()


def test_motion_filter_rejects_a_short_vertical_monotonic_cross_table_flight() -> None:
    points = [point(frame, 1, x=frame * 7, y=frame * 6) for frame in range(12)]
    assert continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG) == ()


def test_nearby_qualified_fragments_bridge_a_long_occlusion() -> None:
    left_xs = [0, 30, 60, 90, 60, 30, 0]
    right_xs = [60, 90, 120, 150, 120, 90, 60]
    points = [
        *[point(frame, 1, x=x) for frame, x in enumerate(left_xs)],
        *[point(frame, 0) for frame in range(7, 20)],
        *[point(frame, 1, x=x) for frame, x in zip(range(20, 27), right_xs, strict=True)],
    ]
    assert boundaries(points) == [(0, 6, 0.0, 0.6), (20, 26, 2.0, 2.6)]
    assert [
        (rally.start_frame, rally.end_frame)
        for rally in continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG)
    ] == [(0, 26)]


def test_distant_fragments_do_not_bridge_the_same_occlusion() -> None:
    left_xs = [0, 30, 60, 90, 60, 30, 0]
    right_xs = [150, 180, 210, 240, 210, 180, 150]
    points = [
        *[point(frame, 1, x=x) for frame, x in enumerate(left_xs)],
        *[point(frame, 0) for frame in range(7, 20)],
        *[point(frame, 1, x=x) for frame, x in zip(range(20, 27), right_xs, strict=True)],
    ]
    assert len(continuous_visibility_rallies(points, 10, motion_config=MOTION_CONFIG)) == 2


def test_istanbul_tracked_trajectory_records_candidate_and_filtered_counts() -> None:
    artifact = Path(__file__).resolve().parents[2] / "artifacts" / "blurball-v1-istanbul" / "blurball_v1.json"
    payload = json.loads(artifact.read_text(encoding="utf-8"))
    points = [TrajectoryPoint(**item) for item in payload["output"]["trajectory"]]
    rallies = continuous_visibility_rallies(points, 60.0)
    durations = [rally.end_time - rally.start_time for rally in rallies]

    assert len(rallies) == 45
    assert [sum(duration > threshold for duration in durations) for threshold in (2.7, 4.0, 4.8)] == [19, 8, 3]

    filtered = continuous_visibility_rallies(
        points,
        60.0,
        motion_config=VisibilityMotionConfig(analysis_width_pixels=820, analysis_height_pixels=469),
    )
    filtered_durations = [rally.end_time - rally.start_time for rally in filtered]
    assert len(filtered) == 43
    assert [sum(duration > threshold for duration in filtered_durations) for threshold in (2.7, 4.0, 4.8)] == [19, 8, 3]
