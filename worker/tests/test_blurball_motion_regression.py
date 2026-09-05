"""Fixed detector output plus independently edited source intervals.

The fixture is a real BlurBall 0.30 run; no XML is read by production code.
Temporal agreement includes the configured 2.5 s lead and 2 s total tail.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.blurball_rallies import blurball_visibility_rallies, _motion_runs_have_rally_break
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


def test_user_labeled_passes_are_removed_without_moving_other_rallies() -> None:
    payload = json.loads(gzip.decompress(
        (Path(__file__).parent / "fixtures/visibility-slow-pass-c51.json.gz").read_bytes(),
    ))
    value = payload["calibration"]
    calibration = TableCalibration.from_points(value["video_width"], value["video_height"], [
        value["points"][key] for key in ("top_left", "top_right", "bottom_right", "bottom_left")
    ])
    rallies = blurball_visibility_rallies(
        [TrajectoryPoint(*point) for point in payload["trajectory"]], payload["fps"], calibration,
        motion_config=VisibilityMotionConfig(payload["width"], payload["height"]),
    )
    expected = [(index, bounds) for index, bounds in enumerate(payload["before"], 1)
                if index not in payload["drop_indices"]]
    assert len(rallies) == len(expected) == 40
    for rally, (index, bounds) in zip(rallies, expected):
        # No boundary tolerance is needed: every kept source frame is unchanged.
        assert [rally.start_time, rally.end_time] == bounds
        if index == 43:
            assert rally.lead_in_start_time >= 474.4
            assert rally.lead_in_start_time < rally.start_time
        elif index in (28, 30):
            previous_pass_end = payload["before"][index - 2][1]
            assert rally.lead_in_start_time == pytest.approx(previous_pass_end + 1 / payload["fps"])
        if rally.lead_in_start_time is not None:
            # Earlier motion gates may also reject a passing candidate. Its
            # lead-in floor can trim padding, but never an observed rally frame.
            assert rally.start_time - 3 <= rally.lead_in_start_time <= rally.start_time


def test_real_rallies_match_manual_clips_without_splitting_exchanges() -> None:
    payload = json.loads(gzip.decompress(
        (Path(__file__).parent / "fixtures/visibility-motion-c51.json.gz").read_bytes(),
    ))
    points = [TrajectoryPoint(frame, *value) for frame, value in enumerate(payload["trajectory"])]
    value = payload["calibration"]
    calibration = TableCalibration.from_points(value["video_width"], value["video_height"], value["points"])
    roi = payload["analysis_roi"]
    config = VisibilityMotionConfig(roi["x1"] - roi["x0"], roi["y1"] - roi["y0"])
    rallies = blurball_visibility_rallies(points, payload["fps"], calibration, motion_config=config)
    clips = [[max(0, rally.start_time - 2.5), min(payload["duration_seconds"], rally.end_time + 2)] for rally in rallies]
    for left, right in zip(clips, clips[1:]):
        if left[1] > right[0]:
            left[1] = right[0] = (left[1] + right[0]) / 2
    manual = payload["manual_clips"]
    overlap = lambda a, b: max(0, min(a[1], b[1]) - max(a[0], b[0]))
    assert len(clips) == len(manual) == 41
    for index, clip in enumerate(clips):
        assert max(range(len(manual)), key=lambda j: overlap(clip, manual[j])) == index
        intersection = overlap(clip, manual[index])
        union = max(clip[1], manual[index][1]) - min(clip[0], manual[index][0])
        assert intersection / union >= 0.4
    shared = sum(overlap(clip, reference) for clip in clips for reference in manual)
    assert shared / sum(end - start for start, end in clips) >= 0.85
    assert shared / sum(end - start for start, end in manual) >= 0.93
    for start, end in [(6.2, 15.5), (410, 417)]:
        assert any(rally.start_time <= start and rally.end_time >= end for rally in rallies)
    for start, end in [(215.9, 216.5), (291.6, 292.8), (382.4, 383.8), (421.3, 423.0), (324, 327)]:
        assert not any(overlap((r.start_time, r.end_time), (start, end)) for r in rallies)
    for rally in rallies:
        assert points[rally.start_frame].visibility == points[rally.end_frame].visibility == 1
        assert points[rally.start_frame].time == rally.start_time
        assert points[rally.end_frame].time == rally.end_time


@pytest.mark.parametrize("fps", [15, 30, 60])
@pytest.mark.parametrize("scale", [1, 2])
def test_small_repeated_motion_is_not_stationary(fps: int, scale: int) -> None:
    values = []
    for frame in range(5 * fps + 1):
        time = frame / fps
        phase = time % 0.7
        visible = phase < 0.5
        x = (100 + 40 * phase / 0.5) * scale
        values.append(TrajectoryPoint(frame, time, int(visible), int(x), 30 * scale))
    assert not _motion_runs_have_rally_break(
        [values[0]], [values[-1]], values, list(range(len(values))), 200 * scale,
    )


@pytest.mark.parametrize("case", json.loads(gzip.decompress(
    (Path(__file__).parent / "fixtures/visibility-motion-regressions.json.gz").read_bytes(),
)), ids=lambda case: case["name"])
def test_real_video_motion_regressions(case: dict) -> None:
    value = case["calibration"]
    calibration = TableCalibration.from_points(
        value["video_width"], value["video_height"], value["points"],
    )
    points = [TrajectoryPoint(*point) for point in case["trajectory"]]
    rallies = blurball_visibility_rallies(
        points, case["fps"], calibration,
        motion_config=VisibilityMotionConfig(case["width"], case["height"]),
    )
    for start, end in case["keep"]:
        assert any(rally.start_time <= start and rally.end_time >= end for rally in rallies)
    for start, end in case["drop"]:
        assert not any(rally.start_time < end and rally.end_time > start for rally in rallies)
    if case["name"] == "c51_calibration_perturbation":
        assert len(rallies) == 41
