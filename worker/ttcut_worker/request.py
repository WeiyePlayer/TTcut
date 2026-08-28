from __future__ import annotations

import math
import uuid
from pathlib import Path

from .errors import InvalidRequestError


BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT = 0.7
BLURBALL_CONFIDENCE_THRESHOLD_MIN = 0.1
BLURBALL_CONFIDENCE_THRESHOLD_MAX = 0.95
RALLY_RECOGNITION_METHOD_DEFAULT = "bounce_events"
RALLY_RECOGNITION_METHODS = {"bounce_events", "continuous_visibility"}


def validate_request(value: object) -> dict:
    base_fields = {
        "schema_version",
        "task_id",
        "video_path",
        "device",
        "video_metadata",
        "calibration_choice",
    }
    if not isinstance(value, dict) or value.get("schema_version") not in {1, 2, 3}:
        raise InvalidRequestError("Unsupported analysis request schema.")
    version = value["schema_version"]
    threshold_field = "blurball_confidence_threshold"
    if version == 1:
        if set(value) not in (base_fields, base_fields | {threshold_field}):
            raise InvalidRequestError("Unsupported analysis request schema fields.")
    elif version == 2:
        if set(value) != base_fields | {"analysis"}:
            raise InvalidRequestError("Unsupported analysis request schema fields.")
    else:
        if set(value) != base_fields | {"analysis", "rally_recognition"}:
            raise InvalidRequestError("Unsupported analysis request schema fields.")
    try:
        uuid.UUID(str(value["task_id"]))
        if value["device"] not in {"auto", "cuda", "cpu"}:
            raise ValueError("device")
        if (
            not isinstance(value["video_path"], str)
            or Path(value["video_path"]).suffix.lower() not in {".mp4", ".mov"}
        ):
            raise ValueError("video_path")
        metadata = value["video_metadata"]
        if not isinstance(metadata, dict) or set(metadata) != {
            "duration_seconds",
            "fps",
            "frame_count",
            "variable_frame_rate",
        }:
            raise ValueError("video_metadata")
        if (
            not isinstance(metadata["duration_seconds"], (int, float))
            or isinstance(metadata["duration_seconds"], bool)
            or not math.isfinite(metadata["duration_seconds"])
            or metadata["duration_seconds"] <= 0
        ):
            raise ValueError("duration_seconds")
        if (
            not isinstance(metadata["fps"], (int, float))
            or isinstance(metadata["fps"], bool)
            or not math.isfinite(metadata["fps"])
            or metadata["fps"] <= 0
        ):
            raise ValueError("fps")
        frame_count = metadata["frame_count"]
        if frame_count is not None and (
            not isinstance(frame_count, int)
            or isinstance(frame_count, bool)
            or frame_count <= 0
        ):
            raise ValueError("frame_count")
        if not isinstance(metadata["variable_frame_rate"], bool):
            raise ValueError("variable_frame_rate")
        if version == 1:
            confidence_threshold = value.get(threshold_field, BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT)
            _validate_threshold(confidence_threshold, threshold_field)
        else:
            analysis = value["analysis"]
            if not isinstance(analysis, dict) or analysis.get("mode") not in {"full", "two_stage"}:
                raise ValueError("analysis")
            if analysis["mode"] == "full":
                if set(analysis) != {"mode", "confidence_threshold"}:
                    raise ValueError("analysis")
                _validate_threshold(analysis["confidence_threshold"], "confidence_threshold")
            else:
                if set(analysis) != {"mode", "stage1_confidence_threshold", "stage2_confidence_threshold"}:
                    raise ValueError("analysis")
                _validate_threshold(analysis["stage1_confidence_threshold"], "stage1_confidence_threshold")
                _validate_threshold(analysis["stage2_confidence_threshold"], "stage2_confidence_threshold")
            if version == 3:
                recognition = value["rally_recognition"]
                if (
                    not isinstance(recognition, dict)
                    or set(recognition) != {"method"}
                    or recognition["method"] not in RALLY_RECOGNITION_METHODS
                ):
                    raise ValueError("rally_recognition")
        choice = value["calibration_choice"]
        if not isinstance(choice, dict) or choice.get("method") not in {"manual", "automatic", "precalibrated"}:
            raise ValueError("calibration_choice")
        if choice["method"] == "automatic":
            if set(choice) != {"method"}:
                raise ValueError("automatic calibration_choice")
        else:
            expected_choice_fields = {"method", "calibration"}
            if choice["method"] == "precalibrated":
                if set(choice) not in (expected_choice_fields, expected_choice_fields | {"table_analysis"}):
                    raise ValueError("precalibrated calibration_choice")
            elif set(choice) != expected_choice_fields:
                raise ValueError(f"{choice['method']} calibration_choice")
            calibration = choice["calibration"]
            if not isinstance(calibration, dict) or set(calibration) != {"video_width", "video_height", "points"}:
                raise ValueError("calibration")
            if not isinstance(calibration["video_width"], int) or isinstance(calibration["video_width"], bool) or calibration["video_width"] <= 0:
                raise ValueError("video_width")
            if not isinstance(calibration["video_height"], int) or isinstance(calibration["video_height"], bool) or calibration["video_height"] <= 0:
                raise ValueError("video_height")
            points = calibration["points"]
            if not isinstance(points, dict) or set(points) != {"top_left", "top_right", "bottom_right", "bottom_left"}:
                raise ValueError("points")
            for point_name, point in points.items():
                if not isinstance(point, (list, tuple)) or len(point) != 2:
                    raise ValueError(point_name)
                if any(
                    not isinstance(coordinate, (int, float))
                    or isinstance(coordinate, bool)
                    or not math.isfinite(coordinate)
                    for coordinate in point
                ):
                    raise ValueError(point_name)
            if choice["method"] == "precalibrated" and "table_analysis" in choice and not isinstance(choice["table_analysis"], dict):
                raise ValueError("table_analysis")
    except (KeyError, TypeError, ValueError) as exc:
        raise InvalidRequestError("Analysis request fields are invalid.") from exc
    return value


def _validate_threshold(value: object, name: str) -> None:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or not BLURBALL_CONFIDENCE_THRESHOLD_MIN <= value <= BLURBALL_CONFIDENCE_THRESHOLD_MAX
    ):
        raise ValueError(name)


def analysis_config(request: dict) -> dict:
    """Return the normalized BlurBall mode config while preserving v1 requests."""
    if request.get("schema_version") == 1:
        return {
            "mode": "full",
            "confidence_threshold": request.get(
                "blurball_confidence_threshold",
                BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT,
            ),
        }
    return request["analysis"]


def rally_recognition_config(request: dict) -> dict:
    """Return the recognition method while preserving v1/v2 request behavior."""
    if request.get("schema_version") != 3:
        return {"method": RALLY_RECOGNITION_METHOD_DEFAULT}
    return request["rally_recognition"]
