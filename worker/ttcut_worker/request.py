from __future__ import annotations

import math
import uuid
from pathlib import Path

from .errors import InvalidRequestError


def validate_request(value: object) -> dict:
    expected_fields = {
        "schema_version",
        "task_id",
        "video_path",
        "device",
        "video_metadata",
        "calibration_choice",
    }
    if not isinstance(value, dict) or set(value) != expected_fields or value.get("schema_version") != 1:
        raise InvalidRequestError("Unsupported analysis request schema.")
    try:
        uuid.UUID(str(value["task_id"]))
        if value["device"] not in {"auto", "cuda", "cpu"}:
            raise ValueError("device")
        if not isinstance(value["video_path"], str) or Path(value["video_path"]).suffix.lower() != ".mp4":
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
