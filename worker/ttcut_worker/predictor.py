from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from .errors import AnalysisRoiError, DeviceError, VideoError
from .model import LoadedTrackNet, import_torch
from .postprocess import heatmap_candidates, select_best_candidate
from .roi import AnalysisRoi, model_dimensions
from .types import TrajectoryPoint
from .video import FramePacket, StreamingVideoReader, VideoInfo

MODEL_WIDTH = 512
MODEL_HEIGHT = 288
ProgressCallback = Callable[[int, int], None]


@dataclass(frozen=True)
class PredictionStats:
    detected_frames: int
    missing_frames: int
    inference_seconds: float
    average_inference_fps: float
    model_width: int = MODEL_WIDTH
    model_height: int = MODEL_HEIGHT
    input_pixel_ratio: float = 1.0
    predictor_seconds: float = 0.0
    average_predictor_fps: float = 0.0


class TrackNetPredictor:
    def __init__(self, model: LoadedTrackNet, confidence_threshold: float = 0.5, batch_size: int = 4):
        if not 0 < confidence_threshold < 1 or batch_size < 1:
            raise ValueError("Invalid predictor options")
        self.loaded = model
        self.confidence_threshold = confidence_threshold
        self.batch_size = batch_size
        self.history: list[tuple[float, float, int]] = []
        self.miss_count = 0

    def predict(
        self,
        video_path: str | Path,
        progress_callback: ProgressCallback | None = None,
        analysis_roi: AnalysisRoi | None = None,
    ) -> tuple[list[TrajectoryPoint], VideoInfo, PredictionStats]:
        started = time.perf_counter()
        self._model_inference_seconds = 0.0
        reader = StreamingVideoReader(video_path)
        model_width, model_height = model_dimensions(
            analysis_roi, reader.info.width, reader.info.height,
        )
        median_rgb = (
            self._estimate_median(reader.info, analysis_roi, model_width, model_height)
            if self.loaded.bg_mode
            else None
        )
        sequences: list[np.ndarray] = []
        packets: list[FramePacket] = []
        input_batch: list[np.ndarray] = []
        packet_batch: list[list[FramePacket]] = []
        predictions: list[TrajectoryPoint] = []
        total = reader.info.metadata_frame_count or 0
        if progress_callback:
            progress_callback(0, total)

        for packet in reader:
            sequences.append(self._preprocess_frame(
                packet.frame_bgr,
                median_rgb,
                analysis_roi,
                model_width,
                model_height,
            ))
            packets.append(packet)
            if len(sequences) == self.loaded.seq_len:
                input_batch.append(self._assemble_sequence(sequences, median_rgb))
                packet_batch.append(packets.copy())
                sequences.clear()
                packets.clear()
            if len(input_batch) >= self.batch_size:
                predictions.extend(self._infer_batch(
                    input_batch,
                    packet_batch,
                    reader.info,
                    analysis_roi,
                    model_width,
                    model_height,
                ))
                input_batch.clear()
                packet_batch.clear()
                if progress_callback:
                    progress_callback(len(predictions), total)

        if sequences:
            actual_packets = packets.copy()
            while len(sequences) < self.loaded.seq_len:
                sequences.append(sequences[-1].copy())
            input_batch.append(self._assemble_sequence(sequences, median_rgb))
            packet_batch.append(actual_packets)
        if input_batch:
            predictions.extend(self._infer_batch(
                input_batch,
                packet_batch,
                reader.info,
                analysis_roi,
                model_width,
                model_height,
            ))
        info = reader.final_info()
        if len(predictions) != info.decoded_frame_count:
            raise VideoError("TrackNet result count does not match decoded frame count.")
        if progress_callback:
            progress_callback(len(predictions), len(predictions))
        elapsed = time.perf_counter() - started
        detected = sum(point.visibility for point in predictions)
        inference_seconds = self._model_inference_seconds
        return predictions, info, PredictionStats(
            detected, len(predictions) - detected, inference_seconds,
            len(predictions) / inference_seconds if inference_seconds else 0.0,
            model_width,
            model_height,
            (model_width * model_height) / (MODEL_WIDTH * MODEL_HEIGHT),
            elapsed,
            len(predictions) / elapsed if elapsed else 0.0,
        )

    def _estimate_median(
        self,
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        max_samples: int = 150,
    ) -> np.ndarray:
        import cv2

        capture = cv2.VideoCapture(str(info.path))
        sample_limit = max(1, min(info.metadata_frame_count or 600, int((info.fps or 30) * 20)))
        step = max(1, sample_limit // max_samples)
        samples = []
        index = 0
        try:
            while index < sample_limit and len(samples) < max_samples:
                ok, frame = capture.read()
                if not ok or frame is None:
                    break
                if index % step == 0:
                    frame = self._crop_frame(frame, analysis_roi)
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    samples.append(cv2.resize(rgb, (model_width, model_height), interpolation=cv2.INTER_LINEAR))
                index += 1
        finally:
            capture.release()
        if not samples:
            raise VideoError("Unable to estimate the TrackNet background frame.")
        return np.median(np.stack(samples), axis=0).astype(np.uint8)

    @staticmethod
    def _crop_frame(frame_bgr, analysis_roi: AnalysisRoi | None):
        if analysis_roi is None:
            return frame_bgr
        frame_height, frame_width = frame_bgr.shape[:2]
        if (
            frame_width != analysis_roi.source_width
            or frame_height != analysis_roi.source_height
        ):
            raise AnalysisRoiError(
                "The decoded frame dimensions do not match the analysis ROI.",
            )
        cropped = frame_bgr[
            analysis_roi.y0:analysis_roi.y1,
            analysis_roi.x0:analysis_roi.x1,
        ]
        if cropped.size == 0:
            raise AnalysisRoiError("The analysis ROI produced an empty frame.")
        return cropped

    def _preprocess_frame(
        self,
        frame_bgr,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> np.ndarray:
        import cv2

        cropped = self._crop_frame(frame_bgr, analysis_roi)
        rgb = cv2.resize(
            cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB),
            (model_width, model_height),
        )
        if self.loaded.bg_mode == "subtract":
            return (np.abs(rgb.astype(np.int16) - median_rgb.astype(np.int16)).sum(axis=2).astype(np.float32) / 255)[None]
        rgb_chw = rgb.transpose(2, 0, 1).astype(np.float32) / 255
        if self.loaded.bg_mode == "subtract_concat":
            diff = np.abs(rgb.astype(np.int16) - median_rgb.astype(np.int16)).sum(axis=2).astype(np.float32) / 255
            return np.concatenate([rgb_chw, diff[None]], axis=0)
        return rgb_chw

    def _assemble_sequence(self, frames: Sequence[np.ndarray], median_rgb: np.ndarray | None) -> np.ndarray:
        assembled = np.concatenate(frames, axis=0)
        if self.loaded.bg_mode == "concat":
            median = median_rgb.transpose(2, 0, 1).astype(np.float32) / 255
            assembled = np.concatenate([median, assembled], axis=0)
        return np.ascontiguousarray(assembled, dtype=np.float32)

    def _infer_batch(
        self,
        inputs: Sequence[np.ndarray],
        packet_groups: Sequence[Sequence[FramePacket]],
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> list[TrajectoryPoint]:
        torch = import_torch()
        try:
            tensor = torch.from_numpy(np.stack(inputs)).float().to(self.loaded.device)
            if self.loaded.device.type == "cuda":
                torch.cuda.synchronize(self.loaded.device)
            inference_started = time.perf_counter()
            with torch.no_grad():
                model_output = self.loaded.model(tensor)
            if self.loaded.device.type == "cuda":
                torch.cuda.synchronize(self.loaded.device)
            self._model_inference_seconds += time.perf_counter() - inference_started
            heatmaps = model_output.detach().cpu().numpy()
        except Exception as exc:
            if "out of memory" in str(exc).lower():
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                raise DeviceError("CUDA ran out of memory; use CPU mode or a smaller batch.") from exc
            raise
        output: list[TrajectoryPoint] = []
        if analysis_roi is None:
            origin_x, origin_y = 0.0, 0.0
            scale_x, scale_y = info.width / model_width, info.height / model_height
        else:
            origin_x, origin_y = float(analysis_roi.x0), float(analysis_roi.y0)
            scale_x = analysis_roi.width / model_width
            scale_y = analysis_roi.height / model_height
        for sequence_index, packets in enumerate(packet_groups):
            for offset, packet in enumerate(packets):
                raw = heatmap_candidates(heatmaps[sequence_index, offset], self.confidence_threshold)
                scaled = [{
                    **item,
                    "x": item["x"] * scale_x + origin_x, "y": item["y"] * scale_y + origin_y,
                    "w": item["w"] * scale_x, "h": item["h"] * scale_y,
                    "cx": item["cx"] * scale_x + origin_x, "cy": item["cy"] * scale_y + origin_y,
                } for item in raw]
                chosen = select_best_candidate(
                    scaled, self.history, frame_width=info.width, frame_height=info.height,
                    miss_count=self.miss_count,
                )
                if chosen is None:
                    self.miss_count += 1
                    self.history.append((0, 0, 0))
                    point = TrajectoryPoint(packet.index, packet.time, 0, 0, 0, "missing", 0, packet.time_source)
                else:
                    self.miss_count = 0
                    x, y = int(round(chosen["cx"])), int(round(chosen["cy"]))
                    self.history.append((x, y, 1))
                    point = TrajectoryPoint(
                        packet.index, packet.time, 1, x, y, "tracknet",
                        float(chosen["confidence"]), packet.time_source,
                    ).normalized(info.width, info.height)
                self.history = self.history[-8:]
                output.append(point)
        return output
