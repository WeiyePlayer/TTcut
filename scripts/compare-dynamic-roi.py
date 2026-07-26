from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = PROJECT_ROOT / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from ttcut_worker.bounce import detect_bounce_frames  # noqa: E402
from ttcut_worker.calibration import TableCalibration  # noqa: E402
from ttcut_worker.model import load_tracknet  # noqa: E402
from ttcut_worker.predictor import TrackNetPredictor  # noqa: E402
from ttcut_worker.rallies import group_rallies  # noqa: E402
from ttcut_worker.roi import AnalysisRoiConfig, build_analysis_roi  # noqa: E402
from ttcut_worker.types import TrajectoryPoint  # noqa: E402


DEFAULT_VIDEO = Path(
    r"D:\DOCUMENTS\TrackNetV3_TableTennis\testvideoes"
    r"\Maharu Yoshimura vs Andrej Gacina - MS Final - WTT Feeder Istanbul 2026.mp4"
)
DEFAULT_CALIBRATION = Path(
    r"D:\DOCUMENTS\table_analyze\outputs\istanbul_2026_calibration"
    r"\Maharu Yoshimura vs Andrej Gacina - MS Final - WTT Feeder Istanbul 2026_calibration.json"
)
DEFAULT_WEIGHTS = PROJECT_ROOT / "resources" / "models" / "analyze.pt"
DEFAULT_OUTPUT = PROJECT_ROOT / "artifacts" / "dynamic-roi"
DEFAULT_FFMPEG_CANDIDATES = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "TTcutData"
    / "components"
    / "ffmpeg-x264-N-125716-g1b1f602699"
    / "bin"
    / "ffmpeg.exe",
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "TTcutData"
    / "components"
    / "ffmpeg-8.1"
    / "bin"
    / "ffmpeg.exe",
)


def source_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_calibration(path: Path) -> TableCalibration:
    payload = json.loads(path.read_text(encoding="utf-8"))
    width = int(payload["video_info"]["width"])
    height = int(payload["video_info"]["height"])
    points = payload.get("planar_homography", {}).get("image_points")
    if points is None:
        points = payload["calibration"]["points"]
    return TableCalibration.from_points(width, height, points)


def run_prediction(
    label,
    loaded,
    video: Path,
    calibration: TableCalibration,
    roi,
    batch_size: int,
):
    last_progress = [-1]

    def progress(current: int, total: int) -> None:
        if current == total or current - last_progress[0] >= 1000:
            print(f"{label}: {current}/{total}", flush=True)
            last_progress[0] = current

    started = time.perf_counter()
    points, info, stats = TrackNetPredictor(loaded, batch_size=batch_size).predict(
        video,
        progress_callback=progress,
        analysis_roi=roi,
    )
    summary = prediction_summary(points, calibration, stats)
    summary["end_to_end_seconds"] = time.perf_counter() - started
    return points, info, stats, summary


def prediction_summary(points: list[TrajectoryPoint], calibration: TableCalibration, stats):
    visible = [point for point in points if point.visibility]
    bounces = detect_bounce_frames(points, calibration)
    rallies = group_rallies(bounces, points)
    return {
        "frames": len(points),
        "visible_frames": len(visible),
        "visible_ratio": len(visible) / len(points) if points else 0.0,
        "bounce_frames": bounces,
        "bounce_count": len(bounces),
        "rallies": [
            {
                "start_frame": item.start_frame,
                "end_frame": item.end_frame,
                "start_time": item.start_time,
                "end_time": item.end_time,
                "bounce_count": item.bounce_count,
            }
            for item in rallies
        ],
        "rally_count": len(rallies),
        "stats": asdict(stats),
    }


def point_comparison(baseline: list[TrajectoryPoint], roi: list[TrajectoryPoint]):
    common = [
        math.hypot(first.x - second.x, first.y - second.y)
        for first, second in zip(baseline, roi)
        if first.visibility and second.visibility
    ]
    common.sort()
    if not common:
        return {"common_visible_frames": 0, "mean_source_px": None, "median_source_px": None, "p95_source_px": None}
    return {
        "common_visible_frames": len(common),
        "mean_source_px": float(np.mean(common)),
        "median_source_px": float(np.median(common)),
        "p95_source_px": float(np.percentile(common, 95)),
    }


def frame_set_comparison(baseline: list[int], roi: list[int]):
    baseline_set = set(baseline)
    roi_set = set(roi)
    return {
        "common_frames": sorted(baseline_set & roi_set),
        "baseline_only_frames": sorted(baseline_set - roi_set),
        "roi_only_frames": sorted(roi_set - baseline_set),
        "common_count": len(baseline_set & roi_set),
        "baseline_only_count": len(baseline_set - roi_set),
        "roi_only_count": len(roi_set - baseline_set),
    }


def read_frame(video: Path, index: int):
    capture = cv2.VideoCapture(str(video))
    try:
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if not ok or frame is None:
            raise RuntimeError(f"Unable to read representative frame {index}.")
        return frame
    finally:
        capture.release()


def draw_diagnostics(
    video: Path,
    frame_index: int,
    points: list[TrajectoryPoint],
    roi,
    output: Path,
    model_width: int,
    model_height: int,
) -> None:
    frame = read_frame(video, frame_index)
    crop = frame[roi.y0:roi.y1, roi.x0:roi.x1]
    model_input = cv2.resize(
        crop,
        (model_width, model_height),
        interpolation=cv2.INTER_LINEAR,
    )
    cv2.imwrite(str(output / "roi_input_frame.png"), model_input)

    overlay = frame.copy()
    cv2.rectangle(overlay, (roi.x0, roi.y0), (roi.x1 - 1, roi.y1 - 1), (255, 180, 0), 3)
    recent_points = points[max(0, frame_index - 120):frame_index + 1]
    for first, second in zip(recent_points, recent_points[1:]):
        if first.visibility and second.visibility:
            cv2.line(overlay, (first.x, first.y), (second.x, second.y), (0, 220, 80), 3)
    current = points[frame_index]
    if current.visibility:
        cv2.circle(overlay, (current.x, current.y), 10, (0, 0, 255), -1)
    cv2.putText(
        overlay,
        f"frame={frame_index} roi={roi.width}x{roi.height} tensor={model_width}x{model_height}",
        (24, 42),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.9,
        (0, 255, 255),
        2,
        cv2.LINE_AA,
    )
    cv2.imwrite(str(output / "trajectory_overlay.png"), overlay)


def resolve_ffmpeg(explicit: Path | None) -> Path:
    if explicit is not None:
        if not explicit.is_file():
            raise RuntimeError(f"FFmpeg does not exist: {explicit}")
        return explicit
    command = shutil.which("ffmpeg")
    if command:
        return Path(command)
    for candidate in DEFAULT_FFMPEG_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise RuntimeError("FFmpeg is required to render annotated videos.")


def _annotate_frame(
    source: np.ndarray,
    points: list[TrajectoryPoint],
    frame_index: int,
    label: str,
    roi=None,
    trail_frames: int = 90,
) -> np.ndarray:
    annotated = source.copy()
    if roi is not None:
        cv2.rectangle(
            annotated,
            (roi.x0, roi.y0),
            (roi.x1 - 1, roi.y1 - 1),
            (255, 180, 0),
            3,
        )
    trail = deque(
        points[max(0, frame_index - trail_frames):frame_index + 1],
        maxlen=trail_frames + 1,
    )
    for first, second in zip(trail, list(trail)[1:]):
        if first.visibility and second.visibility:
            cv2.line(
                annotated,
                (first.x, first.y),
                (second.x, second.y),
                (0, 220, 80),
                3,
                cv2.LINE_AA,
            )
    current = points[frame_index]
    status = "missing"
    if current.visibility:
        cv2.circle(
            annotated,
            (current.x, current.y),
            10,
            (0, 0, 255),
            -1,
            cv2.LINE_AA,
        )
        cv2.circle(
            annotated,
            (current.x, current.y),
            14,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )
        status = f"ball=({current.x},{current.y}) confidence={current.confidence:.3f}"
    cv2.rectangle(annotated, (16, 14), (780, 82), (0, 0, 0), -1)
    cv2.putText(
        annotated,
        f"{label}  frame={frame_index}",
        (28, 42),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (0, 255, 255),
        2,
        cv2.LINE_AA,
    )
    cv2.putText(
        annotated,
        status,
        (28, 72),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.7,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )
    return annotated


def _start_encoder(
    ffmpeg: Path,
    source_video: Path,
    output_video: Path,
    width: int,
    height: int,
    fps: float,
) -> subprocess.Popen:
    command = [
        str(ffmpeg),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-video_size",
        f"{width}x{height}",
        "-framerate",
        f"{fps:.12g}",
        "-i",
        "pipe:0",
        "-i",
        str(source_video),
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-shortest",
        "-movflags",
        "+faststart",
        str(output_video),
    ]
    return subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def render_annotated_videos(
    video: Path,
    baseline_points: list[TrajectoryPoint],
    roi_points: list[TrajectoryPoint],
    roi,
    output: Path,
    ffmpeg: Path,
) -> None:
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open video for annotation: {video}")
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if width <= 0 or height <= 0 or fps <= 0:
        capture.release()
        raise RuntimeError("Source video metadata is invalid for annotation.")
    outputs = (
        output / "full_frame_trajectory.mp4",
        output / "dynamic_roi_trajectory.mp4",
    )
    encoders = (
        _start_encoder(ffmpeg, video, outputs[0], width, height, fps),
        _start_encoder(ffmpeg, video, outputs[1], width, height, fps),
    )
    frame_index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok or frame is None:
                break
            if frame_index >= len(baseline_points) or frame_index >= len(roi_points):
                raise RuntimeError("Decoded annotation frames exceed prediction count.")
            baseline_frame = _annotate_frame(
                frame,
                baseline_points,
                frame_index,
                "Full-frame baseline",
            )
            roi_frame = _annotate_frame(
                frame,
                roi_points,
                frame_index,
                "Dynamic ROI",
                roi,
            )
            for encoder, annotated in zip(encoders, (baseline_frame, roi_frame)):
                if encoder.stdin is None:
                    raise RuntimeError("FFmpeg annotation pipe is unavailable.")
                encoder.stdin.write(annotated.tobytes())
            frame_index += 1
            if frame_index % 1000 == 0:
                print(f"annotated-video: {frame_index}/{len(baseline_points)}", flush=True)
        if frame_index != len(baseline_points) or frame_index != len(roi_points):
            raise RuntimeError(
                f"Annotation frame count mismatch: decoded={frame_index}, "
                f"baseline={len(baseline_points)}, roi={len(roi_points)}",
            )
    finally:
        capture.release()
        for encoder in encoders:
            if encoder.stdin is not None:
                encoder.stdin.close()
    failures = []
    for output_video, encoder in zip(outputs, encoders):
        stderr = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
        return_code = encoder.wait()
        if return_code:
            failures.append(f"{output_video.name}: {stderr.strip() or return_code}")
    if failures:
        raise RuntimeError("FFmpeg annotation failed: " + "; ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare TTcut full-frame and dynamic ROI TrackNet analysis.")
    parser.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    parser.add_argument("--calibration", type=Path, default=DEFAULT_CALIBRATION)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="cuda")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--height-ratio", type=float, default=AnalysisRoiConfig().height_ratio)
    parser.add_argument("--length-margin-ratio", type=float, default=AnalysisRoiConfig().length_margin_ratio)
    parser.add_argument("--width-margin-ratio", type=float, default=AnalysisRoiConfig().width_margin_ratio)
    parser.add_argument("--render-videos", action="store_true")
    parser.add_argument("--ffmpeg", type=Path)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    source_hash_before = source_sha256(args.video)
    checkpoint_hash = source_sha256(args.weights)
    calibration = read_calibration(args.calibration)
    analysis_config = AnalysisRoiConfig(
        height_ratio=args.height_ratio,
        length_margin_ratio=args.length_margin_ratio,
        width_margin_ratio=args.width_margin_ratio,
    )
    roi = build_analysis_roi(calibration, analysis_config)
    model_load_started = time.perf_counter()
    loaded = load_tracknet(args.weights, args.device)
    model_load_seconds = time.perf_counter() - model_load_started

    baseline_points, info, baseline_stats, baseline_summary = run_prediction(
        "full-frame", loaded, args.video, calibration, None, args.batch_size,
    )
    roi_points, _, roi_stats, roi_summary = run_prediction(
        "dynamic-roi", loaded, args.video, calibration, roi, args.batch_size,
    )
    representative_frame = max(0, min(len(roi_points) - 1, len(roi_points) // 2))
    draw_diagnostics(
        args.video,
        representative_frame,
        roi_points,
        roi,
        args.output,
        roi_stats.model_width,
        roi_stats.model_height,
    )
    if args.render_videos:
        render_annotated_videos(
            args.video,
            baseline_points,
            roi_points,
            roi,
            args.output,
            resolve_ffmpeg(args.ffmpeg),
        )
    source_hash_after = source_sha256(args.video)
    bounce_comparison = frame_set_comparison(
        baseline_summary["bounce_frames"],
        roi_summary["bounce_frames"],
    )
    point_differences = point_comparison(baseline_points, roi_points)

    report = {
        "video": str(args.video),
        "source_sha256_before": source_hash_before,
        "source_sha256_after": source_hash_after,
        "source_unchanged": source_hash_before == source_hash_after,
        "run_config": {
            "checkpoint": str(args.weights),
            "checkpoint_sha256": checkpoint_hash,
            "device": str(loaded.device),
            "batch_size": args.batch_size,
            "sequence_length": loaded.seq_len,
            "background_mode": loaded.bg_mode,
            "model_load_seconds": model_load_seconds,
        },
        "calibration": calibration.to_dict() if hasattr(calibration, "to_dict") else {
            "video_width": calibration.video_width,
            "video_height": calibration.video_height,
            "points": {
                name: list(point)
                for name, point in zip(
                    ("top_left", "top_right", "bottom_right", "bottom_left"),
                    calibration.points,
                )
            },
        },
        "roi": {
            "config": asdict(analysis_config),
            "bbox": list(roi.bbox),
            "width": roi.width,
            "height": roi.height,
            "projected_polygon": [list(point) for point in roi.projected_polygon],
            "top_padding_pixels": roi.top_padding_pixels,
        },
        "full_frame": baseline_summary,
        "dynamic_roi": roi_summary,
        "point_comparison": point_differences,
        "bounce_frame_comparison": bounce_comparison,
        "differences": {
            "visible_frame_delta": (
                roi_summary["visible_frames"] - baseline_summary["visible_frames"]
            ),
            "bounce_count_delta": (
                roi_summary["bounce_count"] - baseline_summary["bounce_count"]
            ),
            "rally_count_delta": (
                roi_summary["rally_count"] - baseline_summary["rally_count"]
            ),
        },
        "representative_frame": representative_frame,
    }
    (args.output / "metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
