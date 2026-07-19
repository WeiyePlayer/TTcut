from __future__ import annotations

import json
import math
import os
import sys
import traceback
import uuid
from pathlib import Path

from .bounce import detect_bounce_frames
from .calibration import TableCalibration
from .errors import InvalidRequestError, WorkerError, WeightError
from .model import load_tracknet
from .predictor import TrackNetPredictor
from .rallies import group_rallies


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def validate_request(value: object) -> dict:
    expected_fields = {"schema_version", "task_id", "video_path", "device", "calibration"}
    if not isinstance(value, dict) or set(value) != expected_fields or value.get("schema_version") != 1:
        raise InvalidRequestError("Unsupported analysis request schema.")
    try:
        uuid.UUID(str(value["task_id"]))
        if value["device"] not in {"auto", "cuda", "cpu"}:
            raise ValueError("device")
        if not isinstance(value["video_path"], str) or Path(value["video_path"]).suffix.lower() != ".mp4":
            raise ValueError("video_path")
        calibration = value["calibration"]
        if not isinstance(calibration, dict) or set(calibration) != {"video_width", "video_height", "points"}:
            raise ValueError("calibration")
        if not isinstance(calibration["video_width"], int) or isinstance(calibration["video_width"], bool) or calibration["video_width"] <= 0:
            raise ValueError("video_width")
        if not isinstance(calibration["video_height"], int) or isinstance(calibration["video_height"], bool) or calibration["video_height"] <= 0:
            raise ValueError("video_height")
        points = calibration["points"]
        if not isinstance(points, dict) or set(points) != {"top_left", "top_right", "bottom_right", "bottom_left"}:
            raise ValueError("points")
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidRequestError("Analysis request fields are invalid.") from exc
    return value


def analyze(request: dict) -> dict:
    task_id = request["task_id"]
    calibration_value = request["calibration"]
    calibration = TableCalibration.from_points(
        calibration_value["video_width"],
        calibration_value["video_height"],
        calibration_value["points"],
    )
    weight_path = os.environ.get("TTCUT_TRACKNET_WEIGHTS", "").strip()
    if not weight_path:
        raise WeightError("TTCUT_TRACKNET_WEIGHTS is not configured.")
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 0, "total": 1, "percent": 0.0})
    loaded = load_tracknet(weight_path, request["device"])
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 1, "total": 1, "percent": 100.0})

    def progress(current: int, total: int) -> None:
        percent = min(99.9, current / total * 100) if total else 0.0
        emit({
            "type": "progress", "task_id": task_id, "stage": "analysis",
            "current": current, "total": total, "percent": round(percent, 4),
        })

    points, info, _stats = TrackNetPredictor(loaded).predict(request["video_path"], progress_callback=progress)
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
    return {
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
            "container": "mp4",
            "frame_count": info.decoded_frame_count,
        },
        "rallies": normalized,
    }


def main() -> int:
    task_id = "00000000-0000-0000-0000-000000000000"
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
    except Exception as exc:  # Worker boundary converts every failure to one event.
        error = exc
    code = error.code if isinstance(error, WorkerError) else "ANALYSIS_FAILED"
    recoverable = error.recoverable if isinstance(error, WorkerError) else True
    print(traceback.format_exc(), file=sys.stderr, flush=True)
    emit({
        "type": "error", "task_id": task_id, "code": code,
        "message": str(error) or code, "recoverable": recoverable,
    })
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
