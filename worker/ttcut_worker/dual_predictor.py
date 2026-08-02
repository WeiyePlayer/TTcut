from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from queue import Queue
from threading import Thread
from typing import Callable

import numpy as np
import torch

from .dual_models import LoadedDualModels
from .errors import DeviceError, VideoError
from .roi import AnalysisRoi, dual_model_dimensions
from .types import TrajectoryPoint
from .video import FramePacket, StreamingVideoReader, VideoInfo

ProgressCallback = Callable[[int, int], None]


@dataclass(frozen=True)
class DualPredictionStats:
    detected_frames: int
    missing_frames: int
    inference_seconds: float
    average_inference_fps: float
    predictor_seconds: float
    average_predictor_fps: float
    main_width: int
    main_height: int
    aux_width: int
    aux_height: int
    peak_cuda_memory_bytes: int


@dataclass(frozen=True)
class _PreparedBatch:
    main: np.ndarray
    aux: np.ndarray
    packets: tuple[FramePacket, ...]


@dataclass(frozen=True)
class _End:
    first: FramePacket | None
    last: FramePacket | None
    error: Exception | None


class UpliftingDualPredictor:
    def __init__(self, loaded: LoadedDualModels, batch_size: int = 2, consensus_pixels: float = 20.0):
        if loaded.device.type != "cuda" or batch_size != 2 or consensus_pixels <= 0:
            raise ValueError("Dual-model inference requires CUDA, batch size 2, and a positive consensus threshold.")
        self.loaded = loaded
        self.batch_size = batch_size
        self.consensus_pixels = consensus_pixels

    @staticmethod
    def _crop(frame: np.ndarray, roi: AnalysisRoi | None) -> np.ndarray:
        if roi is None:
            return frame
        if frame.shape[1] != roi.source_width or frame.shape[0] != roi.source_height:
            raise VideoError("Decoded frame dimensions changed during dual-model analysis.")
        return frame[roi.y0:roi.y1, roi.x0:roi.x1]

    @staticmethod
    def _preprocess_frame(frame: np.ndarray, size: tuple[int, int], roi: AnalysisRoi | None) -> np.ndarray:
        import cv2

        width, height = size
        mean = np.asarray([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 1, 3)
        std = np.asarray([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 1, 3)
        cropped = UpliftingDualPredictor._crop(frame, roi)
        # Uplifting trains and infers directly on OpenCV BGR frames. Its mean and
        # standard-deviation vectors are applied in that stored channel order.
        # Preserve that checkpoint contract instead of converting frames to RGB.
        resized = cv2.resize(cropped, (width, height), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
        return (((resized - mean) / std).transpose(2, 0, 1)).astype(np.float32, copy=False)

    def _producer(
        self,
        reader: StreamingVideoReader,
        roi: AnalysisRoi | None,
        main_size: tuple[int, int],
        aux_size: tuple[int, int],
        queue: Queue[_PreparedBatch | _End],
    ) -> None:
        packets: deque[FramePacket] = deque(maxlen=3)
        main_frames: deque[np.ndarray] = deque(maxlen=3)
        aux_frames: deque[np.ndarray] = deque(maxlen=3)
        main_batch: list[np.ndarray] = []
        aux_batch: list[np.ndarray] = []
        middle_packets: list[FramePacket] = []
        first: FramePacket | None = None
        last: FramePacket | None = None
        try:
            for packet in reader:
                first = first or packet
                last = packet
                packets.append(packet)
                main_frames.append(self._preprocess_frame(packet.frame_bgr, main_size, roi))
                aux_frames.append(self._preprocess_frame(packet.frame_bgr, aux_size, roi))
                if len(packets) < 3:
                    continue
                main_batch.append(np.concatenate(tuple(main_frames), axis=0))
                aux_batch.append(np.concatenate(tuple(aux_frames), axis=0))
                middle_packets.append(packets[1])
                if len(main_batch) == self.batch_size:
                    queue.put(_PreparedBatch(np.stack(main_batch), np.stack(aux_batch), tuple(middle_packets)))
                    main_batch, aux_batch, middle_packets = [], [], []
            if main_batch:
                queue.put(_PreparedBatch(np.stack(main_batch), np.stack(aux_batch), tuple(middle_packets)))
            queue.put(_End(first, last, None))
        except Exception as error:
            queue.put(_End(first, last, error))

    @staticmethod
    def _decode(heatmaps: torch.Tensor, input_size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
        if heatmaps.ndim != 4 or heatmaps.shape[1] != 1:
            raise VideoError("Dual ball model output shape is invalid.")
        flattened = heatmaps[:, 0].reshape(heatmaps.shape[0], -1)
        activation, indices = flattened.max(dim=1)
        output_height, output_width = heatmaps.shape[2:]
        x_index = indices.remainder(output_width)
        y_index = indices.div(output_width, rounding_mode="floor")
        batch_index = torch.arange(heatmaps.shape[0], device=heatmaps.device)

        def peak_offset(axis: str) -> torch.Tensor:
            if axis == "x":
                interior = (x_index > 0) & (x_index < output_width - 1)
                before = heatmaps[batch_index, 0, y_index, torch.clamp(x_index - 1, min=0)]
                after = heatmaps[batch_index, 0, y_index, torch.clamp(x_index + 1, max=output_width - 1)]
            else:
                interior = (y_index > 0) & (y_index < output_height - 1)
                before = heatmaps[batch_index, 0, torch.clamp(y_index - 1, min=0), x_index]
                after = heatmaps[batch_index, 0, torch.clamp(y_index + 1, max=output_height - 1), x_index]
            denominator = before - 2.0 * activation + after
            valid = interior & torch.isfinite(before) & torch.isfinite(after) & (denominator < -torch.finfo(heatmaps.dtype).eps)
            safe_denominator = torch.where(valid, denominator, torch.ones_like(denominator))
            offset = 0.5 * (before - after) / safe_denominator
            return torch.where(valid, offset.clamp(-0.5, 0.5), torch.zeros_like(offset))

        x = (x_index.float() + 0.5 + peak_offset("x")) * input_size[0] / output_width - 0.5
        y = (y_index.float() + 0.5 + peak_offset("y")) * input_size[1] / output_height - 0.5
        return torch.stack([x, y], dim=1).cpu().numpy(), activation.float().cpu().numpy()

    @staticmethod
    def _to_source(
        positions: np.ndarray,
        input_size: tuple[int, int],
        info: VideoInfo,
        roi: AnalysisRoi | None,
    ) -> np.ndarray:
        if roi is None:
            origin_x, origin_y, width, height = 0.0, 0.0, info.width, info.height
        else:
            origin_x, origin_y, width, height = float(roi.x0), float(roi.y0), roi.width, roi.height
        output = positions.copy()
        output[:, 0] = origin_x + (positions[:, 0] + 0.5) * width / input_size[0] - 0.5
        output[:, 1] = origin_y + (positions[:, 1] + 0.5) * height / input_size[1] - 0.5
        return output

    @staticmethod
    def _missing(packet: FramePacket) -> TrajectoryPoint:
        return TrajectoryPoint(packet.index, packet.time, 0, 0, 0, "missing", 0.0, packet.time_source)

    def predict(
        self,
        video_path: str | Path,
        progress_callback: ProgressCallback | None = None,
        analysis_roi: AnalysisRoi | None = None,
    ) -> tuple[list[TrajectoryPoint], VideoInfo, DualPredictionStats]:
        started = time.perf_counter()
        reader = StreamingVideoReader(video_path)
        main_size, aux_size = dual_model_dimensions(analysis_roi, reader.info.width, reader.info.height)
        total = reader.info.metadata_frame_count or 0
        if progress_callback:
            progress_callback(0, total)
        torch.cuda.reset_peak_memory_stats(self.loaded.device)
        queue: Queue[_PreparedBatch | _End] = Queue(maxsize=3)
        producer = Thread(
            target=self._producer,
            args=(reader, analysis_roi, main_size, aux_size, queue),
            name="ttcut-dual-preprocess",
            daemon=True,
        )
        producer.start()
        middle: list[TrajectoryPoint] = []
        inference_seconds = 0.0
        boundary: _End | None = None
        while boundary is None:
            item = queue.get()
            if isinstance(item, _End):
                boundary = item
                break
            try:
                main_input = torch.from_numpy(item.main).to(self.loaded.device, non_blocking=True)
                aux_input = torch.from_numpy(item.aux).to(self.loaded.device, non_blocking=True)
                torch.cuda.synchronize(self.loaded.device)
                inference_started = time.perf_counter()
                with torch.inference_mode():
                    main_output = self.loaded.main(main_input)[0]
                    aux_output = self.loaded.aux(aux_input)[0]
                torch.cuda.synchronize(self.loaded.device)
                inference_seconds += time.perf_counter() - inference_started
                main_positions, main_activation = self._decode(main_output, main_size)
                aux_positions, aux_activation = self._decode(aux_output, aux_size)
                main_source = self._to_source(main_positions, main_size, reader.info, analysis_roi)
                aux_source = self._to_source(aux_positions, aux_size, reader.info, analysis_roi)
                for index, packet in enumerate(item.packets):
                    dx = (main_source[index, 0] - aux_source[index, 0]) * 1920.0 / reader.info.width
                    dy = (main_source[index, 1] - aux_source[index, 1]) * 1080.0 / reader.info.height
                    if not math.isfinite(dx) or not math.isfinite(dy) or math.hypot(dx, dy) > self.consensus_pixels:
                        middle.append(self._missing(packet))
                        continue
                    x = int(round(main_source[index, 0]))
                    y = int(round(main_source[index, 1]))
                    middle.append(TrajectoryPoint(
                        packet.index, packet.time, 1, x, y, "uplifting_dual",
                        float(min(main_activation[index], aux_activation[index])), packet.time_source,
                    ).normalized(reader.info.width, reader.info.height))
                if progress_callback:
                    progress_callback(len(middle) + 1, total)
            except RuntimeError as error:
                if "out of memory" in str(error).lower():
                    torch.cuda.empty_cache()
                    raise DeviceError("CUDA ran out of memory during Uplifting dual-model inference.") from error
                raise
        producer.join()
        if boundary.error is not None:
            raise boundary.error
        info = reader.final_info()
        if boundary.first is None or boundary.last is None:
            raise VideoError("No frames were decoded for dual-model analysis.")
        if info.decoded_frame_count == 1:
            points = [self._missing(boundary.first)]
        else:
            points = [self._missing(boundary.first), *middle, self._missing(boundary.last)]
        if len(points) != info.decoded_frame_count:
            raise VideoError("Dual-model result count does not match decoded frame count.")
        if progress_callback:
            progress_callback(len(points), len(points))
        elapsed = time.perf_counter() - started
        detected = sum(point.visibility for point in points)
        return points, info, DualPredictionStats(
            detected, len(points) - detected, inference_seconds,
            len(middle) / inference_seconds if inference_seconds else 0.0,
            elapsed, len(points) / elapsed if elapsed else 0.0,
            main_size[0], main_size[1], aux_size[0], aux_size[1],
            int(torch.cuda.max_memory_allocated(self.loaded.device)),
        )
