from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from .errors import DeviceError, VideoError
from .model import LoadedTrackNet, import_torch
from .postprocess import heatmap_candidates, select_best_candidate
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
        self, video_path: str | Path, progress_callback: ProgressCallback | None = None,
    ) -> tuple[list[TrajectoryPoint], VideoInfo, PredictionStats]:
        started = time.perf_counter()
        reader = StreamingVideoReader(video_path)
        median_rgb = self._estimate_median(reader.info) if self.loaded.bg_mode else None
        sequences: list[np.ndarray] = []
        packets: list[FramePacket] = []
        input_batch: list[np.ndarray] = []
        packet_batch: list[list[FramePacket]] = []
        predictions: list[TrajectoryPoint] = []
        total = reader.info.metadata_frame_count or 0
        if progress_callback:
            progress_callback(0, total)

        for packet in reader:
            sequences.append(self._preprocess_frame(packet.frame_bgr, median_rgb))
            packets.append(packet)
            if len(sequences) == self.loaded.seq_len:
                input_batch.append(self._assemble_sequence(sequences, median_rgb))
                packet_batch.append(packets.copy())
                sequences.clear()
                packets.clear()
            if len(input_batch) >= self.batch_size:
                predictions.extend(self._infer_batch(input_batch, packet_batch, reader.info))
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
            predictions.extend(self._infer_batch(input_batch, packet_batch, reader.info))
        info = reader.final_info()
        if len(predictions) != info.decoded_frame_count:
            raise VideoError("TrackNet result count does not match decoded frame count.")
        if progress_callback:
            progress_callback(len(predictions), len(predictions))
        elapsed = time.perf_counter() - started
        detected = sum(point.visibility for point in predictions)
        return predictions, info, PredictionStats(
            detected, len(predictions) - detected, elapsed,
            len(predictions) / elapsed if elapsed else 0.0,
        )

    def _estimate_median(self, info: VideoInfo, max_samples: int = 150) -> np.ndarray:
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
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    samples.append(cv2.resize(rgb, (MODEL_WIDTH, MODEL_HEIGHT), interpolation=cv2.INTER_LINEAR))
                index += 1
        finally:
            capture.release()
        if not samples:
            raise VideoError("Unable to estimate the TrackNet background frame.")
        return np.median(np.stack(samples), axis=0).astype(np.uint8)

    def _preprocess_frame(self, frame_bgr, median_rgb: np.ndarray | None) -> np.ndarray:
        import cv2

        rgb = cv2.resize(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB), (MODEL_WIDTH, MODEL_HEIGHT))
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
        self, inputs: Sequence[np.ndarray], packet_groups: Sequence[Sequence[FramePacket]], info: VideoInfo,
    ) -> list[TrajectoryPoint]:
        torch = import_torch()
        try:
            tensor = torch.from_numpy(np.stack(inputs)).float().to(self.loaded.device)
            with torch.no_grad():
                heatmaps = self.loaded.model(tensor).detach().cpu().numpy()
        except Exception as exc:
            if "out of memory" in str(exc).lower():
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                raise DeviceError("CUDA ran out of memory; use CPU mode or a smaller batch.") from exc
            raise
        output: list[TrajectoryPoint] = []
        scale_x, scale_y = info.width / MODEL_WIDTH, info.height / MODEL_HEIGHT
        for sequence_index, packets in enumerate(packet_groups):
            for offset, packet in enumerate(packets):
                raw = heatmap_candidates(heatmaps[sequence_index, offset], self.confidence_threshold)
                scaled = [{
                    **item,
                    "x": item["x"] * scale_x, "y": item["y"] * scale_y,
                    "w": item["w"] * scale_x, "h": item["h"] * scale_y,
                    "cx": item["cx"] * scale_x, "cy": item["cy"] * scale_y,
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

