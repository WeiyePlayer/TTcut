from __future__ import annotations

import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np
import torch

from .blurball_models import LoadedBlurBall
from .errors import DeviceError, VideoError
from .roi import AnalysisRoi, model_dimensions
from .types import TrajectoryPoint
from .video import FramePacket, StreamingVideoReader, VideoInfo


BLURBALL_INPUT_WIDTH = 512
BLURBALL_INPUT_HEIGHT = 288
BLURBALL_CONFIDENCE_THRESHOLD = 0.7
BLURBALL_STEP = 3
BLURBALL_MAX_DISPLACEMENT_PIXELS = 100.0
BLURBALL_BATCH_SIZE = 16
BLURBALL_CPU_BATCH_SIZE = 4
_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)[:, None, None]
_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)[:, None, None]


@dataclass(frozen=True)
class BlurBallPredictionStats:
    detected_frames: int
    missing_frames: int
    inference_seconds: float
    average_inference_fps: float
    predictor_seconds: float
    average_predictor_fps: float
    model_width: int = BLURBALL_INPUT_WIDTH
    model_height: int = BLURBALL_INPUT_HEIGHT
    confidence_threshold: float = BLURBALL_CONFIDENCE_THRESHOLD
    step: int = BLURBALL_STEP
    maximum_displacement_pixels: float = BLURBALL_MAX_DISPLACEMENT_PIXELS
    peak_cuda_memory_bytes: int = 0


@dataclass(frozen=True)
class _PreparedWindow:
    input: np.ndarray
    packets: tuple[FramePacket, ...]


class _OnlineTracker:
    def __init__(self, maximum_displacement_pixels: float):
        self.maximum_displacement_pixels = maximum_displacement_pixels
        self.previous: tuple[float, float] | None = None

    def update(self, detections: Sequence[tuple[float, float, float]]) -> tuple[float, float, float] | None:
        candidates = detections
        if self.previous is not None:
            previous_x, previous_y = self.previous
            candidates = tuple(
                detection for detection in detections
                if math.hypot(detection[0] - previous_x, detection[1] - previous_y)
                < self.maximum_displacement_pixels
            )
        if not candidates:
            self.previous = None
            return None
        selected = max(candidates, key=lambda detection: detection[2])
        self.previous = selected[0], selected[1]
        return selected


def _affine_transforms(
    width: int,
    height: int,
    input_width: int = BLURBALL_INPUT_WIDTH,
    input_height: int = BLURBALL_INPUT_HEIGHT,
) -> tuple[np.ndarray, np.ndarray]:
    import cv2

    center = np.asarray([width / 2.0, height / 2.0], dtype=np.float32)
    scale = float(max(width, height))
    source_direction = np.asarray([0.0, scale * -0.5], dtype=np.float32)
    destination_center = np.asarray(
        [input_width * 0.5, input_height * 0.5],
        dtype=np.float32,
    )
    destination_direction = np.asarray([0.0, input_width * -0.5], dtype=np.float32)

    def third(first: np.ndarray, second: np.ndarray) -> np.ndarray:
        direction = first - second
        return second + np.asarray([-direction[1], direction[0]], dtype=np.float32)

    source = np.stack([center, center + source_direction, third(center, center + source_direction)])
    destination = np.stack([
        destination_center,
        destination_center + destination_direction,
        third(destination_center, destination_center + destination_direction),
    ])
    return (
        cv2.getAffineTransform(source.astype(np.float32), destination.astype(np.float32)),
        cv2.getAffineTransform(destination.astype(np.float32), source.astype(np.float32)),
    )


def _prepare_frame(
    frame: np.ndarray,
    transform: np.ndarray,
    input_width: int,
    input_height: int,
) -> np.ndarray:
    import cv2

    warped = cv2.warpAffine(
        frame,
        transform,
        (input_width, input_height),
        flags=cv2.INTER_LINEAR,
    )
    channels = np.ascontiguousarray(warped.transpose(2, 0, 1), dtype=np.float32) / 255.0
    return (channels - _MEAN) / _STD


def _decode_heatmap(
    heatmap: np.ndarray,
    model_to_roi: np.ndarray,
    origin_x: int,
    origin_y: int,
) -> tuple[tuple[float, float, float], ...]:
    import cv2

    if heatmap.ndim != 2 or not np.isfinite(heatmap).all() or float(np.max(heatmap)) <= BLURBALL_CONFIDENCE_THRESHOLD:
        return ()
    _, thresholded = cv2.threshold(
        heatmap,
        BLURBALL_CONFIDENCE_THRESHOLD,
        1,
        cv2.THRESH_BINARY,
    )
    label_count, labels = cv2.connectedComponents(thresholded.astype(np.uint8))
    detections: list[tuple[float, float, float]] = []
    for label in range(1, label_count):
        ys, xs = np.where(labels == label)
        if not len(xs):
            continue
        weights = heatmap[ys, xs]
        weight_sum = float(np.sum(weights))
        if not math.isfinite(weight_sum) or weight_sum <= 0:
            continue
        model_x = float(np.sum(xs * weights) / weight_sum)
        model_y = float(np.sum(ys * weights) / weight_sum)
        local_x, local_y = model_to_roi @ np.asarray([model_x, model_y, 1.0], dtype=np.float64)
        if all(math.isfinite(value) for value in (local_x, local_y)):
            detections.append((float(local_x + origin_x), float(local_y + origin_y), weight_sum))
    return tuple(detections)


class BlurBallPredictor:
    def __init__(self, loaded: LoadedBlurBall, batch_size: int | None = None):
        if loaded.device.type not in {"cpu", "cuda"}:
            raise ValueError("BlurBall inference requires a CPU or CUDA device.")
        if batch_size is None:
            batch_size = BLURBALL_CPU_BATCH_SIZE if loaded.device.type == "cpu" else BLURBALL_BATCH_SIZE
        if batch_size <= 0:
            raise ValueError("BlurBall inference requires a positive batch size.")
        self.loaded = loaded
        self.batch_size = batch_size

    @staticmethod
    def _window(
        packets: list[FramePacket],
        transform: np.ndarray,
        roi: AnalysisRoi | None,
        input_width: int,
        input_height: int,
    ) -> _PreparedWindow:
        if not packets or len(packets) > BLURBALL_STEP:
            raise ValueError("BlurBall windows contain one to three frames.")
        frames = []
        for packet in packets:
            frame = packet.frame_bgr
            if roi is not None:
                frame = frame[roi.y0:roi.y1, roi.x0:roi.x1]
            frames.append(_prepare_frame(frame, transform, input_width, input_height))
        while len(frames) < BLURBALL_STEP:
            frames.append(frames[-1])
        return _PreparedWindow(np.concatenate(frames, axis=0), tuple(packets))

    def predict(
        self,
        video_path: str | Path,
        progress_callback=None,
        analysis_roi: AnalysisRoi | None = None,
    ) -> tuple[list[TrajectoryPoint], VideoInfo, BlurBallPredictionStats]:
        started = time.perf_counter()
        reader = StreamingVideoReader(video_path)
        if analysis_roi is not None and (
            analysis_roi.source_width != reader.info.width
            or analysis_roi.source_height != reader.info.height
        ):
            raise VideoError("The BlurBall analysis ROI dimensions do not match the video.")
        roi_width = analysis_roi.width if analysis_roi is not None else reader.info.width
        roi_height = analysis_roi.height if analysis_roi is not None else reader.info.height
        if roi_width <= 0 or roi_height <= 0:
            raise VideoError("The BlurBall analysis ROI is empty.")
        input_width, input_height = model_dimensions(
            analysis_roi,
            reader.info.width,
            reader.info.height,
        )
        source_to_model, model_to_roi = _affine_transforms(
            roi_width,
            roi_height,
            input_width,
            input_height,
        )
        origin_x = analysis_roi.x0 if analysis_roi is not None else 0
        origin_y = analysis_roi.y0 if analysis_roi is not None else 0
        total = reader.info.metadata_frame_count or 0
        if progress_callback:
            progress_callback(0, total)
        is_cuda = self.loaded.device.type == "cuda"
        if is_cuda:
            torch.cuda.reset_peak_memory_stats(self.loaded.device)
        tracker = _OnlineTracker(BLURBALL_MAX_DISPLACEMENT_PIXELS)
        points: list[TrajectoryPoint] = []
        windows: list[_PreparedWindow] = []
        packets: list[FramePacket] = []
        inference_seconds = 0.0

        def run_batch() -> None:
            nonlocal inference_seconds
            if not windows:
                return
            inputs = np.stack([window.input for window in windows])
            tensor = torch.from_numpy(inputs).to(self.loaded.device, non_blocking=is_cuda)
            try:
                if is_cuda:
                    torch.cuda.synchronize(self.loaded.device)
                inference_started = time.perf_counter()
                if is_cuda:
                    with torch.inference_mode(), torch.autocast(
                        device_type="cuda",
                        dtype=torch.float16,
                    ):
                        output = self.loaded.model(tensor)[0].sigmoid()
                    torch.cuda.synchronize(self.loaded.device)
                else:
                    with torch.inference_mode():
                        output = self.loaded.model(tensor)[0].sigmoid()
                inference_seconds += time.perf_counter() - inference_started
                heatmaps = output.float().cpu().numpy()
            except RuntimeError as error:
                if is_cuda and "out of memory" in str(error).lower():
                    torch.cuda.empty_cache()
                    raise DeviceError("CUDA ran out of memory during BlurBall inference.") from error
                raise
            for window_index, window in enumerate(windows):
                for output_index, packet in enumerate(window.packets):
                    detections = _decode_heatmap(
                        heatmaps[window_index, output_index],
                        model_to_roi,
                        origin_x,
                        origin_y,
                    )
                    selected = tracker.update(detections)
                    if selected is None:
                        points.append(TrajectoryPoint(
                            packet.index, packet.time, 0, 0, 0, "missing", 0.0, packet.time_source,
                        ))
                    else:
                        x, y, score = selected
                        points.append(TrajectoryPoint(
                            packet.index, packet.time, 1, int(round(x)), int(round(y)),
                            "blurball", float(score), packet.time_source,
                        ).normalized(reader.info.width, reader.info.height))
            windows.clear()
            if progress_callback:
                progress_callback(len(points), total)

        for packet in reader:
            packets.append(packet)
            if len(packets) == BLURBALL_STEP:
                windows.append(self._window(
                    packets,
                    source_to_model,
                    analysis_roi,
                    input_width,
                    input_height,
                ))
                packets = []
                if len(windows) == self.batch_size:
                    run_batch()
        if packets:
            windows.append(self._window(
                packets,
                source_to_model,
                analysis_roi,
                input_width,
                input_height,
            ))
        run_batch()
        info = reader.final_info()
        if len(points) != info.decoded_frame_count:
            raise VideoError("BlurBall result count does not match decoded frame count.")
        if progress_callback:
            progress_callback(len(points), len(points))
        elapsed = time.perf_counter() - started
        detected = sum(point.visibility for point in points)
        return points, info, BlurBallPredictionStats(
            detected_frames=detected,
            missing_frames=len(points) - detected,
            inference_seconds=inference_seconds,
            average_inference_fps=len(points) / inference_seconds if inference_seconds else 0.0,
            predictor_seconds=elapsed,
            average_predictor_fps=len(points) / elapsed if elapsed else 0.0,
            model_width=input_width,
            model_height=input_height,
            peak_cuda_memory_bytes=(
                int(torch.cuda.max_memory_allocated(self.loaded.device)) if is_cuda else 0
            ),
        )
