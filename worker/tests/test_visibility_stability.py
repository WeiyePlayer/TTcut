from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from ttcut_worker.blurball_rallies import blurball_visibility_rallies, _slow_transfer_runs, _motion_runs_have_rally_break
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.roi import build_analysis_roi, stabilize_visibility_roi
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.visibility_rallies import VisibilityMotionConfig


@pytest.fixture(scope="module")
def real_case():
    return json.loads(gzip.decompress((Path(__file__).parent / "fixtures/visibility-stability-c51.json.gz").read_bytes()))


def calibration(value):
    return TableCalibration.from_points(value["video_width"], value["video_height"], [
        value["points"][key] for key in ("top_left", "top_right", "bottom_right", "bottom_left")
    ])


@pytest.mark.parametrize("index", [0, 1, 2])
def test_small_manual_adjustments_share_model_sampling_and_preserve_rally_cores(real_case, index):
    table = calibration(real_case["calibrations"][index])
    roi = stabilize_visibility_roi(build_analysis_roi(table))
    assert roi.bbox == (224, 176, 704, 416)
    assert stabilize_visibility_roi(roi).bbox == roi.bbox
    rallies = blurball_visibility_rallies(
        [TrajectoryPoint(*p) for p in real_case["trajectory"]], real_case["fps"], table,
        motion_config=VisibilityMotionConfig(roi.width, roi.height),
    )
    if index in (1, 2):
        assert len(rallies) == 40
        assert [[r.start_time, r.end_time] for r in rallies] == [r[:2] for r in real_case["expected"]]
    clips = [[max(0, r.start_time - 2.5, r.lead_in_start_time or 0), r.end_time + 1] for r in rallies]
    for left, right in zip(clips, clips[1:]):
        if left[1] > right[0]:
            left[1] = right[0] = (left[1] + right[0]) / 2
    matches = []
    for start, end in real_case["reference_core"]:
        covered = [i for i, (s, e) in enumerate(clips) if s <= start + 1e-6 and e >= end - 1e-6]
        assert len(covered) == 1, (start, end, covered)
        matches.append(covered[0])
    assert len(set(matches)) == 40  # No missing or combined reference rallies.
    if index in (1, 2):
        for start, end in [(324, 327), (335.1, 337.5), (379.93, 380.8), (457.5, 458.37)]:
            assert not any(s < end and e > start for s, e in clips)
        assert clips[38][0] >= 474.4
        # The 335.0-338.7 pass fails the early motion gate. It must still
        # constrain padding on the following rally at 339.9 seconds.
        following = next(i for i, r in enumerate(rallies) if 339 < r.start_time < 341)
        assert clips[following][0] >= 338.7


def test_a_slow_pass_followed_by_an_exchange_is_not_deleted_wholesale(real_case):
    table = calibration(real_case["calibrations"][-1])
    roi = build_analysis_roi(table)
    assert not _slow_transfer_runs(
        [TrajectoryPoint(*p) for p in real_case["mixed_candidate"]], table,
        VisibilityMotionConfig(roi.width, roi.height),
    )


@pytest.mark.parametrize("fps", [15, 30, 60])
def test_vertical_flights_are_not_held_ball_evidence(fps):
    points = []
    for frame in range(round(2.8 * fps) + 1):
        t = frame / fps
        visible = 0.2 <= t <= 0.95 or 1.3 <= t <= 2.1
        y = 20 + int((t % 0.7) / 0.7 * 100)
        points.append(TrajectoryPoint(frame, t, int(visible), 100, y))
    assert not _motion_runs_have_rally_break(
        [points[0]], [points[-1]], points, [p.frame for p in points], 500, 240,
    )


def test_visibility_inference_disables_timing_based_kernel_selection(monkeypatch):
    import torch
    from ttcut_worker.blurball_models import configure_stable_visibility_inference
    monkeypatch.setattr(torch.backends.cudnn, "benchmark", True)
    monkeypatch.setattr(torch.backends.cudnn, "deterministic", False)
    configure_stable_visibility_inference()
    assert torch.backends.cudnn.benchmark is False
    assert torch.backends.cudnn.deterministic is True
