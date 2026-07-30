from __future__ import annotations

import json
import math
import os
import sys
import traceback
import uuid

from .bounce import detect_bounce_frames
from .calibration import TableCalibration
from .errors import InvalidRequestError, ModelResourceError, TableModelResourceError, WorkerError
from .model import load_tracknet
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
    weight_path = os.environ.get("TTCUT_TRACKNET_WEIGHTS", "").strip()
    if not weight_path:
        raise ModelResourceError("Bundled analysis model path is not configured.")
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 0, "total": 1, "percent": 0.0})
    loaded = load_tracknet(weight_path, request["device"])
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 1, "total": 1, "percent": 100.0})

    def progress(current: int, total: int) -> None:
        percent = min(99.9, current / total * 100) if total else 0.0
        emit({
            "type": "progress", "task_id": task_id, "stage": "analysis",
            "current": current, "total": total, "percent": round(percent, 4),
        })

    points, info, _stats = TrackNetPredictor(loaded).predict(
        request["video_path"],
        progress_callback=progress,
        analysis_roi=analysis_roi,
    )
    emit({"type": "progress", "task_id": task_id, "stage": "postprocess", "current": 0, "total": 1, "percent": 0.0})
    bounce_frames = detect_bounce_frames(points, calibration)
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
