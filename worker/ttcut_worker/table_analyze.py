from __future__ import annotations

import math
import time
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import torch

from .calibration import TableCalibration
from .errors import (
    AutoCalibrationError,
    CalibrationError,
    DeviceError,
    TableModelResourceError,
    WorkerError,
)
from .device import resolve_device
from .table_model import FixedTableModel


SAMPLE_LABELS = ("first", "25_percent", "50_percent", "75_percent", "last")
KEYPOINT_LABELS = (
    "close_left",
    "close_right",
    "center_left",
    "center_right",
    "far_left",
    "far_right",
    "net_left_bottom",
    "net_right_bottom",
    "net_center_bottom",
    "net_left_top",
    "net_right_top",
    "close_center",
    "far_center",
)
CORNER_INDICES = (0, 1, 4, 5)
MODEL_SIZE = (1600, 896)
KEYPOINT_THRESHOLD = 0.1
MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)

ProgressCallback = Callable[[str, int, int], None]
SAMPLE_RATIOS = (0.0, 0.25, 0.5, 0.75, 1.0)
MAX_SEEK_FORWARD_SECONDS = 10.0


def _capture_position(
    capture,
    fps: float,
) -> tuple[int, float]:
    next_frame = float(capture.get(cv2.CAP_PROP_POS_FRAMES))
    frame_index = max(0, int(round(next_frame)) - 1) if math.isfinite(next_frame) else 0
    timestamp = float(capture.get(cv2.CAP_PROP_POS_MSEC)) / 1000.0
    if not math.isfinite(timestamp) or timestamp < 0 or (timestamp == 0 and frame_index > 0):
        timestamp = frame_index / fps
    return frame_index, timestamp


def _seek_and_decode(
    capture,
    *,
    target_frame_index: int | None,
    target_time_seconds: float,
    fps: float,
) -> tuple[int, float, np.ndarray, int, str, float]:
    seek_method = "frame" if target_frame_index is not None else "time"
    seek_property = cv2.CAP_PROP_POS_FRAMES if seek_method == "frame" else cv2.CAP_PROP_POS_MSEC
    seek_value = (
        float(target_frame_index)
        if target_frame_index is not None
        else target_time_seconds * 1000.0
    )
    if not capture.set(seek_property, seek_value):
        raise AutoCalibrationError(f"Could not seek to automatic calibration sample by {seek_method}.")

    decoded = 0
    max_forward_frames = max(1, int(math.ceil(fps * MAX_SEEK_FORWARD_SECONDS)))
    while decoded < max_forward_frames:
        ok, frame = capture.read()
        if not ok or frame is None:
            raise AutoCalibrationError("Could not decode an automatic calibration sample.")
        decoded += 1
        frame_index, timestamp = _capture_position(capture, fps)
        if target_frame_index is not None:
            if frame_index < target_frame_index:
                continue
            if frame_index > target_frame_index:
                raise AutoCalibrationError(
                    f"Automatic calibration seek overshot frame {target_frame_index} with {frame_index}."
                )
            position_error = abs(frame_index - target_frame_index) / fps
            return frame_index, timestamp, frame, decoded, seek_method, position_error

        half_frame = 0.5 / fps
        if timestamp + half_frame < target_time_seconds:
            continue
        position_error = abs(timestamp - target_time_seconds)
        if position_error > max(2.0 / fps, 0.05):
            raise AutoCalibrationError(
                "Automatic calibration time seek exceeded the allowed position error."
            )
        return frame_index, timestamp, frame, decoded, seek_method, position_error

    raise AutoCalibrationError("Automatic calibration seek exceeded the bounded forward decode window.")


def _decode_sample_frames(
    video_path: str | Path,
    video_metadata: dict,
    progress_callback: ProgressCallback,
) -> tuple[list[tuple[int, float, np.ndarray, dict]], dict]:
    sampling_started = time.perf_counter()
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        capture.release()
        raise AutoCalibrationError(f"Could not open video for automatic calibration: {video_path}")

    capture_fps = float(capture.get(cv2.CAP_PROP_FPS))
    fps = float(video_metadata["fps"])
    capture_frames = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    declared_frames = video_metadata.get("frame_count")
    metadata_frames = int(declared_frames) if declared_frames is not None else capture_frames
    width = int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH)))
    height = int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    duration = float(video_metadata["duration_seconds"])
    if (
        not math.isfinite(capture_fps)
        or capture_fps <= 0
        or not math.isfinite(fps)
        or fps <= 0
        or not math.isfinite(duration)
        or duration <= 0
        or width <= 0
        or height <= 0
    ):
        capture.release()
        raise AutoCalibrationError("Video metadata is incomplete for automatic calibration.")

    use_frame_seek = metadata_frames > 0 and not bool(video_metadata["variable_frame_rate"])
    if use_frame_seek:
        last_index = metadata_frames - 1
        target_frame_indices: list[int | None] = [
            0 if ratio == 0 else last_index if ratio == 1 else min(
                last_index,
                int(math.ceil(metadata_frames * ratio - 1e-9)),
            )
            for ratio in SAMPLE_RATIOS
        ]
        target_times = [
            int(index) / fps
            for index in target_frame_indices
        ]
    else:
        target_frame_indices = [None] * len(SAMPLE_RATIOS)
        target_times = [
            0.0 if ratio == 0 else max(0.0, duration - 1.0 / fps) if ratio == 1 else duration * ratio
            for ratio in SAMPLE_RATIOS
        ]

    samples = []
    decoded_frame_count = 0
    progress_callback("table_sampling", 0, len(SAMPLE_LABELS))
    try:
        for sample_index, (target_frame_index, target_time) in enumerate(
            zip(target_frame_indices, target_times),
            start=1,
        ):
            frame_index, timestamp, frame, decoded, seek_method, position_error = _seek_and_decode(
                capture,
                target_frame_index=target_frame_index,
                target_time_seconds=target_time,
                fps=fps,
            )
            decoded_frame_count += decoded
            samples.append((
                frame_index,
                timestamp,
                frame,
                {
                    "target_frame_index": target_frame_index,
                    "target_time_seconds": target_time,
                    "seek_method": seek_method,
                    "position_error_seconds": position_error,
                },
            ))
            progress_callback("table_sampling", sample_index, len(SAMPLE_LABELS))
    finally:
        capture.release()

    sample_frame_indices = {sample[0] for sample in samples}
    sample_timestamps = {round(sample[1], 6) for sample in samples}
    if (
        len(sample_frame_indices) != len(SAMPLE_LABELS)
        or len(sample_timestamps) != len(SAMPLE_LABELS)
    ):
        raise AutoCalibrationError("Automatic calibration samples must use distinct video positions.")

    return samples, {
        "width": width,
        "height": height,
        "fps": fps,
        "metadata_frame_count": metadata_frames,
        "decoded_frame_count": decoded_frame_count,
        "duration_seconds": duration,
        "sampling_seconds": time.perf_counter() - sampling_started,
        "seek_count": len(samples),
        "copied_frame_count": 0,
    }


def _load_model(weight_path: str | Path, requested_device: str):
    path = Path(weight_path).expanduser()
    if not path.is_file():
        raise TableModelResourceError(f"Bundled table analysis model is missing: {path}")
    try:
        checkpoint = torch.load(str(path), map_location="cpu", weights_only=True)
        state = checkpoint.get("model_state_dict")
        if not isinstance(state, dict):
            raise ValueError("checkpoint model_state_dict is missing")
        identifier = str(checkpoint.get("identifier") or "table_analyze")
        device = resolve_device(requested_device)
        model = FixedTableModel()
        model.load_state_dict(state, strict=True)
        return model.to(device).eval(), device, identifier
    except WorkerError:
        raise
    except torch.cuda.OutOfMemoryError as exc:
        raise DeviceError("CUDA ran out of memory while loading the table analysis model.") from exc
    except Exception as exc:
        raise TableModelResourceError(f"Bundled table analysis model is invalid: {path}") from exc


def _preprocess(image_bgr: np.ndarray, device) -> torch.Tensor:
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    image_rgb = cv2.resize(image_rgb, MODEL_SIZE, interpolation=cv2.INTER_LINEAR)
    image = image_rgb.astype(np.float32) / 255.0
    image = (image - MEAN) / STD
    image = np.ascontiguousarray(image.transpose(2, 0, 1))
    return torch.from_numpy(image).unsqueeze(0).to(device)


def _extract_raw_keypoints(
    heatmaps: torch.Tensor,
    image_width: int,
    image_height: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    _, channels, heatmap_height, heatmap_width = heatmaps.shape
    activations, indices = heatmaps.reshape(1, channels, -1).max(dim=2)
    x = indices % heatmap_width
    y = indices // heatmap_width
    positions = torch.empty((channels, 2), device=heatmaps.device, dtype=torch.float32)
    positions[:, 0] = (x[0].float() + 0.5) * image_width / heatmap_width - 0.5
    positions[:, 1] = (y[0].float() + 0.5) * image_height / heatmap_height - 0.5
    positions = positions.cpu().numpy()
    activations = activations[0].cpu().numpy()
    valid = activations >= KEYPOINT_THRESHOLD
    valid &= np.isfinite(activations)
    valid &= np.isfinite(positions).all(axis=1)
    valid &= positions[:, 0] >= 0
    valid &= positions[:, 0] < image_width
    valid &= positions[:, 1] >= 0
    valid &= positions[:, 1] < image_height
    return positions, activations, valid


def _predict_samples(model, device, samples, width: int, height: int, progress_callback: ProgressCallback):
    predictions = []
    progress_callback("table_inference", 0, len(samples))
    for sample_index, (label, (frame_index, timestamp, frame, sample_info)) in enumerate(zip(SAMPLE_LABELS, samples), start=1):
        tensor = _preprocess(frame, device)
        started = time.perf_counter()
        try:
            with torch.inference_mode():
                heatmaps = model(tensor)
                if device.type == "cuda":
                    torch.cuda.synchronize(device)
                points, activations, valid = _extract_raw_keypoints(heatmaps, width, height)
        except torch.cuda.OutOfMemoryError as exc:
            raise DeviceError("CUDA ran out of memory during automatic table calibration.") from exc
        predictions.append({
            "label": label,
            "frame_index": frame_index,
            "time_seconds": timestamp,
            **sample_info,
            "points": points,
            "activations": activations,
            "valid": valid,
            "forward_seconds": time.perf_counter() - started,
        })
        progress_callback("table_inference", sample_index, len(samples))
    return predictions


def _aggregate_nearest_pairs(predictions):
    fixed = np.zeros((len(KEYPOINT_LABELS), 3), dtype=np.float64)
    details = []
    for point_index, point_label in enumerate(KEYPOINT_LABELS):
        candidates = []
        for sample_index, prediction in enumerate(predictions):
            if prediction["valid"][point_index]:
                candidates.append((
                    sample_index,
                    prediction["points"][point_index].astype(np.float64),
                    float(prediction["activations"][point_index]),
                ))
        if len(candidates) < 2:
            details.append({
                "keypoint": point_index + 1,
                "label": point_label,
                "valid": False,
                "valid_candidate_count": len(candidates),
            })
            continue

        best = None
        for first_index in range(len(candidates)):
            for second_index in range(first_index + 1, len(candidates)):
                distance = float(np.linalg.norm(candidates[first_index][1] - candidates[second_index][1]))
                if best is None or distance < best[0]:
                    best = (distance, candidates[first_index], candidates[second_index])
        distance, first, second = best
        mean_point = (first[1] + second[1]) / 2.0
        activation = (first[2] + second[2]) / 2.0
        fixed[point_index, :2] = mean_point
        fixed[point_index, 2] = 1.0
        details.append({
            "keypoint": point_index + 1,
            "label": point_label,
            "valid": True,
            "valid_candidate_count": len(candidates),
            "selected_samples": [predictions[first[0]]["label"], predictions[second[0]]["label"]],
            "pair_distance_pixels": distance,
            "x": float(mean_point[0]),
            "y": float(mean_point[1]),
            "activation": float(activation),
        })
    return fixed, details


def _order_corners(fixed_points: np.ndarray) -> dict[str, list[float]]:
    corners = fixed_points[list(CORNER_INDICES), :2]
    vertical_order = np.argsort(corners[:, 1], kind="stable")
    top = corners[vertical_order[:2]]
    bottom = corners[vertical_order[2:]]
    top = top[np.argsort(top[:, 0], kind="stable")]
    bottom = bottom[np.argsort(bottom[:, 0], kind="stable")]
    return {
        "top_left": top[0].tolist(),
        "top_right": top[1].tolist(),
        "bottom_right": bottom[1].tolist(),
        "bottom_left": bottom[0].tolist(),
    }


def _select_coherent_corner_pair(predictions, width: int, height: int) -> tuple[int, int]:
    candidates = []
    for sample_index, prediction in enumerate(predictions):
        if not all(prediction["valid"][index] for index in CORNER_INDICES):
            continue
        points = np.column_stack((prediction["points"], prediction["valid"].astype(np.float64)))
        try:
            calibration = TableCalibration.from_points(width, height, _order_corners(points))
        except CalibrationError:
            continue
        candidates.append((sample_index, np.asarray(calibration.points, dtype=np.float64)))
    if len(candidates) < 2:
        raise AutoCalibrationError("Automatic calibration did not find two coherent table samples.")

    best = None
    for first_index in range(len(candidates)):
        for second_index in range(first_index + 1, len(candidates)):
            distance = float(np.linalg.norm(candidates[first_index][1] - candidates[second_index][1], axis=1).sum())
            if best is None or distance < best[0]:
                best = (distance, candidates[first_index][0], candidates[second_index][0])
    return best[1], best[2]


def _serializable_prediction(prediction):
    return {
        "label": prediction["label"],
        "frame_index": prediction["frame_index"],
        "time_seconds": prediction["time_seconds"],
        "target_frame_index": prediction["target_frame_index"],
        "target_time_seconds": prediction["target_time_seconds"],
        "seek_method": prediction["seek_method"],
        "position_error_seconds": prediction["position_error_seconds"],
        "forward_seconds": prediction["forward_seconds"],
        "keypoints": [
            {
                "keypoint": index + 1,
                "label": KEYPOINT_LABELS[index],
                "x": float(prediction["points"][index, 0]),
                "y": float(prediction["points"][index, 1]),
                "activation": float(prediction["activations"][index]),
                "valid": bool(prediction["valid"][index]),
            }
            for index in range(len(KEYPOINT_LABELS))
        ],
    }


def analyze_table(
    video_path: str | Path,
    weight_path: str | Path,
    requested_device: str,
    video_metadata: dict,
    progress_callback: ProgressCallback,
) -> tuple[TableCalibration, dict]:
    samples, video_info = _decode_sample_frames(video_path, video_metadata, progress_callback)
    progress_callback("table_model", 0, 1)
    model_started = time.perf_counter()
    model, device, identifier = _load_model(weight_path, requested_device)
    model_load_seconds = time.perf_counter() - model_started
    progress_callback("table_model", 1, 1)
    try:
        predictions = _predict_samples(
            model,
            device,
            samples,
            video_info["width"],
            video_info["height"],
            progress_callback,
        )
        fixed_points, fixed_keypoints = _aggregate_nearest_pairs(predictions)
        first_sample, second_sample = _select_coherent_corner_pair(
            predictions,
            video_info["width"],
            video_info["height"],
        )
        for point_index in CORNER_INDICES:
            first_point = predictions[first_sample]["points"][point_index].astype(np.float64)
            second_point = predictions[second_sample]["points"][point_index].astype(np.float64)
            mean_point = (first_point + second_point) / 2.0
            first_activation = float(predictions[first_sample]["activations"][point_index])
            second_activation = float(predictions[second_sample]["activations"][point_index])
            fixed_points[point_index, :2] = mean_point
            fixed_points[point_index, 2] = 1.0
            fixed_keypoints[point_index].update({
                "selected_samples": [predictions[first_sample]["label"], predictions[second_sample]["label"]],
                "pair_distance_pixels": float(np.linalg.norm(first_point - second_point)),
                "x": float(mean_point[0]),
                "y": float(mean_point[1]),
                "activation": (first_activation + second_activation) / 2.0,
            })
        if any(fixed_points[index, 2] != 1 for index in CORNER_INDICES):
            raise AutoCalibrationError("Automatic calibration could not identify all four table corners.")
        points = _order_corners(fixed_points)
        calibration = TableCalibration.from_points(video_info["width"], video_info["height"], points)
    except AutoCalibrationError:
        raise
    except CalibrationError as exc:
        raise AutoCalibrationError(f"Automatic calibration produced invalid table corners: {exc}") from exc
    except DeviceError:
        raise
    except Exception as exc:
        raise AutoCalibrationError("Automatic table calibration failed.") from exc

    return calibration, {
        "schema_version": 1,
        "model": {
            "id": "table_analyze",
            "filename": "table_analyze.pt",
            "checkpoint_identifier": identifier,
        },
        "device": device.type,
        "model_load_seconds": model_load_seconds,
        "video_info": video_info,
        "sampling": [_serializable_prediction(prediction) for prediction in predictions],
        "aggregation_rule": "closest_valid_pair_mean",
        "fixed_keypoints": fixed_keypoints,
    }
