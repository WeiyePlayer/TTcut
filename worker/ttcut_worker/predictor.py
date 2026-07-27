from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from queue import Empty, Full, Queue
from threading import Event, Thread
from typing import Any, Callable, Sequence

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


@dataclass
class _BatchSlot:
    input_buffer: np.ndarray
    input_tensor: Any | None = None
    output_tensor: Any | None = None
    input_ready: Any | None = None
    inference_started: Any | None = None
    inference_finished: Any | None = None
    result_ready: Any | None = None
    gpu_output: Any | None = None
    ordinal: int = -1
    valid_sequence_count: int = 0
    packet_groups: list[list[FramePacket]] = field(default_factory=list)
    heatmaps: np.ndarray | None = None
    state: str = "FREE"


@dataclass
class _CudaPipelineResources:
    h2d_stream: Any
    compute_stream: Any
    device_inputs: list[Any]
    device_compute_done: list[Any | None]


_END_OF_STREAM = object()


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
        model_size: tuple[int, int] | None = None,
    ) -> tuple[list[TrajectoryPoint], VideoInfo, PredictionStats]:
        started = time.perf_counter()
        self._model_inference_seconds = 0.0
        reader = StreamingVideoReader(video_path)
        default_model_width, default_model_height = model_dimensions(
            analysis_roi, reader.info.width, reader.info.height,
        )
        model_width, model_height = model_size or (
            default_model_width,
            default_model_height,
        )
        if (
            model_width <= 0
            or model_height <= 0
            or model_width % 8
            or model_height % 8
        ):
            raise AnalysisRoiError(
                "TrackNet model dimensions must be positive and aligned to 8 pixels.",
            )
        median_rgb = (
            self._estimate_median(reader.info, analysis_roi, model_width, model_height)
            if self.loaded.bg_mode
            else None
        )
        total = reader.info.metadata_frame_count or 0
        if progress_callback:
            progress_callback(0, total)
        if self.loaded.device.type == "cuda":
            predictions = self._predict_cuda_pipeline(
                reader,
                median_rgb,
                analysis_roi,
                model_width,
                model_height,
                progress_callback,
                total,
            )
        else:
            predictions = self._predict_serial(
                reader,
                median_rgb,
                analysis_roi,
                model_width,
                model_height,
                progress_callback,
                total,
            )
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

    def _create_input_buffer(
        self,
        median_rgb: np.ndarray | None,
        model_width: int,
        model_height: int,
    ) -> np.ndarray:
        buffer = np.empty(
            self._input_buffer_shape(model_width, model_height),
            dtype=np.float32,
        )
        self._initialize_background(buffer, median_rgb)
        return buffer

    def _input_buffer_shape(
        self,
        model_width: int,
        model_height: int,
    ) -> tuple[int, int, int, int]:
        frame_channels = self._frame_channel_count()
        background_channels = 3 if self.loaded.bg_mode == "concat" else 0
        sequence_channels = background_channels + self.loaded.seq_len * frame_channels
        return self.batch_size, sequence_channels, model_height, model_width

    def _initialize_background(
        self,
        buffer: np.ndarray,
        median_rgb: np.ndarray | None,
    ) -> None:
        background_channels = 3 if self.loaded.bg_mode == "concat" else 0
        if background_channels:
            if median_rgb is None:
                raise VideoError("TrackNet background frame is unavailable.")
            buffer[:, :background_channels] = (
                median_rgb.transpose(2, 0, 1).astype(np.float32) / 255
            )

    def _create_pinned_cuda_resources(
        self,
        median_rgb: np.ndarray | None,
        model_width: int,
        model_height: int,
    ) -> tuple[list[_BatchSlot], _CudaPipelineResources]:
        torch = import_torch()
        input_shape = self._input_buffer_shape(model_width, model_height)
        output_shape = (
            self.batch_size,
            self.loaded.seq_len,
            model_height,
            model_width,
        )
        slots = []
        for _ in range(3):
            input_tensor = torch.empty(
                input_shape,
                dtype=torch.float32,
                pin_memory=True,
            )
            output_tensor = torch.empty(
                output_shape,
                dtype=torch.float32,
                pin_memory=True,
            )
            input_buffer = input_tensor.numpy()
            self._initialize_background(input_buffer, median_rgb)
            slots.append(_BatchSlot(
                input_buffer=input_buffer,
                input_tensor=input_tensor,
                output_tensor=output_tensor,
                input_ready=torch.cuda.Event(),
                inference_started=torch.cuda.Event(enable_timing=True),
                inference_finished=torch.cuda.Event(enable_timing=True),
                result_ready=torch.cuda.Event(),
            ))
        resources = _CudaPipelineResources(
            h2d_stream=torch.cuda.Stream(device=self.loaded.device),
            compute_stream=torch.cuda.Stream(device=self.loaded.device),
            device_inputs=[
                torch.empty(
                    input_shape,
                    dtype=torch.float32,
                    device=self.loaded.device,
                )
                for _ in range(2)
            ],
            device_compute_done=[None, None],
        )
        return slots, resources

    def _predict_serial(
        self,
        reader: StreamingVideoReader,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        progress_callback: ProgressCallback | None,
        total: int,
    ) -> list[TrajectoryPoint]:
        input_batch = self._create_input_buffer(
            median_rgb,
            model_width,
            model_height,
        )
        packet_batch: list[list[FramePacket]] = []
        packets: list[FramePacket] = []
        predictions: list[TrajectoryPoint] = []
        sequence_count = 0
        sequence_frame_count = 0
        frame_channels = self._frame_channel_count()
        background_channels = 3 if self.loaded.bg_mode == "concat" else 0

        for packet in reader:
            self._write_packet(
                input_batch,
                sequence_count,
                sequence_frame_count,
                packet,
                median_rgb,
                analysis_roi,
                model_width,
                model_height,
                frame_channels,
                background_channels,
            )
            packets.append(packet)
            sequence_frame_count += 1
            if sequence_frame_count == self.loaded.seq_len:
                packet_batch.append(packets.copy())
                packets.clear()
                sequence_count += 1
                sequence_frame_count = 0
            if sequence_count == self.batch_size:
                predictions.extend(self._infer_batch(
                    input_batch[:sequence_count],
                    packet_batch,
                    reader.info,
                    analysis_roi,
                    model_width,
                    model_height,
                ))
                packet_batch.clear()
                sequence_count = 0
                if progress_callback:
                    progress_callback(len(predictions), total)

        if sequence_frame_count:
            self._pad_partial_sequence(
                input_batch,
                sequence_count,
                sequence_frame_count,
                frame_channels,
                background_channels,
            )
            packet_batch.append(packets.copy())
            sequence_count += 1
        if sequence_count:
            predictions.extend(self._infer_batch(
                input_batch[:sequence_count],
                packet_batch,
                reader.info,
                analysis_roi,
                model_width,
                model_height,
            ))
        return predictions

    def _predict_cuda_pipeline(
        self,
        reader: StreamingVideoReader,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        progress_callback: ProgressCallback | None,
        total: int,
    ) -> list[TrajectoryPoint]:
        free_slots: Queue[Any] = Queue(maxsize=3)
        ready_slots: Queue[Any] = Queue(maxsize=2)
        result_slots: Queue[Any] = Queue(maxsize=2)
        first_error: Queue[BaseException] = Queue(maxsize=1)
        stop_event = Event()
        predictions: list[TrajectoryPoint] = []
        resources: _CudaPipelineResources | None
        try:
            slots, resources = self._create_pinned_cuda_resources(
                median_rgb,
                model_width,
                model_height,
            )
            self._cuda_pipeline_mode = "pinned_async"
        except (MemoryError, RuntimeError):
            resources = None
            slots = [
                _BatchSlot(self._create_input_buffer(
                    median_rgb,
                    model_width,
                    model_height,
                ))
                for _ in range(3)
            ]
            self._cuda_pipeline_mode = "pageable_sync"
        for slot in slots:
            free_slots.put(slot)

        producer = Thread(
            target=self._produce_cuda_slots,
            name="ttcut-tracknet-producer",
            args=(
                reader,
                median_rgb,
                analysis_roi,
                model_width,
                model_height,
                free_slots,
                ready_slots,
                first_error,
                stop_event,
            ),
        )
        postprocessor = Thread(
            target=self._postprocess_cuda_slots,
            name="ttcut-tracknet-postprocessor",
            args=(
                result_slots,
                free_slots,
                predictions,
                reader.info,
                analysis_roi,
                model_width,
                model_height,
                progress_callback,
                total,
                first_error,
                stop_event,
            ),
        )
        producer.start()
        postprocessor.start()
        try:
            self._consume_cuda_slots(
                ready_slots,
                result_slots,
                resources,
                first_error,
                stop_event,
            )
        except BaseException as exc:
            self._record_pipeline_error(first_error, stop_event, exc)
        finally:
            if not first_error.empty():
                stop_event.set()
            producer.join()
            postprocessor.join()
            if resources is not None:
                torch = import_torch()
                try:
                    torch.cuda.synchronize(self.loaded.device)
                except BaseException as exc:
                    self._record_pipeline_error(first_error, stop_event, exc)
        if not first_error.empty():
            raise first_error.get()
        return predictions

    def _produce_cuda_slots(
        self,
        reader: StreamingVideoReader,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        free_slots: Queue[Any],
        ready_slots: Queue[Any],
        first_error: Queue[BaseException],
        stop_event: Event,
    ) -> None:
        current: _BatchSlot | None = None
        packets: list[FramePacket] = []
        sequence_frame_count = 0
        ordinal = 0
        frame_channels = self._frame_channel_count()
        background_channels = 3 if self.loaded.bg_mode == "concat" else 0
        try:
            for packet in reader:
                if current is None:
                    value = self._queue_get(free_slots, stop_event)
                    if value is None:
                        return
                    current = value
                    self._transition_slot(current, "FREE", "FILLING")
                    current.ordinal = ordinal
                    current.valid_sequence_count = 0
                    current.packet_groups.clear()
                    current.heatmaps = None
                self._write_packet(
                    current.input_buffer,
                    current.valid_sequence_count,
                    sequence_frame_count,
                    packet,
                    median_rgb,
                    analysis_roi,
                    model_width,
                    model_height,
                    frame_channels,
                    background_channels,
                )
                packets.append(packet)
                sequence_frame_count += 1
                if sequence_frame_count == self.loaded.seq_len:
                    current.packet_groups.append(packets.copy())
                    packets.clear()
                    current.valid_sequence_count += 1
                    sequence_frame_count = 0
                if current.valid_sequence_count == self.batch_size:
                    self._transition_slot(current, "FILLING", "READY")
                    if not self._queue_put(ready_slots, current, stop_event):
                        return
                    ordinal += 1
                    current = None

            if current is not None and sequence_frame_count:
                self._pad_partial_sequence(
                    current.input_buffer,
                    current.valid_sequence_count,
                    sequence_frame_count,
                    frame_channels,
                    background_channels,
                )
                current.packet_groups.append(packets.copy())
                current.valid_sequence_count += 1
            if current is not None and current.valid_sequence_count:
                self._transition_slot(current, "FILLING", "READY")
                if not self._queue_put(ready_slots, current, stop_event):
                    return
            self._queue_put(ready_slots, _END_OF_STREAM, stop_event)
        except BaseException as exc:
            self._record_pipeline_error(first_error, stop_event, exc)

    def _consume_cuda_slots(
        self,
        ready_slots: Queue[Any],
        result_slots: Queue[Any],
        resources: _CudaPipelineResources | None,
        first_error: Queue[BaseException],
        stop_event: Event,
    ) -> None:
        try:
            while True:
                value = self._queue_get(ready_slots, stop_event)
                if value is None:
                    return
                if value is _END_OF_STREAM:
                    self._queue_put(result_slots, _END_OF_STREAM, stop_event)
                    return
                slot: _BatchSlot = value
                self._transition_slot(slot, "READY", "GPU_RUNNING")
                if resources is None:
                    slot.heatmaps = self._run_model_batch(
                        slot.input_buffer[:slot.valid_sequence_count],
                    )
                else:
                    self._enqueue_async_cuda_slot(slot, resources)
                self._transition_slot(slot, "GPU_RUNNING", "RESULT_READY")
                if not self._queue_put(result_slots, slot, stop_event):
                    return
        except BaseException as exc:
            self._record_pipeline_error(first_error, stop_event, exc)

    def _enqueue_async_cuda_slot(
        self,
        slot: _BatchSlot,
        resources: _CudaPipelineResources,
    ) -> None:
        torch = import_torch()
        if (
            slot.input_tensor is None
            or slot.output_tensor is None
            or slot.input_ready is None
            or slot.inference_started is None
            or slot.inference_finished is None
            or slot.result_ready is None
        ):
            raise RuntimeError("TrackNet pinned CUDA slot is incomplete.")
        device_index = slot.ordinal % len(resources.device_inputs)
        device_input = resources.device_inputs[device_index]
        valid = slot.valid_sequence_count
        try:
            with torch.cuda.stream(resources.h2d_stream):
                previous_compute = resources.device_compute_done[device_index]
                if previous_compute is not None:
                    resources.h2d_stream.wait_event(previous_compute)
                device_input[:valid].copy_(
                    slot.input_tensor[:valid],
                    non_blocking=True,
                )
                slot.input_ready.record(resources.h2d_stream)
            with torch.cuda.stream(resources.compute_stream):
                resources.compute_stream.wait_event(slot.input_ready)
                slot.inference_started.record(resources.compute_stream)
                with torch.no_grad():
                    slot.gpu_output = self.loaded.model(device_input[:valid])
                slot.inference_finished.record(resources.compute_stream)
                compute_done = torch.cuda.Event()
                compute_done.record(resources.compute_stream)
                resources.device_compute_done[device_index] = compute_done
                slot.output_tensor[:valid].copy_(
                    slot.gpu_output,
                    non_blocking=True,
                )
                slot.result_ready.record(resources.compute_stream)
        except Exception as exc:
            self._raise_device_error(exc)

    def _postprocess_cuda_slots(
        self,
        result_slots: Queue[Any],
        free_slots: Queue[Any],
        predictions: list[TrajectoryPoint],
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        progress_callback: ProgressCallback | None,
        total: int,
        first_error: Queue[BaseException],
        stop_event: Event,
    ) -> None:
        expected_ordinal = 0
        try:
            while True:
                value = self._queue_get(result_slots, stop_event)
                if value is None:
                    return
                if value is _END_OF_STREAM:
                    return
                slot: _BatchSlot = value
                if slot.ordinal != expected_ordinal:
                    raise RuntimeError("TrackNet pipeline batch order changed.")
                expected_ordinal += 1
                self._transition_slot(slot, "RESULT_READY", "POSTPROCESSING")
                if slot.result_ready is not None:
                    try:
                        slot.result_ready.synchronize()
                    except Exception as exc:
                        self._raise_device_error(exc)
                    self._model_inference_seconds += (
                        slot.inference_started.elapsed_time(
                            slot.inference_finished,
                        )
                        / 1000
                    )
                    heatmaps = slot.output_tensor[
                        :slot.valid_sequence_count
                    ].numpy()
                elif slot.heatmaps is not None:
                    heatmaps = slot.heatmaps
                else:
                    raise RuntimeError("TrackNet pipeline result is unavailable.")
                predictions.extend(self._postprocess_batch(
                    heatmaps,
                    slot.packet_groups,
                    info,
                    analysis_roi,
                    model_width,
                    model_height,
                ))
                if progress_callback:
                    progress_callback(len(predictions), total)
                slot.heatmaps = None
                slot.gpu_output = None
                slot.packet_groups.clear()
                self._transition_slot(slot, "POSTPROCESSING", "FREE")
                if not self._queue_put(free_slots, slot, stop_event):
                    return
        except BaseException as exc:
            self._record_pipeline_error(first_error, stop_event, exc)

    @staticmethod
    def _queue_get(queue: Queue[Any], stop_event: Event) -> Any | None:
        while not stop_event.is_set():
            try:
                return queue.get(timeout=0.05)
            except Empty:
                continue
        return None

    @staticmethod
    def _queue_put(queue: Queue[Any], value: Any, stop_event: Event) -> bool:
        while not stop_event.is_set():
            try:
                queue.put(value, timeout=0.05)
                return True
            except Full:
                continue
        return False

    @staticmethod
    def _record_pipeline_error(
        first_error: Queue[BaseException],
        stop_event: Event,
        error: BaseException,
    ) -> None:
        try:
            first_error.put_nowait(error)
        except Full:
            pass
        stop_event.set()

    @staticmethod
    def _transition_slot(slot: _BatchSlot, expected: str, next_state: str) -> None:
        if slot.state != expected:
            raise RuntimeError(
                f"TrackNet pipeline slot transition {slot.state} -> {next_state} "
                f"expected {expected}.",
            )
        slot.state = next_state

    def _write_packet(
        self,
        input_buffer: np.ndarray,
        sequence_index: int,
        frame_index: int,
        packet: FramePacket,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        frame_channels: int,
        background_channels: int,
    ) -> None:
        channel_start = background_channels + frame_index * frame_channels
        self._preprocess_frame_into(
            packet.frame_bgr,
            median_rgb,
            analysis_roi,
            model_width,
            model_height,
            input_buffer[
                sequence_index,
                channel_start:channel_start + frame_channels,
            ],
        )

    def _pad_partial_sequence(
        self,
        input_buffer: np.ndarray,
        sequence_index: int,
        frame_count: int,
        frame_channels: int,
        background_channels: int,
    ) -> None:
        source_start = background_channels + (frame_count - 1) * frame_channels
        last_frame = input_buffer[
            sequence_index,
            source_start:source_start + frame_channels,
        ].copy()
        for frame_index in range(frame_count, self.loaded.seq_len):
            channel_start = background_channels + frame_index * frame_channels
            input_buffer[
                sequence_index,
                channel_start:channel_start + frame_channels,
            ] = last_frame

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

    def _frame_channel_count(self) -> int:
        if self.loaded.bg_mode == "subtract":
            return 1
        if self.loaded.bg_mode == "subtract_concat":
            return 4
        return 3

    def _preprocess_frame(
        self,
        frame_bgr,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> np.ndarray:
        output = np.empty(
            (self._frame_channel_count(), model_height, model_width),
            dtype=np.float32,
        )
        self._preprocess_frame_into(
            frame_bgr,
            median_rgb,
            analysis_roi,
            model_width,
            model_height,
            output,
        )
        return output

    def _preprocess_frame_into(
        self,
        frame_bgr,
        median_rgb: np.ndarray | None,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
        output: np.ndarray,
    ) -> None:
        import cv2

        cropped = self._crop_frame(frame_bgr, analysis_roi)
        rgb = cv2.resize(
            cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB),
            (model_width, model_height),
        )
        if self.loaded.bg_mode == "subtract":
            output[0] = (
                np.abs(rgb.astype(np.int16) - median_rgb.astype(np.int16))
                .sum(axis=2)
                .astype(np.float32)
                / 255
            )
            return
        output[:3] = rgb.transpose(2, 0, 1).astype(np.float32) / 255
        if self.loaded.bg_mode == "subtract_concat":
            output[3] = (
                np.abs(rgb.astype(np.int16) - median_rgb.astype(np.int16))
                .sum(axis=2)
                .astype(np.float32)
                / 255
            )

    def _infer_batch(
        self,
        inputs: np.ndarray,
        packet_groups: Sequence[Sequence[FramePacket]],
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> list[TrajectoryPoint]:
        return self._postprocess_batch(
            self._run_model_batch(inputs),
            packet_groups,
            info,
            analysis_roi,
            model_width,
            model_height,
        )

    def _run_model_batch(self, inputs: np.ndarray) -> np.ndarray:
        torch = import_torch()
        try:
            tensor = torch.from_numpy(inputs).float().to(self.loaded.device)
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
            self._raise_device_error(exc)
        return heatmaps

    @staticmethod
    def _raise_device_error(error: Exception) -> None:
        if "out of memory" in str(error).lower():
            torch = import_torch()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            raise DeviceError(
                "CUDA ran out of memory; use CPU mode or a smaller batch.",
            ) from error
        raise error

    def _postprocess_batch(
        self,
        heatmaps: np.ndarray,
        packet_groups: Sequence[Sequence[FramePacket]],
        info: VideoInfo,
        analysis_roi: AnalysisRoi | None,
        model_width: int,
        model_height: int,
    ) -> list[TrajectoryPoint]:
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
