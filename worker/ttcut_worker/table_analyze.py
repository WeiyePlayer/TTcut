from __future__ import annotations

import math
import time
from itertools import product
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import torch
import torch.nn.functional as F

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


SAMPLE_RATIOS = (0.05, 0.14, 0.23, 0.32, 0.41, 0.50, 0.59, 0.68, 0.77, 0.86, 0.95)
SAMPLE_LABELS = tuple(f"sample_{index:02d}" for index in range(1, len(SAMPLE_RATIOS) + 1))
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
SEMANTIC_CORNER_INDICES = (4, 5, 1, 0)
PLANAR_KEYPOINT_INDICES = (0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12)
TABLE_KEYPOINTS_CM = np.asarray([
    [-137.0, 76.25],
    [-137.0, -76.25],
    [0.0, 76.25],
    [0.0, -76.25],
    [137.0, 76.25],
    [137.0, -76.25],
    [0.0, 91.5],
    [0.0, -91.5],
    [0.0, 0.0],
    [0.0, 0.0],
    [0.0, 0.0],
    [-137.0, 0.0],
    [137.0, 0.0],
], dtype=np.float32)
TABLE_CORNERS_CM = TABLE_KEYPOINTS_CM[list(SEMANTIC_CORNER_INDICES)]
MODEL_SIZE = (1600, 896)
KEYPOINT_THRESHOLD = 0.1
PEAK_CANDIDATE_COUNT = 12
PEAK_MIN_ACTIVATION = 0.15
PEAK_CLUSTER_RADIUS_RATIO = 0.025
PEAK_CLUSTER_LIMIT = 8
GEOMETRIC_SIGMA_RATIO = 0.018
GEOMETRIC_MAX_DISTANCE_RATIO = 0.04
MIN_GEOMETRIC_SUPPORT = 10
MIN_GEOMETRIC_SCORE = 5.5
MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)

ProgressCallback = Callable[[str, int, int], None]
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
            min(last_index, max(0, int(round(last_index * ratio))))
            for ratio in SAMPLE_RATIOS
        ]
        target_times = [
            int(index) / fps
            for index in target_frame_indices
        ]
    else:
        target_frame_indices = [None] * len(SAMPLE_RATIOS)
        target_times = [
            duration * ratio
            for ratio in SAMPLE_RATIOS
        ]

    samples = []
    decoded_frame_count = 0
    progress_callback("table_sampling", 0, len(SAMPLE_LABELS))
    try:
        for sample_index, (label, ratio, target_frame_index, target_time) in enumerate(
            zip(SAMPLE_LABELS, SAMPLE_RATIOS, target_frame_indices, target_times),
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
                    "label": label,
                    "sample_ratio": ratio,
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
        "sample_count": len(samples),
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


def _extract_peak_candidates(
    heatmaps: torch.Tensor,
    image_width: int,
    image_height: int,
) -> tuple[np.ndarray, np.ndarray]:
    maps = heatmaps[0]
    _, heatmap_height, heatmap_width = maps.shape
    pooled = F.max_pool2d(maps.unsqueeze(0), kernel_size=9, stride=1, padding=4)[0]
    local_maxima = torch.where(maps == pooled, maps, torch.full_like(maps, -torch.inf))
    values, indices = torch.topk(
        local_maxima.flatten(1),
        k=min(PEAK_CANDIDATE_COUNT, heatmap_height * heatmap_width),
        dim=1,
    )
    x = indices % heatmap_width
    y = indices // heatmap_width
    positions = torch.stack((
        (x.float() + 0.5) * image_width / heatmap_width - 0.5,
        (y.float() + 0.5) * image_height / heatmap_height - 0.5,
    ), dim=2)
    return positions.cpu().numpy(), values.cpu().numpy()


def _predict_samples(model, device, samples, width: int, height: int, progress_callback: ProgressCallback):
    predictions = []
    progress_callback("table_inference", 0, len(samples))
    for sample_index, (frame_index, timestamp, frame, sample_info) in enumerate(samples, start=1):
        tensor = _preprocess(frame, device)
        started = time.perf_counter()
        try:
            with torch.inference_mode():
                heatmaps = model(tensor)
                if device.type == "cuda":
                    torch.cuda.synchronize(device)
                points, activations, valid = _extract_raw_keypoints(heatmaps, width, height)
                peak_points, peak_activations = _extract_peak_candidates(heatmaps, width, height)
        except torch.cuda.OutOfMemoryError as exc:
            raise DeviceError("CUDA ran out of memory during automatic table calibration.") from exc
        predictions.append({
            "frame_index": frame_index,
            "time_seconds": timestamp,
            **sample_info,
            "points": points,
            "activations": activations,
            "valid": valid,
            "peak_points": peak_points,
            "peak_activations": peak_activations,
            "forward_seconds": time.perf_counter() - started,
        })
        progress_callback("table_inference", sample_index, len(samples))
    return predictions


def _stable_peak_clusters(predictions, point_index: int, diagonal: float) -> list[dict]:
    radius = diagonal * PEAK_CLUSTER_RADIUS_RATIO
    frame_candidates = []
    for prediction in predictions:
        points = prediction["peak_points"][point_index]
        activations = prediction["peak_activations"][point_index]
        valid = (
            np.isfinite(points).all(axis=1)
            & np.isfinite(activations)
            & (activations >= PEAK_MIN_ACTIVATION)
        )
        frame_candidates.append((points[valid], activations[valid], prediction["label"]))

    seeds = [points for points, _activations, _label in frame_candidates if len(points)]
    if not seeds:
        return []

    valid_candidate_count = sum(len(points) for points, _activations, _label in frame_candidates)
    clusters = []
    for seed in np.concatenate(seeds, axis=0):
        selected_points = []
        selected_activations = []
        selected_samples = []
        for points, activations, label in frame_candidates:
            if not len(points):
                continue
            distances = np.linalg.norm(points - seed, axis=1)
            matches = np.flatnonzero(distances <= radius)
            if not len(matches):
                continue
            best = max(
                matches,
                key=lambda index: float(activations[index] - distances[index] / radius * 0.15),
            )
            selected_points.append(points[best])
            selected_activations.append(float(activations[best]))
            selected_samples.append(label)
        if len(selected_points) < 2:
            continue
        center = np.median(np.stack(selected_points), axis=0)
        clusters.append({
            "point": center,
            "support": len(selected_points),
            "mean_activation": float(np.mean(selected_activations)),
            "selected_samples": selected_samples,
            "valid_candidate_count": valid_candidate_count,
        })

    clusters.sort(key=lambda item: (-item["support"], -item["mean_activation"]))
    kept = []
    for cluster in clusters:
        if any(np.linalg.norm(cluster["point"] - existing["point"]) < radius * 0.6 for existing in kept):
            continue
        kept.append(cluster)
        if len(kept) >= PEAK_CLUSTER_LIMIT:
            break
    return kept


def _build_peak_clusters(predictions, width: int, height: int) -> dict[int, list[dict]]:
    diagonal = math.hypot(width, height)
    return {
        point_index: _stable_peak_clusters(predictions, point_index, diagonal)
        for point_index in PLANAR_KEYPOINT_INDICES
    }


def _valid_corner_candidate(corners: np.ndarray, width: int, height: int) -> TableCalibration | None:
    points = {
        "top_left": corners[0].tolist(),
        "top_right": corners[1].tolist(),
        "bottom_right": corners[2].tolist(),
        "bottom_left": corners[3].tolist(),
    }
    try:
        calibration = TableCalibration.from_points(width, height, points)
    except CalibrationError:
        return None
    far_edge = float(np.linalg.norm(corners[1] - corners[0]))
    close_edge = float(np.linalg.norm(corners[2] - corners[3]))
    if far_edge > close_edge * 1.35:
        return None
    return calibration


def _score_homography(
    homography: np.ndarray,
    clusters: dict[int, list[dict]],
    diagonal: float,
    sample_count: int,
) -> tuple[float, int, list[dict | None]]:
    world_points = TABLE_KEYPOINTS_CM[list(PLANAR_KEYPOINT_INDICES)]
    projected = cv2.perspectiveTransform(world_points.reshape(-1, 1, 2), homography).reshape(-1, 2)
    sigma = diagonal * GEOMETRIC_SIGMA_RATIO
    maximum_distance = diagonal * GEOMETRIC_MAX_DISTANCE_RATIO
    score = 0.0
    support = 0
    selected = []
    for projected_point, point_index in zip(projected, PLANAR_KEYPOINT_INDICES):
        options = clusters[point_index]
        if not options:
            selected.append(None)
            continue
        distances = np.asarray([
            np.linalg.norm(projected_point - option["point"])
            for option in options
        ])
        quality = np.asarray([
            option["support"] / sample_count
            * (0.7 + 0.3 * np.clip(option["mean_activation"], 0, 1.2) / 1.2)
            for option in options
        ])
        values = quality * np.exp(-0.5 * np.square(distances / sigma))
        best = int(np.argmax(values))
        score += float(values[best])
        if distances[best] <= maximum_distance:
            support += 1
            selected.append(options[best])
        else:
            selected.append(None)
    return score, support, selected


def _select_geometric_consensus(
    clusters: dict[int, list[dict]],
    width: int,
    height: int,
    sample_count: int,
) -> tuple[TableCalibration, list[dict | None], dict]:
    corner_clusters = [clusters[point_index] for point_index in SEMANTIC_CORNER_INDICES]
    candidate_counts = [len(options) for options in corner_clusters]
    if any(count == 0 for count in candidate_counts):
        raise AutoCalibrationError("Automatic calibration could not find stable candidates for all table corners.")

    diagonal = math.hypot(width, height)
    best = None
    for options in product(*corner_clusters):
        corners = np.stack([option["point"] for option in options]).astype(np.float32)
        calibration = _valid_corner_candidate(corners, width, height)
        if calibration is None:
            continue
        homography = cv2.getPerspectiveTransform(TABLE_CORNERS_CM, corners)
        score, support, selected = _score_homography(
            homography,
            clusters,
            diagonal,
            sample_count,
        )
        if support < MIN_GEOMETRIC_SUPPORT:
            continue
        candidate = (score, support, calibration, selected)
        if best is None or candidate[:2] > best[:2]:
            best = candidate

    if best is None or best[0] < MIN_GEOMETRIC_SCORE:
        raise AutoCalibrationError("Automatic calibration did not find a consistent table geometry.")
    score, support, calibration, selected = best
    return calibration, selected, {
        "sample_count": sample_count,
        "semantic_support": support,
        "score": float(score),
        "corner_candidate_counts": candidate_counts,
    }


def _fixed_keypoint_details(
    clusters: dict[int, list[dict]],
    selected: list[dict | None],
) -> list[dict]:
    selected_by_index = dict(zip(PLANAR_KEYPOINT_INDICES, selected))
    details = []
    for point_index, point_label in enumerate(KEYPOINT_LABELS):
        cluster = selected_by_index.get(point_index)
        if cluster is None:
            details.append({
                "keypoint": point_index + 1,
                "label": point_label,
                "valid": False,
                "valid_candidate_count": sum(
                    option["valid_candidate_count"]
                    for option in clusters.get(point_index, [])[:1]
                ),
                "cluster_support": 0,
            })
            continue
        details.append({
            "keypoint": point_index + 1,
            "label": point_label,
            "valid": True,
            "valid_candidate_count": cluster["valid_candidate_count"],
            "cluster_support": cluster["support"],
            "selected_samples": cluster["selected_samples"],
            "x": float(cluster["point"][0]),
            "y": float(cluster["point"][1]),
            "activation": cluster["mean_activation"],
        })
    return details


def _serializable_prediction(prediction):
    return {
        "label": prediction["label"],
        "sample_ratio": prediction["sample_ratio"],
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
        clusters = _build_peak_clusters(
            predictions,
            video_info["width"],
            video_info["height"],
        )
        calibration, selected, consensus = _select_geometric_consensus(
            clusters,
            video_info["width"],
            video_info["height"],
            len(predictions),
        )
        fixed_keypoints = _fixed_keypoint_details(clusters, selected)
    except AutoCalibrationError:
        raise
    except CalibrationError as exc:
        raise AutoCalibrationError(f"Automatic calibration produced invalid table corners: {exc}") from exc
    except DeviceError:
        raise
    except Exception as exc:
        raise AutoCalibrationError("Automatic table calibration failed.") from exc

    return calibration, {
        "schema_version": 2,
        "model": {
            "id": "table_analyze",
            "filename": "table_analyze.pt",
            "checkpoint_identifier": identifier,
        },
        "device": device.type,
        "model_load_seconds": model_load_seconds,
        "video_info": video_info,
        "sampling": [_serializable_prediction(prediction) for prediction in predictions],
        "aggregation_rule": "temporal_peak_clusters_geometric_consensus",
        "fixed_keypoints": fixed_keypoints,
        "consensus": consensus,
    }
