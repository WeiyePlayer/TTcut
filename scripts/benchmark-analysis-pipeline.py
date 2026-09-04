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

from ttcut_worker.blurball_bounce import detect_blurball_bounce_frames  # noqa: E402
from ttcut_worker.blurball_models import load_blurball  # noqa: E402
from ttcut_worker.blurball_predictor import BlurBallPredictor  # noqa: E402
from ttcut_worker.blurball_rallies import blurball_visibility_rallies  # noqa: E402
from ttcut_worker.calibration import TableCalibration  # noqa: E402
from ttcut_worker.rallies import group_rallies  # noqa: E402
from ttcut_worker.roi import build_analysis_roi  # noqa: E402
from ttcut_worker.visibility_rallies import VisibilityMotionConfig, is_end_on_table_view  # noqa: E402


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_calibration(path: Path) -> TableCalibration:
    payload = json.loads(path.read_text(encoding="utf-8"))
    calibration = payload.get("calibration", payload)
    if "points" in calibration:
        points = calibration["points"]
        ordered = [
            points[name]
            for name in ("top_left", "top_right", "bottom_right", "bottom_left")
        ]
        return TableCalibration.from_points(
            calibration["video_width"], calibration["video_height"], ordered
        )

    video_info = payload.get("video_info", {})
    homography = payload.get("planar_homography", {})
    ordered = homography.get("image_points")
    if not ordered or len(ordered) != 4:
        raise ValueError(
            "Calibration must contain calibration.points or four "
            "planar_homography.image_points."
        )
    return TableCalibration.from_points(video_info["width"], video_info["height"], ordered)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a reproducible TTcut BlurBall analysis benchmark.")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--weights", type=Path, default=PROJECT_ROOT / "resources" / "models" / "blurball_best.pt")
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--confidence-threshold", type=float)
    args = parser.parse_args()
    if args.batch_size is not None and args.batch_size <= 0:
        parser.error("--batch-size must be positive")
    if args.confidence_threshold is not None and not 0.0 < args.confidence_threshold < 1.0:
        parser.error("--confidence-threshold must be between zero and one")

    calibration = read_calibration(args.calibration)
    roi = build_analysis_roi(calibration)
    source_before = sha256(args.video)
    source_size_before = args.video.stat().st_size
    import cv2
    import numpy as np
    import torch

    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    loaded = load_blurball(args.weights, args.device)
    predictor_kwargs = {"batch_size": args.batch_size}
    if args.confidence_threshold is not None:
        predictor_kwargs["confidence_threshold"] = args.confidence_threshold
    predictor = BlurBallPredictor(loaded, **predictor_kwargs)
    model_load_seconds = time.perf_counter() - started
    points, info, stats = predictor.predict(args.video, analysis_roi=roi)
    bounces = detect_blurball_bounce_frames(points, calibration)
    visibility_rallies = blurball_visibility_rallies(
        points,
        float(info.fps or 0.0),
        calibration,
        motion_config=VisibilityMotionConfig(
            analysis_width_pixels=roi.width,
            analysis_height_pixels=roi.height,
            vertical_exchange_enabled=is_end_on_table_view(calibration.points),
        ),
    )
    payload = {
        "inputs": {
            "video": str(args.video.resolve()),
            "video_sha256_before": source_before,
            "video_sha256_after": sha256(args.video),
            "video_size_before": source_size_before,
            "video_size_after": args.video.stat().st_size,
            "profile": "blurball_v1",
            "weights": str(args.weights.resolve()),
            "weights_sha256": sha256(args.weights),
            "calibration": str(args.calibration.resolve()),
            "batch_size": predictor.batch_size,
            "confidence_threshold": stats.confidence_threshold,
            "sequence_length": 3,
            "analysis_roi": asdict(roi),
            "model_size": [stats.model_width, stats.model_height],
        },
        "environment": {
            "windows": platform.platform(), "python": platform.python_version(),
            "pytorch": torch.__version__, "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else None,
            "opencv": cv2.__version__, "numpy": np.__version__,
        },
        "timing": {
            "model_load_seconds": model_load_seconds,
            "complete_analysis_seconds": time.perf_counter() - started,
            "peak_cuda_memory_bytes": int(torch.cuda.max_memory_allocated()) if args.device == "cuda" else 0,
            **asdict(stats),
        },
        "output": {
            "video": {
                "fps": float(info.fps or 0.0),
                "duration_seconds": float(info.duration or 0.0),
                "decoded_frame_count": info.decoded_frame_count,
            },
            "frames": info.decoded_frame_count,
            "visible_frames": sum(point.visibility for point in points),
            "bounce_frames": bounces,
            "rallies": [asdict(rally) for rally in group_rallies(bounces, points)],
            "visibility_rallies": [asdict(rally) for rally in visibility_rallies],
            "trajectory": [asdict(point) for point in points],
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["timing"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
