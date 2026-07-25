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
from .model import resolve_device
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
CORNER_INDICES = (4, 5, 1, 0)
MODEL_SIZE = (1600, 896)
KEYPOINT_THRESHOLD = 0.1
MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)

ProgressCallback = Callable[[str, int, int], None]


def _decode_frames_by_index(
    video_path: str | Path,
    target_indices: list[int],
    fps: float,
) -> list[tuple[int, float, np.ndarray]]:
    targets = set(target_indices)
    selected: dict[int, tuple[int, float, np.ndarray]] = {}
    capture = cv2.VideoCapture(str(video_path))
    frame_index = 0
    while targets:
        ok, frame = capture.read()
        if not ok or frame is None:
            break
        if frame_index in targets:
            selected[frame_index] = (frame_index, frame_index / fps, frame.copy())
            targets.remove(frame_index)
        frame_index += 1
    capture.release()
    if targets:
        raise AutoCalibrationError("Could not decode all representative video frames.")
    return [selected[index] for index in target_indices]


def _decode_sample_frames(
    video_path: str | Path,
    progress_callback: ProgressCallback,
) -> tuple[list[tuple[int, float, np.ndarray]], dict]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        capture.release()
        raise AutoCalibrationError(f"Could not open video for automatic calibration: {video_path}")

    fps = float(capture.get(cv2.CAP_PROP_FPS))
    metadata_frames = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    width = int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH)))
    height = int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    if not math.isfinite(fps) or fps <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise AutoCalibrationError("Video metadata is incomplete for automatic calibration.")

    duration = metadata_frames / fps if metadata_frames > 0 else None
    target_times = [0.0]
    if duration is not None:
        target_times.extend(duration * ratio for ratio in (0.25, 0.5, 0.75))
    else:
        target_times.extend((math.inf, math.inf, math.inf))

    selected: list[tuple[int, float, np.ndarray] | None] = [None, None, None, None]
    last_frame = None
    last_index = -1
    frame_index = 0
    next_progress = 0.1
    progress_callback("table_sampling", 0, metadata_frames)
    while True:
        ok, frame = capture.read()
        if not ok or frame is None:
            break
        timestamp = frame_index / fps
        for target_index, target_time in enumerate(target_times):
            if selected[target_index] is None and timestamp >= target_time:
                selected[target_index] = (frame_index, timestamp, frame.copy())
        last_frame = frame.copy()
        last_index = frame_index
        frame_index += 1
        if metadata_frames > 0 and frame_index / metadata_frames >= next_progress:
            progress_callback("table_sampling", min(frame_index, metadata_frames), metadata_frames)
            next_progress += 0.1
    capture.release()

    if last_frame is None:
        raise AutoCalibrationError("No decodable frames were found for automatic calibration.")
    actual_duration = frame_index / fps
    if duration is None:
        target_indices = [
            0,
            round((frame_index - 1) * 0.25),
            round((frame_index - 1) * 0.5),
            round((frame_index - 1) * 0.75),
        ]
        selected = _decode_frames_by_index(video_path, target_indices, fps)
    if any(item is None for item in selected):
        raise AutoCalibrationError("Could not decode all representative video frames.")

    progress_callback("table_sampling", frame_index, frame_index)
    samples = [item for item in selected if item is not None]
    samples.append((last_index, last_index / fps, last_frame))
    return samples, {
        "width": width,
        "height": height,
        "fps": fps,
        "metadata_frame_count": metadata_frames,
        "decoded_frame_count": frame_index,
        "duration_seconds": actual_duration,
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
    for sample_index, (label, (frame_index, timestamp, frame)) in enumerate(zip(SAMPLE_LABELS, samples), start=1):
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


def _serializable_prediction(prediction):
    return {
        "label": prediction["label"],
        "frame_index": prediction["frame_index"],
        "time_seconds": prediction["time_seconds"],
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
    progress_callback: ProgressCallback,
) -> tuple[TableCalibration, dict]:
    samples, video_info = _decode_sample_frames(video_path, progress_callback)
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
        if any(fixed_points[index, 2] != 1 for index in CORNER_INDICES):
            raise AutoCalibrationError("Automatic calibration could not identify all four table corners.")
        points = {
            name: fixed_points[index, :2].tolist()
            for name, index in zip(
                ("top_left", "top_right", "bottom_right", "bottom_left"),
                CORNER_INDICES,
            )
        }
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
