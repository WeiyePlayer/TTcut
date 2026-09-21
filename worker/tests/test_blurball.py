from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ttcut_worker.blurball_bounce import detect_blurball_bounce_frames, landing_table_coordinates
from ttcut_worker.blurball_predictor import (
    BLURBALL_CPU_BATCH_SIZE,
    BLURBALL_CONFIDENCE_THRESHOLD,
    BLURBALL_MAX_DISPLACEMENT_PIXELS,
    BLURBALL_STEP,
    BlurBallPredictor,
    _OnlineTracker,
    _affine_transforms,
    _decode_heatmap,
)
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.errors import InferenceError
from ttcut_worker.onnx_models import LoadedBlurBall
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.video import FramePacket, VideoInfo


def calibration() -> TableCalibration:
    return TableCalibration.from_points(400, 300, [[10, 10], [284, 10], [284, 162.5], [10, 162.5]])


def point(frame: int, time: float, x: int, y: int, confidence: float = 1.0) -> TrajectoryPoint:
    return TrajectoryPoint(frame, time, 1, x, y, "blurball", confidence)


class FakeReader:
    def __init__(self, value, count=5):
        self.info = VideoInfo(Path(value), 96, 64, 30.0, count, count, count / 30)
        self.count = count

    def __iter__(self):
        for index in range(self.count):
            yield FramePacket(index, index / 30, "fps_estimation", np.zeros((64, 96, 3), dtype=np.uint8))

    def final_info(self):
        return self.info


class PeakSession:
    def __init__(self, value=-10.0):
        self.value = value
        self.batches = []

    def run(self, _outputs, values):
        inputs = values["input"]
        self.batches.append(len(inputs))
        result = np.full((len(inputs), 3, inputs.shape[2], inputs.shape[3]), self.value, dtype=np.float32)
        if np.isfinite(self.value):
            result[:, :, inputs.shape[2] // 2, inputs.shape[3] // 2] = 10.0
        return [result]


def test_cpu_predictor_uses_bounded_onnx_batch(monkeypatch):
    session = PeakSession()
    predictor = BlurBallPredictor(LoadedBlurBall(session, "cpu", Path("model.onnx")))
    monkeypatch.setattr("ttcut_worker.blurball_predictor.StreamingVideoReader", lambda value: FakeReader(value, 5))
    points, _, stats = predictor.predict("fake.mp4")
    assert predictor.batch_size == BLURBALL_CPU_BATCH_SIZE
    assert session.batches == [2]
    assert len(points) == 5
    assert all(item.source == "blurball" for item in points)
    assert stats.peak_cuda_memory_bytes == 0


def test_interval_predictor_keeps_only_center_frames(monkeypatch):
    session = PeakSession()
    predictor = BlurBallPredictor(LoadedBlurBall(session, "cpu", Path("model.onnx")))
    monkeypatch.setattr("ttcut_worker.blurball_predictor.StreamingVideoReader", lambda value: FakeReader(value, 5))
    points, _, stats = predictor.predict_intervals("fake.mp4", ((1 / 30, 3 / 30),))
    assert [item.frame for item in points] == [1, 2, 3]
    assert stats.step == 1
    assert session.batches == [3]


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), float("-inf")])
def test_invalid_model_values_fail_instead_of_returning_missing_balls(monkeypatch, invalid):
    monkeypatch.setattr("ttcut_worker.blurball_predictor.StreamingVideoReader", lambda value: FakeReader(value, 3))
    predictor = BlurBallPredictor(LoadedBlurBall(PeakSession(invalid), "cpu", Path("model.onnx")))
    with pytest.raises(InferenceError, match="non-finite"):
        predictor.predict("fake.mp4")


def test_invalid_heatmap_is_not_a_legitimate_empty_detection():
    _, inverse = _affine_transforms(512, 288)
    heatmap = np.zeros((288, 512), dtype=np.float32)
    assert _decode_heatmap(heatmap, inverse, 0, 0) == ()
    heatmap[0, 0] = np.nan
    with pytest.raises(InferenceError):
        _decode_heatmap(heatmap, inverse, 0, 0)


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


def test_affine_decode_uses_the_requested_confidence_threshold():
    _, inverse = _affine_transforms(512, 288)
    heatmap = np.zeros((288, 512), dtype=np.float32)
    heatmap[100, 200] = 0.6
    assert _decode_heatmap(heatmap, inverse, 0, 0) == ()
    assert len(_decode_heatmap(heatmap, inverse, 0, 0, confidence_threshold=0.55)) == 1


def test_blurball_bounce_uses_ttcut_expanded_table_region_and_interval():
    assert landing_table_coordinates(point(0, 0.0, 10, 10), calibration()) is not None
    assert landing_table_coordinates(point(0, 0.0, 350, 250), calibration()) is None
    values = [20, 24, 29, 35, 43, 35, 29, 24, 20]
    trajectory = [point(index, index * 0.1, 100, y) for index, y in enumerate(values)]
    assert detect_blurball_bounce_frames(trajectory, calibration()) == [4]


def test_blurball_keeps_an_upward_flight_that_accelerates_after_contact():
    xs = (100, 110, 120, 130, 140, 150, 160)
    ys = (100, 98, 96, 94, 86, 76, 64)
    trajectory = [point(frame, frame * 0.01, x, y) for frame, (x, y) in enumerate(zip(xs, ys))]
    detected = detect_blurball_bounce_frames(trajectory, calibration())
    assert len(detected) == 1
    assert abs(detected[0] - 3) <= 1


def test_blurball_rejects_an_acute_paddle_reversal():
    xs = (190, 170, 150, 130, 150, 175, 205)
    ys = (110, 120, 130, 140, 125, 110, 95)
    trajectory = [point(frame, frame * 0.1, x, y) for frame, (x, y) in enumerate(zip(xs, ys))]
    assert detect_blurball_bounce_frames(trajectory, calibration()) == []


def test_blurball_local_window_survives_a_distant_observation_gap():
    trajectory = [
        point(0, 0.0, 100, 110), point(1, 0.1, 110, 120), point(2, 0.2, 120, 116),
        TrajectoryPoint(3, 0.3, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(4, 0.4, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(5, 0.5, 0, 0, 0, "missing", 0.0), point(6, 0.6, 150, 105),
    ]
    assert detect_blurball_bounce_frames(trajectory, calibration()) == [1]


def test_blurball_short_gap_recovers_a_length_edge_contact():
    trajectory = [
        point(0, 0.0, 80, 135), point(1, 0.1, 90, 138), point(2, 0.2, 100, 141), point(3, 0.3, 110, 144),
        TrajectoryPoint(4, 0.4, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(5, 0.5, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(6, 0.6, 0, 0, 0, "missing", 0.0),
        point(7, 0.7, 20, 147), point(8, 0.8, 30, 135), point(9, 0.9, 40, 123), point(10, 1.0, 50, 111),
    ]
    assert detect_blurball_bounce_frames(trajectory, calibration()) == [7]
