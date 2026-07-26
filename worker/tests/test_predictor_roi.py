from __future__ import annotations

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
