from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from ttcut_worker.blurball_bounce import (
    detect_blurball_bounce_frames,
    landing_table_coordinates,
)
from ttcut_worker.blurball_model import create_blurball
from ttcut_worker.blurball_predictor import (
    BLURBALL_CONFIDENCE_THRESHOLD,
    BLURBALL_MAX_DISPLACEMENT_PIXELS,
    BLURBALL_STEP,
    _OnlineTracker,
    _affine_transforms,
    _decode_heatmap,
)
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.types import TrajectoryPoint


def calibration() -> TableCalibration:
    return TableCalibration.from_points(
        400,
        300,
        [[10, 10], [284, 10], [284, 162.5], [10, 162.5]],
    )


def point(frame: int, time: float, x: int, y: int) -> TrajectoryPoint:
    return TrajectoryPoint(frame, time, 1, x, y, "blurball", 1.0)


def test_bundled_blurball_architecture_strictly_matches_checkpoint():
    path = Path(__file__).parents[2] / "resources" / "models" / "blurball_best.pt"
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    model = create_blurball()
    assert str(model.load_state_dict(checkpoint["model_state_dict"], strict=True)) == "<All keys matched successfully>"


def test_fixed_blurball_parameters_match_product_contract():
    assert BLURBALL_CONFIDENCE_THRESHOLD == 0.7
    assert BLURBALL_STEP == 3
    assert BLURBALL_MAX_DISPLACEMENT_PIXELS == 100.0


def test_online_tracker_applies_100_pixel_gate_only_after_visible_frame():
    tracker = _OnlineTracker(BLURBALL_MAX_DISPLACEMENT_PIXELS)
    assert tracker.update(((10.0, 10.0, 1.0), (20.0, 20.0, 2.0))) == (20.0, 20.0, 2.0)
    assert tracker.update(((120.0, 20.0, 3.0),)) is None
    assert tracker.update(((120.0, 20.0, 3.0),)) == (120.0, 20.0, 3.0)


def test_affine_decode_maps_weighted_blob_back_to_roi_coordinates():
    _, inverse = _affine_transforms(512, 288)
    heatmap = np.zeros((288, 512), dtype=np.float32)
    heatmap[100, 200] = 0.8
    heatmap[100, 201] = 0.9
    detections = _decode_heatmap(heatmap, inverse, 30, 40)
    assert len(detections) == 1
    x, y, score = detections[0]
    assert 230.0 < x < 231.0
    assert abs(y - 140.0) < 1e-4
    assert 1.69 < score < 1.71


def test_blurball_bounce_uses_ttcut_expanded_table_region_and_interval():
    inside = point(0, 0.0, 10, 10)
    assert landing_table_coordinates(inside, calibration()) is not None
    outside = point(0, 0.0, 350, 250)
    assert landing_table_coordinates(outside, calibration()) is None

    values = [20, 24, 29, 35, 43, 35, 29, 24, 20]
    trajectory = [point(index, index * 0.1, 100, y) for index, y in enumerate(values)]
    assert detect_blurball_bounce_frames(trajectory, calibration()) == [4]
