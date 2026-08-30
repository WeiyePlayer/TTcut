from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from .errors import AnalysisRoiError, DeviceError, VideoError
from .roi import AnalysisRoi, model_dimensions
from .tracknet_model import LoadedTrackNet, import_torch
from .tracknet_postprocess import heatmap_candidates, select_best_candidate
from .types import TrajectoryPoint
from .video import FramePacket, StreamingVideoReader, VideoInfo


MODEL_WIDTH = 512
MODEL_HEIGHT = 288
TRACKNET_CONFIDENCE_THRESHOLD = 0.35
TRACKNET_ROI_MODEL_SCALE = 1.0
ProgressCallback = Callable[[int, int], None]


@dataclass(frozen=True)
class TrackNetPredictionStats:
    detected_frames: int
    missing_frames: int
    inference_seconds: float
    average_inference_fps: float
    predictor_seconds: float
    average_predictor_fps: float
    model_width: int
    model_height: int
    confidence_threshold: float
    roi_model_scale: float


def _cv2():
    try:
        import cv2
    except ImportError as exc:
        raise VideoError("OpenCV is not installed.") from exc
    return cv2


class TrackNetPredictor:
    """Serial local-test adapter for the historical TrackNet checkpoint.

    It deliberately keeps the decoded frame sequence complete. The model receives
    padded final windows, but only output points belonging to real frames are
    returned, preserving source frame indexes and timestamps for post-processing.
    """

    def __init__(
        self,
        loaded: LoadedTrackNet,
        confidence_threshold: float = TRACKNET_CONFIDENCE_THRESHOLD,
        roi_model_scale: float = TRACKNET_ROI_MODEL_SCALE,
    ):
        if not 0 < confidence_threshold < 1:
            raise ValueError("TrackNet confidence threshold must be between zero and one.")
        if not np.isfinite(roi_model_scale) or roi_model_scale <= 0:
            raise ValueError("TrackNet ROI model scale must be finite and positive.")
        self.loaded = loaded
        self.confidence_threshold = confidence_threshold
        self.roi_model_scale = float(roi_model_scale)
        self._model_history: list[tuple[float, float, int]] = []
        self._miss_count = 0
        self._inference_seconds = 0.0

    def predict(
        self,
        video_path: str | Path,
        progress_callback: ProgressCallback | None = None,
        analysis_roi: AnalysisRoi | None = None,
    ) -> tuple[list[TrajectoryPoint], VideoInfo, TrackNetPredictionStats]:
        predictor_started = time.perf_counter()
        self._model_history.clear()
        self._miss_count = 0
        self._inference_seconds = 0.0
        reader = StreamingVideoReader(video_path)
        model_width, model_height = model_dimensions(
            analysis_roi,
            reader.info.width,
            reader.info.height,
            scale=self.roi_model_scale,
        )
        if model_width <= 0 or model_height <= 0 or model_width % 8 or model_height % 8:
            raise AnalysisRoiError("TrackNet model dimensions must be positive and aligned to eight pixels.")
        background = self._estimate_background(reader.info, analysis_roi, model_width, model_height)
        total = reader.info.metadata_frame_count or 0
        if progress_callback:
            progress_callback(0, total)

        points: list[TrajectoryPoint] = []
        frames: list[np.ndarray] = []
        packets: list[FramePacket] = []
        for packet in reader:
            frames.append(self._prepare_frame(packet.frame_bgr, analysis_roi, model_width, model_height))
            packets.append(packet)
            if len(frames) == self.loaded.seq_len:
                points.extend(self._predict_window(frames, packets, background, reader.info, analysis_roi))
                if progress_callback:
                    progress_callback(len(points), total)
                frames.clear()
                packets.clear()
        if frames:
            padded = frames + [frames[-1]] * (self.loaded.seq_len - len(frames))
            points.extend(self._predict_window(padded, packets, background, reader.info, analysis_roi))
        info = reader.final_info()
        if len(points) != info.decoded_frame_count:
            raise VideoError("TrackNet result count does not match decoded frame count.")
        if progress_callback:
            progress_callback(len(points), len(points))
        detected = sum(point.visibility for point in points)
        predictor_seconds = time.perf_counter() - predictor_started
        return points, info, TrackNetPredictionStats(
            detected_frames=detected,
            missing_frames=len(points) - detected,
            inference_seconds=self._inference_seconds,
            average_inference_fps=len(points) / self._inference_seconds if self._inference_seconds else 0.0,
            predictor_seconds=predictor_seconds,
            average_predictor_fps=len(points) / predictor_seconds if predictor_seconds else 0.0,
            model_width=model_width,
            model_height=model_height,
            confidence_threshold=self.confidence_threshold,
            roi_model_scale=self.roi_model_scale,
        )

    def _estimate_background(
        self,
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> np.ndarray | None:
        if not self.loaded.bg_mode:
            return None
        cv2 = _cv2()
        capture = cv2.VideoCapture(str(info.path))
        if not capture.isOpened():
            capture.release()
            raise VideoError("The video cannot be reopened for TrackNet background sampling.")
        frame_count = max(1, int(info.metadata_frame_count or 1))
        sample_indexes = sorted({round(index * (frame_count - 1) / 7) for index in range(8)})
        samples: list[np.ndarray] = []
        try:
            for index in sample_indexes:
                capture.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, frame = capture.read()
                if ok and frame is not None:
                    samples.append(self._prepare_frame(frame, analysis_roi, model_width, model_height))
        finally:
            capture.release()
        if not samples:
            raise VideoError("TrackNet background sampling decoded no frames.")
        return np.median(np.stack(samples, axis=0), axis=0).astype(np.float32) / 255.0

    def _prepare_frame(
        self,
        frame_bgr: object,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> np.ndarray:
        cv2 = _cv2()
        frame = np.asarray(frame_bgr)
        if frame.ndim != 3 or frame.shape[2] < 3:
            raise VideoError("TrackNet received an invalid decoded frame.")
        if analysis_roi is not None:
            frame = frame[analysis_roi.y0:analysis_roi.y1, analysis_roi.x0:analysis_roi.x1]
        if frame.size == 0:
            raise AnalysisRoiError("TrackNet analysis ROI is empty in a decoded frame.")
        resized = cv2.resize(frame, (model_width, model_height), interpolation=cv2.INTER_LINEAR)
        return cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)

    def _model_input(self, frames: list[np.ndarray], background: np.ndarray | None) -> np.ndarray:
        normalized = [frame.astype(np.float32).transpose(2, 0, 1) / 255.0 for frame in frames]
        if self.loaded.bg_mode in ("", None):
            channels = normalized
        else:
            if background is None:
                raise VideoError("TrackNet background frame is unavailable.")
            background_chw = background.transpose(2, 0, 1)
            if self.loaded.bg_mode == "concat":
                channels = [background_chw, *normalized]
            else:
                differences = [
                    np.mean(frame - background_chw, axis=0, keepdims=True)
                    for frame in normalized
                ]
                channels = differences if self.loaded.bg_mode == "subtract" else [
                    channel for frame, difference in zip(normalized, differences) for channel in (frame, difference)
                ]
        result = np.concatenate(channels, axis=0)[None, ...]
        expected_channels = (self.loaded.seq_len + 1) * 3 if self.loaded.bg_mode == "concat" else (
            self.loaded.seq_len if self.loaded.bg_mode == "subtract" else (
                self.loaded.seq_len * 4 if self.loaded.bg_mode == "subtract_concat" else self.loaded.seq_len * 3
            )
        )
        if result.shape[1] != expected_channels:
            raise VideoError("TrackNet checkpoint and input sequence channels do not match.")
        return np.ascontiguousarray(result, dtype=np.float32)

    def _predict_window(
        self,
        frames: list[np.ndarray],
        packets: list[FramePacket],
        background: np.ndarray | None,
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
    ) -> list[TrajectoryPoint]:
        torch = import_torch()
        started = time.perf_counter()
        try:
            input_tensor = torch.from_numpy(self._model_input(frames, background)).to(self.loaded.device)
            with torch.no_grad():
                heatmaps = self.loaded.model(input_tensor).detach().to("cpu").numpy()[0]
            if self.loaded.device.type == "cuda":
                torch.cuda.synchronize(self.loaded.device)
        except RuntimeError as exc:
            if self.loaded.device.type == "cuda":
                raise DeviceError("TrackNet local test inference failed on CUDA.") from exc
            raise
        self._inference_seconds += time.perf_counter() - started
        if heatmaps.shape[0] != self.loaded.seq_len:
            raise VideoError("TrackNet emitted an invalid output sequence.")
        points: list[TrajectoryPoint] = []
        model_height, model_width = heatmaps.shape[1:]
        for heatmap, packet in zip(heatmaps, packets):
            candidate = select_best_candidate(
                heatmap_candidates(heatmap, self.confidence_threshold),
                self._model_history,
                frame_width=model_width,
                frame_height=model_height,
                miss_count=self._miss_count,
            )
            if candidate is None:
                self._model_history.append((0.0, 0.0, 0))
                self._model_history = self._model_history[-8:]
                self._miss_count += 1
                points.append(TrajectoryPoint(packet.index, packet.time, 0, 0, 0, "missing", 0.0, packet.time_source))
                continue
            source_x, source_y = self._source_coordinates(candidate["cx"], candidate["cy"], info, analysis_roi, model_width, model_height)
            self._model_history.append((candidate["cx"], candidate["cy"], 1))
            self._model_history = self._model_history[-8:]
            self._miss_count = 0
            points.append(TrajectoryPoint(
                packet.index,
                packet.time,
                1,
                source_x,
                source_y,
                "tracknet",
                float(candidate["confidence"]),
                packet.time_source,
            ).normalized(info.width, info.height))
        return points

    @staticmethod
    def _source_coordinates(
        x: float,
        y: float,
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> tuple[int, int]:
        if analysis_roi is None:
            return round(x * info.width / model_width), round(y * info.height / model_height)
        return (
            round(analysis_roi.x0 + x * analysis_roi.width / model_width),
            round(analysis_roi.y0 + y * analysis_roi.height / model_height),
        )
