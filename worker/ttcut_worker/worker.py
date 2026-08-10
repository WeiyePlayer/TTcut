from __future__ import annotations

import json
import math
import os
import sys
import traceback
import uuid

from .bounce import detect_bounce_frames
from .blurball_bounce import detect_blurball_bounce_frames
from .blurball_models import load_blurball
from .blurball_predictor import BlurBallPredictor
from .calibration import TableCalibration
from .errors import InvalidRequestError, ModelResourceError, TableModelResourceError, WorkerError
from .model import load_tracknet
from .dual_models import load_dual_models
from .dual_predictor import UpliftingDualPredictor
from .predictor import TrackNetPredictor
from .roi import AnalysisRoiConfig, build_analysis_roi
from .rallies import group_rallies
from .request import validate_request
from .table_analyze import analyze_table


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def analyze(request: dict) -> dict:
    task_id = request["task_id"]
    choice = request["calibration_choice"]
    table_analysis = None
    if choice["method"] == "automatic":
        table_weight_path = os.environ.get("TTCUT_TABLE_ANALYZE_WEIGHTS", "").strip()
        if not table_weight_path:
            raise TableModelResourceError("Bundled table analysis model path is not configured.")

        def table_progress(stage: str, current: int, total: int) -> None:
            percent = min(100.0, current / total * 100) if total else 0.0
            emit({
                "type": "progress", "task_id": task_id, "stage": stage,
                "current": current, "total": total, "percent": round(percent, 4),
            })

        calibration, table_analysis = analyze_table(
            request["video_path"],
            table_weight_path,
            request["device"],
            request["video_metadata"],
            table_progress,
        )
    else:
        calibration_value = choice["calibration"]
        calibration = TableCalibration.from_points(
            calibration_value["video_width"], calibration_value["video_height"], calibration_value["points"],
        )
    analysis_roi = build_analysis_roi(calibration, AnalysisRoiConfig())
    profile = request.get("ball_model_profile", "tracknet_v1")
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 0, "total": 1, "percent": 0.0})
    if profile == "tracknet_v1":
        weight_path = os.environ.get("TTCUT_TRACKNET_WEIGHTS", "").strip()
        if not weight_path:
            raise ModelResourceError("Bundled analysis model path is not configured.")
        loaded = load_tracknet(weight_path, request["device"])
        predictor = TrackNetPredictor(loaded)
    elif profile == "uplifting_dual_v1":
        main_path = os.environ.get("TTCUT_DUAL_BALL_MAIN_WEIGHTS", "").strip()
        aux_path = os.environ.get("TTCUT_DUAL_BALL_AUX_WEIGHTS", "").strip()
        if not main_path or not aux_path:
            raise ModelResourceError("Dual ball model paths are not configured.")
        loaded = load_dual_models(main_path, aux_path, request["device"])
        predictor = UpliftingDualPredictor(loaded, batch_size=2)
    else:
        blurball_path = os.environ.get("TTCUT_BLURBALL_WEIGHTS", "").strip()
        if not blurball_path:
            raise ModelResourceError("Bundled BlurBall model path is not configured.")
        loaded = load_blurball(blurball_path, request["device"])
        predictor = BlurBallPredictor(loaded)
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 1, "total": 1, "percent": 100.0})

    def progress(current: int, total: int) -> None:
        percent = min(99.9, current / total * 100) if total else 0.0
        emit({
            "type": "progress", "task_id": task_id, "stage": "analysis",
            "current": current, "total": total, "percent": round(percent, 4),
        })

    points, info, stats = predictor.predict(
        request["video_path"],
        progress_callback=progress,
        analysis_roi=analysis_roi,
    )
    emit({"type": "progress", "task_id": task_id, "stage": "postprocess", "current": 0, "total": 1, "percent": 0.0})
    bounce_frames = (
        detect_blurball_bounce_frames(points, calibration)
        if profile == "blurball_v1"
        else detect_bounce_frames(points, calibration)
    )
    rallies = group_rallies(bounce_frames, points)
    duration = float(info.duration or 0.0)
    normalized = []
    for index, rally in enumerate(rallies, start=1):
        start = max(0.0, float(rally.start_time))
        end = min(duration, float(rally.end_time)) if duration else float(rally.end_time)
        if not all(math.isfinite(value) for value in (start, end)) or end <= start:
            continue
        normalized.append({
            "id": f"rally_{len(normalized) + 1:03d}",
            "index": len(normalized) + 1,
            "bounce_count": rally.bounce_count,
            "start_time_seconds": round(start, 6),
            "end_time_seconds": round(end, 6),
        })
    emit({"type": "progress", "task_id": task_id, "stage": "postprocess", "current": 1, "total": 1, "percent": 100.0})
    result = {
        "schema_version": 1,
        "video": {
            "path": str(info.path),
            "duration_seconds": duration,
            "width": info.width,
            "height": info.height,
            "fps": float(info.fps or 0.0),
            "variable_frame_rate": False,
            "video_codec": "unknown",
            "audio_codec": None,
            "container": info.path.suffix.lower().lstrip("."),
            "frame_count": info.decoded_frame_count,
        },
        "rallies": normalized,
        "calibration": {
            "video_width": calibration.video_width,
            "video_height": calibration.video_height,
            "points": {name: list(point) for name, point in zip(
                ("top_left", "top_right", "bottom_right", "bottom_left"), calibration.points,
            )},
        },
        "model_provenance": {
            "profile": profile,
            "component_version": loaded.component_version if profile != "tracknet_v1" else None,
            "roi": {
                "x": analysis_roi.x0,
                "y": analysis_roi.y0,
                "width": analysis_roi.width,
                "height": analysis_roi.height,
            },
            "main_input": {
                "width": stats.main_width if profile == "uplifting_dual_v1" else stats.model_width,
                "height": stats.main_height if profile == "uplifting_dual_v1" else stats.model_height,
            },
            "aux_input": ({
                "width": stats.aux_width,
                "height": stats.aux_height,
            } if profile == "uplifting_dual_v1" else None),
            **({
                "detection": {
                    "confidence_threshold": stats.confidence_threshold,
                    "step": stats.step,
                    "maximum_displacement_pixels": stats.maximum_displacement_pixels,
                    "landing_region": "expanded_table",
                },
            } if profile == "blurball_v1" else {}),
        },
    }
    if table_analysis is None and choice["method"] == "precalibrated":
        table_analysis = choice.get("table_analysis")
    if table_analysis is not None:
        result["table_analysis"] = table_analysis
    return result


def main() -> int:
    task_id = "00000000-0000-0000-0000-000000000000"
    traceback_text = ""
    try:
        line = sys.stdin.readline()
        if not line:
            raise InvalidRequestError("No analysis request was provided.")
        request = validate_request(json.loads(line))
        task_id = request["task_id"]
        result = analyze(request)
        emit({"type": "result", "task_id": task_id, "data": result})
        return 0
    except json.JSONDecodeError as exc:
        error: Exception = InvalidRequestError("Analysis request is not valid JSON.")
        error.__cause__ = exc
        traceback_text = "".join(traceback.format_exception(error))
    except Exception as exc:  # Worker boundary converts every failure to one event.
        error = exc
        traceback_text = traceback.format_exc()
    code = error.code if isinstance(error, WorkerError) else "ANALYSIS_FAILED"
    recoverable = error.recoverable if isinstance(error, WorkerError) else True
    print(traceback_text or f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
    emit({
        "type": "error", "task_id": task_id, "code": code,
        "message": str(error) or code, "recoverable": recoverable,
    })
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
