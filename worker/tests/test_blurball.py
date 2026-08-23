from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from ttcut_worker.blurball_bounce import (
    detect_blurball_bounce_frames,
    landing_table_coordinates,
)
from ttcut_worker.blurball_model import create_blurball
from ttcut_worker.blurball_models import LoadedBlurBall, load_blurball
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
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.video import FramePacket, VideoInfo


def calibration() -> TableCalibration:
    return TableCalibration.from_points(
        400,
        300,
        [[10, 10], [284, 10], [284, 162.5], [10, 162.5]],
    )


def point(
    frame: int, time: float, x: int, y: int, confidence: float = 1.0,
) -> TrajectoryPoint:
    return TrajectoryPoint(frame, time, 1, x, y, "blurball", confidence)


def test_bundled_blurball_architecture_strictly_matches_checkpoint():
    path = Path(__file__).parents[2] / "resources" / "models" / "blurball_best.pt"
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    model = create_blurball()
    assert str(model.load_state_dict(checkpoint["model_state_dict"], strict=True)) == "<All keys matched successfully>"


def test_bundled_blurball_loads_and_runs_on_cpu():
    path = Path(__file__).parents[2] / "resources" / "models" / "blurball_best.pt"
    loaded = load_blurball(path, "cpu")
    with torch.inference_mode():
        output = loaded.model(torch.zeros((1, 9, 160, 280), dtype=torch.float32))[0]
    assert loaded.device == torch.device("cpu")
    assert output.shape == (1, 3, 160, 280)


def test_cpu_predictor_uses_bounded_batch_and_skips_cuda_calls(monkeypatch):
    class FakeReader:
        def __init__(self, value):
            self.info = VideoInfo(Path(value), 96, 64, 30.0, 3, None, 0.1)

        def __iter__(self):
            for index in range(3):
                yield FramePacket(
                    index, index / 30, "fps_estimation",
                    np.zeros((64, 96, 3), dtype=np.uint8),
                )

        def final_info(self):
            return VideoInfo(self.info.path, 96, 64, 30.0, 3, 3, 0.1, "fps_estimation")

    class FakeModel:
        def __init__(self):
            self.devices = []

        def __call__(self, tensor):
            self.devices.append(tensor.device)
            batch, _, height, width = tensor.shape
            logits = torch.full((batch, 3, height, width), -10.0, device=tensor.device)
            logits[:, :, height // 2, width // 2] = 10.0
            return {0: logits}

    model = FakeModel()
    predictor = BlurBallPredictor(LoadedBlurBall(model, torch.device("cpu")))
    monkeypatch.setattr("ttcut_worker.blurball_predictor.StreamingVideoReader", FakeReader)
    monkeypatch.setattr(
        torch.cuda,
        "reset_peak_memory_stats",
        lambda *_args: (_ for _ in ()).throw(AssertionError("CPU predictor touched CUDA stats")),
    )

    points, _, stats = predictor.predict("fake.mp4")

    assert predictor.batch_size == BLURBALL_CPU_BATCH_SIZE
    assert model.devices == [torch.device("cpu")]
    assert len(points) == 3
    assert all(point.source == "blurball" for point in points)
    assert stats.peak_cuda_memory_bytes == 0


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


def test_blurball_keeps_an_upward_flight_that_accelerates_after_contact():
    xs = (100, 110, 120, 130, 140, 150, 160)
    ys = (100, 98, 96, 94, 86, 76, 64)
    trajectory = [
        point(frame, frame * 0.01, x, y)
        for frame, (x, y) in enumerate(zip(xs, ys))
    ]

    detected = detect_blurball_bounce_frames(trajectory, calibration())

    assert len(detected) == 1
    assert abs(detected[0] - 3) <= 1


def test_blurball_rejects_an_acute_paddle_reversal():
    xs = (190, 170, 150, 130, 150, 175, 205)
    ys = (110, 120, 130, 140, 125, 110, 95)
    trajectory = [
        point(frame, frame * 0.1, x, y)
        for frame, (x, y) in enumerate(zip(xs, ys))
    ]

    assert detect_blurball_bounce_frames(trajectory, calibration()) == []


def test_blurball_local_window_survives_a_distant_observation_gap():
    trajectory = [
        point(0, 0.0, 100, 110),
        point(1, 0.1, 110, 120),
        point(2, 0.2, 120, 116),
        TrajectoryPoint(3, 0.3, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(4, 0.4, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(5, 0.5, 0, 0, 0, "missing", 0.0),
        point(6, 0.6, 150, 105),
    ]

    assert detect_blurball_bounce_frames(trajectory, calibration()) == [1]


def test_blurball_short_gap_recovers_a_length_edge_contact():
    trajectory = [
        point(0, 0.0, 80, 135),
        point(1, 0.1, 90, 138),
        point(2, 0.2, 100, 141),
        point(3, 0.3, 110, 144),
        TrajectoryPoint(4, 0.4, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(5, 0.5, 0, 0, 0, "missing", 0.0),
        TrajectoryPoint(6, 0.6, 0, 0, 0, "missing", 0.0),
        point(7, 0.7, 20, 147),
        point(8, 0.8, 30, 135),
        point(9, 0.9, 40, 123),
        point(10, 1.0, 50, 111),
    ]

    assert detect_blurball_bounce_frames(trajectory, calibration()) == [7]
