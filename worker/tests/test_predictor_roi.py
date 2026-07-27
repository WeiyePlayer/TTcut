from __future__ import annotations

from pathlib import Path
import threading

import cv2
import numpy as np
import pytest
import torch

from ttcut_worker.model import LoadedTrackNet
from ttcut_worker.predictor import TrackNetPredictor
from ttcut_worker.roi import AnalysisRoi
from ttcut_worker.video import FramePacket, VideoInfo


class FakeReader:
    def __init__(self, value: str):
        self.info = VideoInfo(
            path=__import__("pathlib").Path(value),
            width=100,
            height=80,
            fps=30.0,
            metadata_frame_count=1,
            decoded_frame_count=None,
            duration=None,
        )
        self._packet = FramePacket(
            index=0,
            time=0.0,
            time_source="fps_estimation",
            frame_bgr=np.zeros((80, 100, 3), dtype=np.uint8),
        )

    def __iter__(self):
        yield self._packet

    def final_info(self):
        return VideoInfo(
            path=self.info.path,
            width=self.info.width,
            height=self.info.height,
            fps=self.info.fps,
            metadata_frame_count=self.info.metadata_frame_count,
            decoded_frame_count=1,
            duration=1 / 30,
            time_source_summary="fps_estimation",
        )


class BrightCenterModel:
    def __init__(self):
        self.input_shape = None

    def __call__(self, tensor):
        self.input_shape = tuple(tensor.shape)
        batch, _, height, width = tensor.shape
        output = torch.zeros((batch, 1, height, width), dtype=torch.float32, device=tensor.device)
        output[:, :, height // 2, width // 2] = 1.0
        return output


@pytest.mark.parametrize("bg_mode", ["", "concat", "subtract", "subtract_concat"])
def test_preallocated_sequence_matches_legacy_construction(bg_mode):
    loaded = LoadedTrackNet(
        model=BrightCenterModel(),
        seq_len=3,
        bg_mode=bg_mode,
        device=torch.device("cpu"),
    )
    predictor = TrackNetPredictor(loaded, batch_size=1)
    frames = [
        np.arange(48 * 64 * 3, dtype=np.uint8).reshape(48, 64, 3),
        np.full((48, 64, 3), 37, dtype=np.uint8),
        np.full((48, 64, 3), 211, dtype=np.uint8),
    ]
    median_rgb = np.full((24, 32, 3), 91, dtype=np.uint8)

    frame_channels = predictor._frame_channel_count()
    background_channels = 3 if bg_mode == "concat" else 0
    actual = np.empty(
        (background_channels + len(frames) * frame_channels, 24, 32),
        dtype=np.float32,
    )
    if background_channels:
        actual[:3] = median_rgb.transpose(2, 0, 1).astype(np.float32) / 255
    legacy_frames = []
    for index, frame in enumerate(frames):
        rgb = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), (32, 24))
        if bg_mode == "subtract":
            legacy = (
                np.abs(rgb.astype(np.int16) - median_rgb.astype(np.int16))
                .sum(axis=2)
                .astype(np.float32)
                / 255
            )[None]
        else:
            rgb_chw = rgb.transpose(2, 0, 1).astype(np.float32) / 255
            if bg_mode == "subtract_concat":
                diff = (
                    np.abs(rgb.astype(np.int16) - median_rgb.astype(np.int16))
                    .sum(axis=2)
                    .astype(np.float32)
                    / 255
                )
                legacy = np.concatenate([rgb_chw, diff[None]], axis=0)
            else:
                legacy = rgb_chw
        legacy_frames.append(legacy)
        start = background_channels + index * frame_channels
        predictor._preprocess_frame_into(
            frame,
            median_rgb,
            None,
            32,
            24,
            actual[start:start + frame_channels],
        )
    expected = np.concatenate(legacy_frames, axis=0)
    if background_channels:
        expected = np.concatenate([
            median_rgb.transpose(2, 0, 1).astype(np.float32) / 255,
            expected,
        ])

    assert actual.flags.c_contiguous
    np.testing.assert_array_equal(actual, expected)


class MultiFrameReader:
    frame_count = 43

    def __init__(self, value: str):
        self.info = VideoInfo(
            path=Path(value),
            width=32,
            height=24,
            fps=30.0,
            metadata_frame_count=self.frame_count,
            decoded_frame_count=None,
            duration=None,
        )

    def __iter__(self):
        for index in range(self.frame_count):
            yield FramePacket(
                index=index,
                time=index / 30,
                time_source="fps_estimation",
                frame_bgr=np.full((24, 32, 3), index, dtype=np.uint8),
            )

    def final_info(self):
        return VideoInfo(
            path=self.info.path,
            width=self.info.width,
            height=self.info.height,
            fps=self.info.fps,
            metadata_frame_count=self.info.metadata_frame_count,
            decoded_frame_count=self.frame_count,
            duration=self.frame_count / 30,
            time_source_summary="fps_estimation",
        )


class RecordingModel:
    def __init__(self, seq_len: int):
        self.seq_len = seq_len
        self.inputs = []

    def __call__(self, tensor):
        self.inputs.append(tensor.detach().cpu().clone())
        batch, _, height, width = tensor.shape
        return torch.zeros(
            (batch, self.seq_len, height, width),
            dtype=torch.float32,
            device=tensor.device,
        )


def test_preallocated_batch_uses_valid_slice_and_pads_only_last_sequence(monkeypatch):
    model = RecordingModel(seq_len=8)
    loaded = LoadedTrackNet(
        model=model,
        seq_len=8,
        bg_mode="",
        device=torch.device("cpu"),
    )
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", MultiFrameReader)

    points, _, _ = TrackNetPredictor(loaded, batch_size=4).predict(
        "fake.mp4",
        model_size=(32, 24),
    )

    assert len(points) == MultiFrameReader.frame_count
    assert [tuple(value.shape) for value in model.inputs] == [
        (4, 24, 24, 32),
        (2, 24, 24, 32),
    ]
    final_sequence = model.inputs[1][1].numpy().reshape(8, 3, 24, 32)
    for frame_index in range(3):
        expected = np.float32((42 - frame_index) / 255)
        assert final_sequence[2 - frame_index, 0, 0, 0] == expected
    np.testing.assert_array_equal(
        final_sequence[3:],
        np.repeat(final_sequence[2:3], 5, axis=0),
    )


@pytest.mark.parametrize(
    ("frame_count", "valid_sequences"),
    [(1, 1), (9, 2), (17, 3)],
)
def test_preallocated_final_batch_passes_only_valid_sequences(
    monkeypatch,
    frame_count,
    valid_sequences,
):
    class PartialReader(MultiFrameReader):
        pass

    PartialReader.frame_count = frame_count
    model = RecordingModel(seq_len=8)
    loaded = LoadedTrackNet(
        model=model,
        seq_len=8,
        bg_mode="",
        device=torch.device("cpu"),
    )
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", PartialReader)

    TrackNetPredictor(loaded, batch_size=4).predict(
        "fake.mp4",
        model_size=(32, 24),
    )

    assert [len(value) for value in model.inputs] == [valid_sequences]


def test_cpu_predictor_never_starts_cuda_pipeline(monkeypatch):
    model = RecordingModel(seq_len=8)
    loaded = LoadedTrackNet(
        model=model,
        seq_len=8,
        bg_mode="",
        device=torch.device("cpu"),
    )
    predictor = TrackNetPredictor(loaded, batch_size=4)
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", MultiFrameReader)
    monkeypatch.setattr(
        predictor,
        "_predict_cuda_pipeline",
        lambda *_args: pytest.fail("CPU mode started the CUDA pipeline"),
    )

    points, _, _ = predictor.predict("fake.mp4", model_size=(32, 24))

    assert len(points) == MultiFrameReader.frame_count


def _cuda_predictor_with_fake_inference(monkeypatch):
    loaded = LoadedTrackNet(
        model=None,
        seq_len=8,
        bg_mode="",
        device=torch.device("cuda"),
    )
    predictor = TrackNetPredictor(loaded, batch_size=4)
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", MultiFrameReader)
    monkeypatch.setattr(
        predictor,
        "_create_pinned_cuda_resources",
        lambda *_args: (_ for _ in ()).throw(MemoryError("pinned unavailable")),
    )
    monkeypatch.setattr(
        predictor,
        "_run_model_batch",
        lambda inputs: np.zeros(
            (len(inputs), loaded.seq_len, inputs.shape[2], inputs.shape[3]),
            dtype=np.float32,
        ),
    )
    return predictor


def test_cuda_pipeline_falls_back_when_pinned_pool_cannot_be_allocated(monkeypatch):
    predictor = _cuda_predictor_with_fake_inference(monkeypatch)

    points, _, _ = predictor.predict("fake.mp4", model_size=(32, 24))

    assert len(points) == MultiFrameReader.frame_count
    assert predictor._cuda_pipeline_mode == "pageable_sync"


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA is unavailable")
def test_pinned_cuda_resources_are_persistent_and_reusable(monkeypatch):
    class ZeroCudaModel:
        def __call__(self, tensor):
            return torch.zeros(
                (len(tensor), 8, tensor.shape[2], tensor.shape[3]),
                dtype=torch.float32,
                device=tensor.device,
            )

    loaded = LoadedTrackNet(
        model=ZeroCudaModel(),
        seq_len=8,
        bg_mode="",
        device=torch.device("cuda"),
    )
    predictor = TrackNetPredictor(loaded, batch_size=4)
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", MultiFrameReader)

    first, _, _ = predictor.predict("first.mp4", model_size=(32, 24))
    second, _, _ = predictor.predict("second.mp4", model_size=(32, 24))

    assert len(first) == len(second) == MultiFrameReader.frame_count
    assert predictor._cuda_pipeline_mode == "pinned_async"
    assert not [
        thread for thread in threading.enumerate()
        if thread.name.startswith("ttcut-tracknet-")
    ]


def test_cuda_pipeline_is_ordered_bounded_and_reports_postprocessed_progress(monkeypatch):
    predictor = _cuda_predictor_with_fake_inference(monkeypatch)
    observed_queue_sizes = []
    original_queue_put = predictor._queue_put

    def recording_queue_put(queue, value, stop_event):
        result = original_queue_put(queue, value, stop_event)
        observed_queue_sizes.append((queue.maxsize, queue.qsize()))
        return result

    monkeypatch.setattr(predictor, "_queue_put", recording_queue_put)
    progress = []

    points, _, _ = predictor.predict(
        "fake.mp4",
        model_size=(32, 24),
        progress_callback=lambda completed, total: progress.append((completed, total)),
    )

    assert [point.frame for point in points] == list(range(MultiFrameReader.frame_count))
    assert all(size <= capacity for capacity, size in observed_queue_sizes)
    assert [value[0] for value in progress] == sorted(value[0] for value in progress)
    assert progress[-1] == (MultiFrameReader.frame_count, MultiFrameReader.frame_count)
    assert not [
        thread for thread in threading.enumerate()
        if thread.name.startswith("ttcut-tracknet-")
    ]


@pytest.mark.parametrize("failure_stage", ["producer", "gpu", "postprocessor"])
def test_cuda_pipeline_propagates_first_error_and_joins_threads(monkeypatch, failure_stage):
    predictor = _cuda_predictor_with_fake_inference(monkeypatch)
    expected = RuntimeError(f"{failure_stage} failed")

    def fail(*_args, **_kwargs):
        raise expected

    if failure_stage == "producer":
        monkeypatch.setattr(predictor, "_preprocess_frame_into", fail)
    elif failure_stage == "gpu":
        monkeypatch.setattr(predictor, "_run_model_batch", fail)
    else:
        monkeypatch.setattr(predictor, "_postprocess_batch", fail)

    with pytest.raises(RuntimeError) as error:
        predictor.predict("fake.mp4", model_size=(32, 24))

    assert error.value is expected
    assert not [
        thread for thread in threading.enumerate()
        if thread.name.startswith("ttcut-tracknet-")
    ]


def test_cuda_out_of_memory_keeps_device_error_classification(monkeypatch):
    predictor = _cuda_predictor_with_fake_inference(monkeypatch)

    with pytest.raises(Exception) as error:
        predictor._raise_device_error(RuntimeError("CUDA out of memory"))

    assert getattr(error.value, "code", None) == "DEVICE_UNAVAILABLE"


def test_predictor_uses_dynamic_roi_tensor_and_returns_source_coordinates(monkeypatch):
    model = BrightCenterModel()
    loaded = LoadedTrackNet(
        model=model,
        seq_len=1,
        bg_mode="",
        device=torch.device("cpu"),
    )
    roi = AnalysisRoi(
        x0=10,
        y0=20,
        x1=60,
        y1=60,
        projected_polygon=((10.0, 20.0), (60.0, 20.0), (60.0, 60.0), (10.0, 60.0)),
        top_padding_pixels=0.0,
        source_width=100,
        source_height=80,
    )
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", FakeReader)

    points, _, stats = TrackNetPredictor(loaded, batch_size=1).predict(
        "fake.mp4",
        analysis_roi=roi,
    )

    assert model.input_shape == (1, 3, 184, 320)
    assert points[0].visibility == 1
    assert (points[0].x, points[0].y) == (35, 40)
    assert stats.model_width == 320
    assert stats.model_height == 184
    assert stats.input_pixel_ratio == pytest.approx(320 * 184 / (512 * 288))
    assert stats.inference_seconds > 0
    assert stats.predictor_seconds >= stats.inference_seconds
    assert stats.average_predictor_fps > 0


def test_predictor_rejects_roi_from_different_source_dimensions(monkeypatch):
    loaded = LoadedTrackNet(
        model=BrightCenterModel(),
        seq_len=1,
        bg_mode="",
        device=torch.device("cpu"),
    )
    roi = AnalysisRoi(
        x0=10,
        y0=20,
        x1=60,
        y1=60,
        projected_polygon=((10.0, 20.0), (60.0, 20.0), (60.0, 60.0), (10.0, 60.0)),
        top_padding_pixels=0.0,
        source_width=200,
        source_height=160,
    )
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", FakeReader)

    with pytest.raises(Exception) as error:
        TrackNetPredictor(loaded, batch_size=1).predict("fake.mp4", analysis_roi=roi)

    assert getattr(error.value, "code", None) == "ANALYSIS_ROI_FAILED"


def test_predictor_accepts_explicit_stride_aligned_roi_model_size(monkeypatch):
    model = BrightCenterModel()
    loaded = LoadedTrackNet(
        model=model,
        seq_len=1,
        bg_mode="",
        device=torch.device("cpu"),
    )
    roi = AnalysisRoi(
        x0=10,
        y0=20,
        x1=60,
        y1=60,
        projected_polygon=((10.0, 20.0), (60.0, 20.0), (60.0, 60.0), (10.0, 60.0)),
        top_padding_pixels=0.0,
        source_width=100,
        source_height=80,
    )
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", FakeReader)

    points, _, stats = TrackNetPredictor(loaded, batch_size=1).predict(
        "fake.mp4",
        analysis_roi=roi,
        model_size=(280, 160),
    )

    assert model.input_shape == (1, 3, 160, 280)
    assert (points[0].x, points[0].y) == (35, 40)
    assert (stats.model_width, stats.model_height) == (280, 160)


def test_predictor_rejects_model_size_not_aligned_to_stride(monkeypatch):
    loaded = LoadedTrackNet(
        model=BrightCenterModel(),
        seq_len=1,
        bg_mode="",
        device=torch.device("cpu"),
    )
    roi = AnalysisRoi(
        x0=10,
        y0=20,
        x1=60,
        y1=60,
        projected_polygon=((10.0, 20.0), (60.0, 20.0), (60.0, 60.0), (10.0, 60.0)),
        top_padding_pixels=0.0,
        source_width=100,
        source_height=80,
    )
    monkeypatch.setattr("ttcut_worker.predictor.StreamingVideoReader", FakeReader)

    with pytest.raises(Exception) as error:
        TrackNetPredictor(loaded, batch_size=1).predict(
            "fake.mp4",
            analysis_roi=roi,
            model_size=(281, 160),
        )

    assert getattr(error.value, "code", None) == "ANALYSIS_ROI_FAILED"
