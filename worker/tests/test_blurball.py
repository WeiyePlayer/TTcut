from __future__ import annotations

from pathlib import Path
from contextlib import contextmanager

import numpy as np
import pytest
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
from ttcut_worker.errors import InferenceError
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


def test_interval_predictor_keeps_only_center_frames_and_resets_gaps(monkeypatch):
    class FakeReader:
        def __init__(self, value):
            self.info = VideoInfo(Path(value), 96, 64, 30.0, 5, None, 5 / 30)

        def __iter__(self):
            for index in range(5):
                yield FramePacket(
                    index, index / 30, "fps_estimation",
                    np.zeros((64, 96, 3), dtype=np.uint8),
                )

        def final_info(self):
            return VideoInfo(self.info.path, 96, 64, 30.0, 5, 5, 5 / 30, "fps_estimation")

    class FakeModel:
        def __init__(self):
            self.calls = 0

        def __call__(self, tensor):
            self.calls += 1
            batch, _, height, width = tensor.shape
            logits = torch.full((batch, 3, height, width), -10.0, device=tensor.device)
            logits[:, :, height // 2, width // 2] = 10.0
            return {0: logits}

    model = FakeModel()
    predictor = BlurBallPredictor(LoadedBlurBall(model, torch.device("cpu")))
    monkeypatch.setattr("ttcut_worker.blurball_predictor.StreamingVideoReader", FakeReader)

    points, _, stats = predictor.predict_intervals("fake.mp4", ((1 / 30, 3 / 30),))

    assert [item.frame for item in points] == [1, 2, 3]
    assert [round(item.time, 6) for item in points] == [round(1 / 30, 6), round(2 / 30, 6), round(3 / 30, 6)]
    assert all(item.source == "blurball" for item in points)
    assert stats.step == 1
    assert model.calls == 1


@pytest.mark.parametrize('invalid', [float('nan'), float('inf'), float('-inf')])
@pytest.mark.parametrize('intervals', [False, True])
def test_invalid_model_values_fail_instead_of_returning_missing_balls(monkeypatch, invalid, intervals):
    class Reader:
        def __init__(self, value):
            self.info = VideoInfo(Path(value), 96, 64, 30.0, 3, 3, 0.1)

        def __iter__(self):
            for index in range(3):
                yield FramePacket(index, index / 30, 'fps_estimation', np.zeros((64, 96, 3), np.uint8))

        def final_info(self):
            return self.info

    class Model:
        def __call__(self, tensor):
            batch, _, height, width = tensor.shape
            return {0: torch.full((batch, 3, height, width), invalid)}

    monkeypatch.setattr('ttcut_worker.blurball_predictor.StreamingVideoReader', Reader)
    predictor = BlurBallPredictor(LoadedBlurBall(Model(), torch.device('cpu')))
    with pytest.raises(InferenceError, match='non-finite'):
        if intervals:
            predictor.predict_intervals('fake.mp4', ((0, .1),))
        else:
            predictor.predict('fake.mp4')


@pytest.mark.parametrize('recovers', [True, False])
def test_cuda_invalid_half_precision_retries_and_stays_in_float32(monkeypatch, capsys, recovers):
    mixed = False
    calls = []

    @contextmanager
    def autocast(*, device_type, dtype):
        nonlocal mixed
        assert device_type == 'cuda' and dtype == torch.float16
        mixed = True
        try:
            yield
        finally:
            mixed = False

    class Model:
        def __call__(self, tensor):
            calls.append(mixed)
            output = torch.full((1, 3, 8, 8), float('nan') if mixed or not recovers else -10.0)
            if not mixed:
                output[:, :, 4, 4] = 10.0
            return {0: output}

    # Exercise the CUDA precision policy with deterministic CPU tensors. This
    # verifies recovery behavior; it does not claim validation on CUDA hardware.
    monkeypatch.setattr(torch, 'autocast', autocast)
    monkeypatch.setattr(torch.cuda, 'get_device_name', lambda _device: 'NVIDIA GeForce RTX 3060')
    predictor = BlurBallPredictor(LoadedBlurBall(Model(), torch.device('cuda')))
    if recovers:
        for _ in range(2):
            heatmaps = predictor._infer_heatmaps(torch.zeros((1, 9, 8, 8)))
            assert np.isfinite(heatmaps).all()
            assert heatmaps[0, 0, 4, 4] > .99
        assert calls == [True, False, False]
    else:
        with pytest.raises(InferenceError, match='float32'):
            predictor._infer_heatmaps(torch.zeros((1, 9, 8, 8)))
        assert calls == [True, False]
    assert predictor.batch_size == 4
    assert 'continuing in float32' in capsys.readouterr().err


@pytest.mark.parametrize('gpu_name,expected_batch', [
    ('NVIDIA GeForce GTX 1660 SUPER', 4), ('GeForce GTX 1660 Ti', 4),
    ('NVIDIA GeForce GTX 1650', 4), ('NVIDIA GeForce GTX 1630', 4),
    ('GeForce GTX1660SUPER', 4), ('GeForce GTX 1650 Ti', 4),
    ('NVIDIA T400', 4), ('NVIDIA T550 Laptop GPU', 4), ('NVIDIA T600', 4),
    ('NVIDIA T1000 8GB', 4), ('NVIDIA T1200 Laptop GPU', 4),
    ('Quadro T2000 with Max-Q Design', 4), ('Tesla K40m', 4),
    ('NVIDIA GeForce RTX 2060', 16), ('NVIDIA GeForce RTX 4060', 16),
    ('NVIDIA GeForce RTX 4090', 16), ('NVIDIA GeForce RTX 5090', 16),
    ('NVIDIA RTX A4000', 16), ('Quadro RTX 4000', 16), ('Tesla T4', 16),
    ('NVIDIA A100-SXM4-40GB', 16), ('NVIDIA H100 80GB HBM3', 16),
    ('Quadro M2000', 16), ('NVIDIA T4000', 16),
])
def test_cuda_precision_policy_keeps_affected_models_on_gpu_in_float32(monkeypatch, gpu_name, expected_batch):
    monkeypatch.setattr(torch.cuda, 'get_device_name', lambda _device: gpu_name)
    predictor = BlurBallPredictor(LoadedBlurBall(object(), torch.device('cuda:0')))
    assert predictor.loaded.device == torch.device('cuda:0')
    assert predictor.batch_size == expected_batch
    assert predictor._mixed_precision_enabled == (expected_batch == 16)


def test_cuda_float32_batches_are_bounded_and_preserve_frame_order(monkeypatch):
    monkeypatch.setattr(torch.cuda, 'get_device_name', lambda _device: 'NVIDIA GeForce GTX 1660 SUPER')
    calls = []

    class Model:
        def __call__(self, tensor):
            calls.append(tensor.shape[0])
            return {0: tensor[:, :3]}

    predictor = BlurBallPredictor(LoadedBlurBall(Model(), torch.device('cuda')))
    tensor = torch.arange(9, dtype=torch.float32).reshape(9, 1, 1, 1).expand(9, 9, 8, 8)
    heatmaps = predictor._infer_heatmaps(tensor)
    assert calls == [4, 4, 1]
    np.testing.assert_array_equal(heatmaps, tensor[:, :3].sigmoid().numpy())


def test_cuda_precision_recovery_does_not_drop_frames_in_the_stream(monkeypatch):
    mixed = False
    batches = []

    @contextmanager
    def autocast(**_kwargs):
        nonlocal mixed
        mixed = True
        try:
            yield
        finally:
            mixed = False

    class Reader:
        def __init__(self, value):
            self.info = VideoInfo(Path(value), 96, 64, 30.0, 60, 60, 2.0)

        def __iter__(self):
            for i in range(60):
                yield FramePacket(i, i / 30, 'fps_estimation', np.zeros((64, 96, 3), np.uint8))

        def final_info(self):
            return self.info

    class Model:
        def __call__(self, tensor):
            batches.append((mixed, len(tensor)))
            logits = torch.full((len(tensor), 3, tensor.shape[2], tensor.shape[3]), float('nan') if mixed else -10.0)
            if not mixed:
                logits[:, :, tensor.shape[2] // 2, tensor.shape[3] // 2] = 10
            return {0: logits}

    # Simulate CUDA transfers only; all arithmetic in this regression uses CPU.
    tensor_to = torch.Tensor.to
    monkeypatch.setattr(torch.Tensor, 'to', lambda self, device, **kwargs:
                        self if isinstance(device, torch.device) and device.type == 'cuda'
                        else tensor_to(self, device, **kwargs))
    monkeypatch.setattr(torch, 'autocast', autocast)
    monkeypatch.setattr(torch.cuda, 'get_device_name', lambda _device: 'NVIDIA GeForce RTX 3060')
    monkeypatch.setattr(torch.cuda, 'reset_peak_memory_stats', lambda *_args: None)
    monkeypatch.setattr(torch.cuda, 'synchronize', lambda *_args: None)
    monkeypatch.setattr(torch.cuda, 'max_memory_allocated', lambda *_args: 0)
    monkeypatch.setattr('ttcut_worker.blurball_predictor.StreamingVideoReader', Reader)
    predictor = BlurBallPredictor(LoadedBlurBall(Model(), torch.device('cuda')))
    points, _, stats = predictor.predict('fake.mp4')
    assert [point.frame for point in points] == list(range(60))
    assert stats.detected_frames == 60
    assert stats.missing_frames == 0
    assert batches == [(True, 16)] + [(False, 4)] * 5


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
