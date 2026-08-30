from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
import time
from dataclasses import asdict
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = PROJECT_ROOT / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from ttcut_worker.calibration import TableCalibration  # noqa: E402
from ttcut_worker.rallies import group_rallies  # noqa: E402
from ttcut_worker.roi import build_analysis_roi  # noqa: E402
from ttcut_worker.tracknet_bounce import detect_tracknet_bounce_frames  # noqa: E402
from ttcut_worker.tracknet_model import load_tracknet  # noqa: E402
from ttcut_worker.tracknet_predictor import (  # noqa: E402
    TRACKNET_CONFIDENCE_THRESHOLD,
    TRACKNET_ROI_MODEL_SCALE,
    TrackNetPredictor,
)
from ttcut_worker.tracknet_rallies import tracknet_visibility_rallies  # noqa: E402
from ttcut_worker.visibility_rallies import (  # noqa: E402
    VisibilityMotionConfig,
    continuous_visibility_rallies,
    is_end_on_table_view,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_target(path: Path) -> tuple[TableCalibration, list[tuple[float, float]]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = payload.get("result", payload)
    calibration = result["calibration"]
    points = calibration["points"]
    ordered = [points[name] for name in ("top_left", "top_right", "bottom_right", "bottom_left")]
    table = TableCalibration.from_points(
        calibration["video_width"], calibration["video_height"], ordered,
    )
    rallies = [
        (float(rally["start_time_seconds"]), float(rally["end_time_seconds"]))
        for rally in result["rallies"]
    ]
    return table, rallies


def matching_summary(
    predicted: list[tuple[float, float]], target: list[tuple[float, float]], *, minimum_iou: float = 0.3,
) -> dict:
    candidates: list[tuple[float, int, int]] = []
    for predicted_index, (predicted_start, predicted_end) in enumerate(predicted):
        for target_index, (target_start, target_end) in enumerate(target):
            overlap = max(0.0, min(predicted_end, target_end) - max(predicted_start, target_start))
            union = max(predicted_end, target_end) - min(predicted_start, target_start)
            iou = overlap / union if union > 0 else 0.0
            if iou >= minimum_iou:
                candidates.append((iou, predicted_index, target_index))
    matched_predicted: set[int] = set()
    matched_target: set[int] = set()
    matches = []
    for iou, predicted_index, target_index in sorted(candidates, reverse=True):
        if predicted_index in matched_predicted or target_index in matched_target:
            continue
        matched_predicted.add(predicted_index)
        matched_target.add(target_index)
        matches.append({
            "predicted_index": predicted_index + 1,
            "target_index": target_index + 1,
            "iou": round(iou, 6),
        })
    precision = len(matches) / len(predicted) if predicted else 0.0
    recall = len(matches) / len(target) if target else 0.0
    return {
        "minimum_iou": minimum_iou,
        "predicted_count": len(predicted),
        "target_count": len(target),
        "matched_count": len(matches),
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(2 * precision * recall / (precision + recall), 6) if precision + recall else 0.0,
        "unmatched_predicted_indexes": [
            index + 1 for index in range(len(predicted)) if index not in matched_predicted
        ],
        "unmatched_target_indexes": [
            index + 1 for index in range(len(target)) if index not in matched_target
        ],
        "matches": sorted(matches, key=lambda item: item["predicted_index"]),
    }


def overlap_matching_summary(
    predicted: list[tuple[float, float]],
    target: list[tuple[float, float]],
    *,
    minimum_overlap_seconds: float = 0.2,
) -> dict:
    candidates: list[tuple[float, int, int]] = []
    for predicted_index, (predicted_start, predicted_end) in enumerate(predicted):
        for target_index, (target_start, target_end) in enumerate(target):
            overlap = max(0.0, min(predicted_end, target_end) - max(predicted_start, target_start))
            if overlap >= minimum_overlap_seconds:
                candidates.append((overlap, predicted_index, target_index))
    matched_predicted: set[int] = set()
    matched_target: set[int] = set()
    for overlap, predicted_index, target_index in sorted(candidates, reverse=True):
        if predicted_index in matched_predicted or target_index in matched_target:
            continue
        matched_predicted.add(predicted_index)
        matched_target.add(target_index)
    precision = len(matched_predicted) / len(predicted) if predicted else 0.0
    recall = len(matched_target) / len(target) if target else 0.0
    return {
        "minimum_overlap_seconds": minimum_overlap_seconds,
        "predicted_count": len(predicted),
        "target_count": len(target),
        "matched_count": len(matched_predicted),
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(2 * precision * recall / (precision + recall), 6) if precision + recall else 0.0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark TTcut's local TrackNet rally path.")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--confidence-threshold", type=float, default=TRACKNET_CONFIDENCE_THRESHOLD)
    parser.add_argument("--roi-scale", type=float, default=TRACKNET_ROI_MODEL_SCALE)
    args = parser.parse_args()

    calibration, target_rallies = load_target(args.target)
    roi = build_analysis_roi(calibration)
    source_hash = sha256(args.video)

    import cv2
    import numpy as np
    import torch

    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    total_started = time.perf_counter()
    load_started = time.perf_counter()
    loaded = load_tracknet(args.weights, args.device)
    model_load_seconds = time.perf_counter() - load_started
    predictor = TrackNetPredictor(
        loaded,
        confidence_threshold=args.confidence_threshold,
        roi_model_scale=args.roi_scale,
    )
    points, info, stats = predictor.predict(args.video, analysis_roi=roi)
    postprocess_started = time.perf_counter()
    motion_config = VisibilityMotionConfig(
        analysis_width_pixels=roi.width,
        analysis_height_pixels=roi.height,
        vertical_exchange_enabled=is_end_on_table_view(calibration.points),
    )
    shared_visibility = continuous_visibility_rallies(
        points,
        float(info.fps or 0.0),
        motion_config=motion_config,
    )
    visibility = tracknet_visibility_rallies(
        points,
        float(info.fps or 0.0),
        calibration,
        motion_config=motion_config,
    )
    bounce_frames = detect_tracknet_bounce_frames(points, calibration)
    bounce = group_rallies(bounce_frames, points)
    postprocess_seconds = time.perf_counter() - postprocess_started
    visibility_intervals = [(rally.start_time, rally.end_time) for rally in visibility]
    bounce_intervals = [(rally.start_time, rally.end_time) for rally in bounce]

    payload = {
        "schema_version": 1,
        "inputs": {
            "video": str(args.video.resolve()),
            "video_sha256": source_hash,
            "profile": "tracknet_v1",
            "weights": str(args.weights.resolve()),
            "weights_sha256": sha256(args.weights),
            "target": str(args.target.resolve()),
            "confidence_threshold": args.confidence_threshold,
            "roi_scale": args.roi_scale,
            "analysis_roi": asdict(roi),
            "model_size": [stats.model_width, stats.model_height],
        },
        "environment": {
            "windows": platform.platform(),
            "python": platform.python_version(),
            "pytorch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else None,
            "opencv": cv2.__version__,
            "numpy": np.__version__,
        },
        "timing": {
            "model_load_seconds": model_load_seconds,
            "postprocess_seconds": postprocess_seconds,
            "complete_analysis_seconds": time.perf_counter() - total_started,
            "peak_cuda_memory_bytes": int(torch.cuda.max_memory_allocated()) if args.device == "cuda" else 0,
            **asdict(stats),
        },
        "video": {
            "fps": info.fps,
            "duration_seconds": info.duration,
            "frames": info.decoded_frame_count,
        },
        "target_rallies": target_rallies,
        "visibility_rallies": [asdict(rally) for rally in visibility],
        "shared_visibility_rallies": [asdict(rally) for rally in shared_visibility],
        "bounce_rallies": [asdict(rally) for rally in bounce],
        "comparison": {
            "continuous_visibility": matching_summary(visibility_intervals, target_rallies),
            "continuous_visibility_temporal_overlap": overlap_matching_summary(
                visibility_intervals, target_rallies,
            ),
            "bounce_events": matching_summary(bounce_intervals, target_rallies),
        },
        "trajectory": [asdict(point) for point in points],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"timing": payload["timing"], "comparison": payload["comparison"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
