from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
import torch

from ttcut_worker.dual_predictor import UpliftingDualPredictor
from ttcut_worker.roi import AnalysisRoi
from ttcut_worker.video import FramePacket, VideoInfo


def _uplifting_bgr_reference(frame: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    mean = np.asarray([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)
    resized = cv2.resize(frame, size, interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
    return ((resized - mean) / std).transpose(2, 0, 1).astype(np.float32, copy=False)


def test_dual_preprocessing_preserves_uplifting_bgr_channel_order() -> None:
    frame = np.asarray([
        [[5, 40, 240], [15, 50, 230], [25, 60, 220], [35, 70, 210]],
        [[45, 80, 200], [55, 90, 190], [65, 100, 180], [75, 110, 170]],
        [[85, 120, 160], [95, 130, 150], [105, 140, 140], [115, 150, 130]],
    ], dtype=np.uint8)

    actual = UpliftingDualPredictor._preprocess_frame(frame, (3, 2), None)

    np.testing.assert_allclose(actual, _uplifting_bgr_reference(frame, (3, 2)), rtol=0, atol=0)


def test_dual_roi_preprocessing_crops_before_source_compatible_bgr_resize() -> None:
    frame = np.arange(5 * 6 * 3, dtype=np.uint8).reshape(5, 6, 3)
    roi = AnalysisRoi(
        1, 1, 5, 4,
        ((1.0, 1.0), (5.0, 1.0), (5.0, 4.0), (1.0, 4.0)),
        0.0,
        6,
        5,
    )

    actual = UpliftingDualPredictor._preprocess_frame(frame, (4, 4), roi)

    np.testing.assert_allclose(actual, _uplifting_bgr_reference(frame[1:4, 1:5], (4, 4)), rtol=0, atol=0)


@pytest.mark.skipif(not torch.cuda.is_available(), reason="dual profile is CUDA-only")
def test_dual_prediction_refines_an_asymmetric_heatmap_peak(monkeypatch) -> None:
    class FakeReader:
        def __init__(self, video_path):
            self.info = VideoInfo(Path(video_path), 32, 32, 60.0, 3, None, 0.05)

        def __iter__(self):
            frame = np.zeros((32, 32, 3), dtype=np.uint8)
            for index in range(3):
                yield FramePacket(index, index / 60.0, "fps_estimation", frame)

        def final_info(self):
            return VideoInfo(self.info.path, 32, 32, 60.0, 3, 3, 0.05, "fps_estimation")

    class MainModel:
        def __call__(self, inputs):
            heatmap = torch.zeros((inputs.shape[0], 1, 8, 8), device=inputs.device)
            heatmap[:, 0, 3, 3] = 1.0
            heatmap[:, 0, 3, 4] = 0.75
            return heatmap, None

    class AuxModel:
        def __call__(self, inputs):
            heatmap = torch.zeros((inputs.shape[0], 1, 8, 8), device=inputs.device)
            heatmap[:, 0, 3, 3] = 1.0
            heatmap[:, 0, 3, 4] = 0.75
            return heatmap, None

    monkeypatch.setattr("ttcut_worker.dual_predictor.StreamingVideoReader", FakeReader)
    predictor = UpliftingDualPredictor(SimpleNamespace(
        main=MainModel(),
        aux=AuxModel(),
        device=torch.device("cuda"),
    ))

    points, _, _ = predictor.predict("synthetic.mp4")

    assert [(item.visibility, item.x, item.y) for item in points] == [
        (0, 0, 0),
        (1, 15, 14),
        (0, 0, 0),
    ]
