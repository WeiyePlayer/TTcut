from __future__ import annotations

import json
import os
import sys
import traceback
import uuid

from .errors import InvalidRequestError, TableModelResourceError, WorkerError
from .request import validate_request
from .table_analyze import analyze_table


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def calibrate(request: dict) -> dict:
    task_id = request["task_id"]
    if request["calibration_choice"]["method"] != "automatic":
        raise InvalidRequestError("Calibration worker requires automatic calibration.")
    table_weight_path = os.environ.get("TTCUT_TABLE_ANALYZE_WEIGHTS", "").strip()
    if not table_weight_path:
        raise TableModelResourceError("Bundled table analysis model path is not configured.")

    def table_progress(stage: str, current: int, total: int) -> None:
        percent = min(100.0, current / total * 100) if total else 0.0
        emit({
            "type": "progress",
            "task_id": task_id,
            "stage": stage,
            "current": current,
            "total": total,
            "percent": round(percent, 4),
        })

    calibration, table_analysis = analyze_table(
        request["video_path"],
        table_weight_path,
        request["device"],
        request["video_metadata"],
        table_progress,
    )
    return {
        "calibration": {
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
        "table_analysis": table_analysis,
    }


def main() -> int:
    task_id = str(uuid.UUID(int=0))
    traceback_text = ""
    try:
        line = sys.stdin.readline()
        if not line:
            raise InvalidRequestError("No calibration request was provided.")
        request = validate_request(json.loads(line))
        task_id = request["task_id"]
        result = calibrate(request)
        emit({"type": "result", "task_id": task_id, "data": result})
        return 0
    except json.JSONDecodeError as exc:
        error: Exception = InvalidRequestError("Calibration request is not valid JSON.")
        error.__cause__ = exc
        traceback_text = "".join(traceback.format_exception(error))
    except Exception as exc:  # Worker boundary converts every failure to one event.
        error = exc
        traceback_text = traceback.format_exc()
    code = error.code if isinstance(error, WorkerError) else "AUTO_CALIBRATION_FAILED"
    recoverable = error.recoverable if isinstance(error, WorkerError) else True
    print(traceback_text or f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
    emit({
        "type": "error",
        "task_id": task_id,
        "code": code,
        "message": str(error) or code,
        "recoverable": recoverable,
    })
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
