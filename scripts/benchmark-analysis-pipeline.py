from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import platform
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = PROJECT_ROOT / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from ttcut_worker.bounce import detect_bounce_frames  # noqa: E402
from ttcut_worker.blurball_bounce import detect_blurball_bounce_frames  # noqa: E402
from ttcut_worker.blurball_models import load_blurball  # noqa: E402
from ttcut_worker.blurball_predictor import BlurBallPredictor  # noqa: E402
from ttcut_worker.calibration import TableCalibration  # noqa: E402
from ttcut_worker.model import load_tracknet  # noqa: E402
from ttcut_worker.dual_models import load_dual_models  # noqa: E402
from ttcut_worker.dual_predictor import UpliftingDualPredictor  # noqa: E402
from ttcut_worker.rallies import group_rallies  # noqa: E402
from ttcut_worker.roi import build_analysis_roi  # noqa: E402

DEFAULT_VIDEO = Path(
    r"D:\DOCUMENTS\TrackNetV3_TableTennis\testvideoes"
    r"\Maharu Yoshimura vs Andrej Gacina - MS Final - WTT Feeder Istanbul 2026.mp4"
)
DEFAULT_CALIBRATION = Path(
    r"D:\DOCUMENTS\table_analyze\outputs\istanbul_2026_calibration"
    r"\Maharu Yoshimura vs Andrej Gacina - MS Final - WTT Feeder Istanbul 2026_calibration.json"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_calibration(path: Path) -> TableCalibration:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if "video_info" in payload:
        width = int(payload["video_info"]["width"])
        height = int(payload["video_info"]["height"])
        points = payload.get("planar_homography", {}).get("image_points")
        if points is None:
            points = payload["calibration"]["points"]
    else:
        calibration = payload["calibration"]
        width = int(calibration["video_width"])
        height = int(calibration["video_height"])
        values = calibration["points"]
        points = [
            values["top_left"],
            values["top_right"],
            values["bottom_right"],
            values["bottom_left"],
        ]
    return TableCalibration.from_points(width, height, points)


def predictor_class(source_ref: str | None):
    if source_ref is None:
        from ttcut_worker.predictor import TrackNetPredictor

        return TrackNetPredictor
    result = subprocess.run(
        [
            "git",
            "show",
            f"{source_ref}:worker/ttcut_worker/predictor.py",
        ],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_loader(
        "ttcut_worker._benchmark_predictor",
        loader=None,
    )
    if spec is None:
        raise RuntimeError("Unable to create the benchmark Predictor module.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    exec(compile(result.stdout, "<benchmark-predictor>", "exec"), module.__dict__)
    return module.TrackNetPredictor


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one reproducible TrackNetPredictor analysis checkpoint.",
    )
    parser.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    parser.add_argument("--calibration", type=Path, default=DEFAULT_CALIBRATION)
    parser.add_argument(
        "--weights",
        type=Path,
        default=PROJECT_ROOT / "resources" / "models" / "analyze.pt",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--profile", choices=("tracknet_v1", "uplifting_dual_v1", "blurball_v1"), default="tracknet_v1")
    parser.add_argument("--dual-main-weights", type=Path)
    parser.add_argument("--dual-aux-weights", type=Path)
    parser.add_argument(
        "--blurball-weights",
        type=Path,
        default=PROJECT_ROOT / "resources" / "models" / "blurball_best.pt",
    )
    parser.add_argument("--blurball-batch-size", type=int)
    parser.add_argument("--model-size", default="280x160")
    parser.add_argument(
        "--predictor-source-ref",
        help="Load predictor.py from this Git ref for equivalence checks.",
    )
    args = parser.parse_args()
    model_size = None
    if args.model_size.lower() != "auto":
        width, height = (
            int(value) for value in args.model_size.lower().split("x", 1)
        )
        model_size = (width, height)
    calibration = read_calibration(args.calibration)
    roi = build_analysis_roi(calibration)
    source_before = sha256(args.video)
    source_size_before = args.video.stat().st_size
    model_hash = sha256(args.weights) if args.profile == "tracknet_v1" else None

    import cv2
    import numpy as np
    import torch

    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    analysis_started = time.perf_counter()
    load_started = analysis_started
    if args.profile == "tracknet_v1":
        loaded = load_tracknet(args.weights, args.device)
        Predictor = predictor_class(args.predictor_source_ref)
        predictor = Predictor(loaded, batch_size=args.batch_size)
    elif args.profile == "uplifting_dual_v1":
        if args.device != "cuda" or args.batch_size != 2 or not args.dual_main_weights or not args.dual_aux_weights:
            parser.error("uplifting_dual_v1 requires CUDA, batch size 2, and both dual weight paths")
        loaded = load_dual_models(args.dual_main_weights, args.dual_aux_weights, args.device)
        predictor = UpliftingDualPredictor(loaded, batch_size=2)
    else:
        if args.blurball_batch_size is not None and args.blurball_batch_size <= 0:
            parser.error("blurball_v1 requires a positive BlurBall batch size")
        loaded = load_blurball(args.blurball_weights, args.device)
        predictor = BlurBallPredictor(loaded, batch_size=args.blurball_batch_size)
    model_load_seconds = time.perf_counter() - load_started
    last_progress = [-1]

    def progress(current: int, total: int) -> None:
        if current == total or current - last_progress[0] >= 1024:
            print(f"predictor: {current}/{total}", flush=True)
            last_progress[0] = current

    if args.profile == "tracknet_v1":
        points, info, stats = predictor.predict(
            args.video, progress_callback=progress, analysis_roi=roi, model_size=model_size,
        )
    else:
        points, info, stats = predictor.predict(
            args.video, progress_callback=progress, analysis_roi=roi,
        )
    point_rows = [asdict(point) for point in points]
    canonical = json.dumps(
        point_rows,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    bounces = (
        detect_blurball_bounce_frames(points, calibration)
        if args.profile == "blurball_v1"
        else detect_bounce_frames(points, calibration)
    )
    rallies = group_rallies(bounces, points)
    complete_analysis_seconds = time.perf_counter() - analysis_started
    payload = {
        "environment": {
            "windows": platform.platform(),
            "python": platform.python_version(),
            "pytorch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else None,
            "opencv": cv2.__version__,
            "numpy": np.__version__,
        },
        "inputs": {
            "video": str(args.video.resolve()),
            "video_sha256_before": source_before,
            "video_sha256_after": sha256(args.video),
            "video_size_before": source_size_before,
            "video_size_after": args.video.stat().st_size,
            "profile": args.profile,
            "weights": (
                str(args.weights.resolve()) if args.profile == "tracknet_v1"
                else str(args.blurball_weights.resolve()) if args.profile == "blurball_v1"
                else {"main": str(args.dual_main_weights.resolve()), "aux": str(args.dual_aux_weights.resolve())}
            ),
            "weights_sha256": (
                model_hash if args.profile == "tracknet_v1"
                else sha256(args.blurball_weights) if args.profile == "blurball_v1"
                else {"main": sha256(args.dual_main_weights), "aux": sha256(args.dual_aux_weights)}
            ),
            "calibration": str(args.calibration.resolve()),
            "batch_size": predictor.batch_size if args.profile == "blurball_v1" else args.batch_size,
            "sequence_length": loaded.seq_len if args.profile == "tracknet_v1" else 3,
            "background_mode": loaded.bg_mode if args.profile == "tracknet_v1" else None,
            "analysis_roi": asdict(roi),
            "model_size": [stats.model_width, stats.model_height] if args.profile == "blurball_v1" else (list(model_size) if model_size else "auto"),
            "predictor_source_ref": args.predictor_source_ref,
        },
        "timing": {
            "model_load_seconds": model_load_seconds,
            "complete_analysis_seconds": complete_analysis_seconds,
            "peak_cuda_memory_bytes": int(torch.cuda.max_memory_allocated()) if args.device == "cuda" else 0,
            **asdict(stats),
        },
        "output": {
            "frames": info.decoded_frame_count,
            "visible_frames": sum(point.visibility for point in points),
            "trajectory_sha256": hashlib.sha256(canonical).hexdigest(),
            "confidences": [point.confidence for point in points],
            "trajectory": point_rows,
            "bounce_frames": bounces,
            "rallies": [asdict(rally) for rally in rallies],
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload["timing"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
