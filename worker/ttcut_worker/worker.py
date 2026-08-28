from __future__ import annotations

import json
import math
import os
import sys
import traceback

from .blurball_bounce import detect_blurball_bounce_frames
from .blurball_models import load_blurball
from .blurball_predictor import BlurBallPredictor
from .analysis_intervals import REFINEMENT_EXPANSION_SECONDS, expanded_union_intervals
from .calibration import TableCalibration
from .errors import InvalidRequestError, ModelResourceError, TableModelResourceError, WorkerError
from .roi import AnalysisRoiConfig, build_analysis_roi
from .rallies import group_rallies
from .request import (
    BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT,
    analysis_config,
    rally_recognition_config,
    validate_request,
)
from .table_analyze import analyze_table
from .visibility_rallies import (
    CONTINUOUS_VISIBILITY_END_SECONDS,
    CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_DISPLACEMENT_RATIO,
    CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SECONDS,
    CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SPEED_RATIO_PER_SECOND,
    CONTINUOUS_VISIBILITY_MAX_MONOTONIC_VERTICAL_REVERSALS,
    CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS,
    CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
    CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_TO_VERTICAL_RANGE_RATIO,
    CONTINUOUS_VISIBILITY_MIN_MONOTONIC_HORIZONTAL_RANGE_RATIO,
    CONTINUOUS_VISIBILITY_START_SECONDS,
    VisibilityMotionConfig,
    continuous_visibility_rallies,
)


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
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 0, "total": 1, "percent": 0.0})
    blurball_path = os.environ.get("TTCUT_BLURBALL_WEIGHTS", "").strip()
    if not blurball_path:
        raise ModelResourceError("Bundled BlurBall model path is not configured.")
    loaded = load_blurball(blurball_path, request["device"])
    emit({"type": "progress", "task_id": task_id, "stage": "load_model", "current": 1, "total": 1, "percent": 100.0})

    config = analysis_config(request)
    recognition = rally_recognition_config(request)
    recognition_method = recognition["method"]
    effective_config = config if recognition_method == "bounce_events" else {
        "mode": "full",
        "confidence_threshold": BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT,
    }

    def progress(stage: str):
        def callback(current: int, total: int) -> None:
            percent = min(99.9, current / total * 100) if total else 0.0
            emit({
                "type": "progress", "task_id": task_id, "stage": stage,
                "current": current, "total": total, "percent": round(percent, 4),
            })
        return callback

    if effective_config["mode"] == "full":
        predictor = BlurBallPredictor(
            loaded,
            confidence_threshold=effective_config["confidence_threshold"],
        )
        points, info, stats = predictor.predict(
            request["video_path"],
            progress_callback=progress("analysis"),
            analysis_roi=analysis_roi,
        )
        final_threshold = stats.confidence_threshold
        stages = [{
            "name": "full",
            "confidence_threshold": stats.confidence_threshold,
            "window_size": 3,
            "window_stride": 3,
            "retained_output": "all_window_frames",
        }]
        expansion_seconds = None
    else:
        predictor = BlurBallPredictor(
            loaded,
            confidence_threshold=effective_config["stage1_confidence_threshold"],
        )
        stage1_points, stage1_info, stage1_stats = predictor.predict(
            request["video_path"],
            progress_callback=progress("candidate_analysis"),
            analysis_roi=analysis_roi,
        )
        stage1_bounce_frames = detect_blurball_bounce_frames(stage1_points, calibration)
        stage1_rallies = group_rallies(stage1_bounce_frames, stage1_points)
        duration = float(stage1_info.duration or 0.0)
        intervals = expanded_union_intervals(
            stage1_rallies,
            duration,
            REFINEMENT_EXPANSION_SECONDS,
        ) if stage1_rallies else ()
        emit({"type": "progress", "task_id": task_id, "stage": "interval_union", "current": 0, "total": 1, "percent": 0.0})
        emit({"type": "progress", "task_id": task_id, "stage": "interval_union", "current": 1, "total": 1, "percent": 100.0})
        stages = [
            {
                "name": "candidate",
                "confidence_threshold": stage1_stats.confidence_threshold,
                "window_size": 3,
                "window_stride": 3,
                "retained_output": "all_window_frames",
            },
            {
                "name": "refinement",
                "confidence_threshold": effective_config["stage2_confidence_threshold"],
                "window_size": 3,
                "window_stride": 1,
                "retained_output": "center_frame",
            },
        ]
        expansion_seconds = REFINEMENT_EXPANSION_SECONDS
        final_threshold = effective_config["stage2_confidence_threshold"]
        if intervals:
            points, info, stats = predictor.predict_intervals(
                request["video_path"],
                intervals,
                progress_callback=progress("refinement_analysis"),
                analysis_roi=analysis_roi,
                confidence_threshold=effective_config["stage2_confidence_threshold"],
            )
        else:
            points, info, stats = [], stage1_info, stage1_stats

    emit({"type": "progress", "task_id": task_id, "stage": "postprocess", "current": 0, "total": 1, "percent": 0.0})
    bounce_frames: list[int] | None = None
    if recognition_method == "bounce_events":
        bounce_frames = detect_blurball_bounce_frames(points, calibration)
        rallies = group_rallies(bounce_frames, points)
    else:
        rallies = continuous_visibility_rallies(
            points,
            float(info.fps or 0.0),
            motion_config=VisibilityMotionConfig(
                analysis_width_pixels=analysis_roi.width,
                analysis_height_pixels=analysis_roi.height,
            ),
        )
    duration = float(info.duration or 0.0)
    points_by_frame = {point.frame: point for point in points}
    bounce_times = sorted({
        round(max(0.0, min(duration, float(point.time))) if duration else max(0.0, float(point.time)), 6)
        for frame in bounce_frames
        if (point := points_by_frame.get(frame)) is not None and math.isfinite(point.time)
    }) if bounce_frames is not None else None
    normalized = []
    for index, rally in enumerate(rallies, start=1):
        start = max(0.0, float(rally.start_time))
        end = min(duration, float(rally.end_time)) if duration else float(rally.end_time)
        if not all(math.isfinite(value) for value in (start, end)) or end <= start:
            continue
        item = {
            "id": f"rally_{len(normalized) + 1:03d}",
            "index": len(normalized) + 1,
            "start_time_seconds": round(start, 6),
            "end_time_seconds": round(end, 6),
        }
        if recognition_method == "bounce_events":
            item["bounce_count"] = rally.bounce_count
        normalized.append(item)
    emit({"type": "progress", "task_id": task_id, "stage": "postprocess", "current": 1, "total": 1, "percent": 100.0})
    result = {
        "schema_version": 2,
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
        "rally_recognition": (
            {
                "method": "bounce_events",
                "maximum_gap_seconds": 3.0,
                "minimum_bounce_count": 2,
            }
            if recognition_method == "bounce_events"
            else {
                "method": "continuous_visibility",
                "start_visible_seconds": CONTINUOUS_VISIBILITY_START_SECONDS,
                "end_invisible_seconds": CONTINUOUS_VISIBILITY_END_SECONDS,
                "motion_filter": {
                    "minimum_horizontal_excursion_ratio": CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
                    "maximum_reversal_gap_seconds": CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS,
                    "minimum_horizontal_to_vertical_range_ratio": (
                        CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_TO_VERTICAL_RANGE_RATIO
                    ),
                    "maximum_monotonic_vertical_reversals": (
                        CONTINUOUS_VISIBILITY_MAX_MONOTONIC_VERTICAL_REVERSALS
                    ),
                    "minimum_monotonic_horizontal_range_ratio": (
                        CONTINUOUS_VISIBILITY_MIN_MONOTONIC_HORIZONTAL_RANGE_RATIO
                    ),
                },
                "fragment_bridge": {
                    "maximum_gap_seconds": CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SECONDS,
                    "maximum_boundary_displacement_ratio": (
                        CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_DISPLACEMENT_RATIO
                    ),
                    "maximum_boundary_speed_ratio_per_second": (
                        CONTINUOUS_VISIBILITY_FRAGMENT_MERGE_SPEED_RATIO_PER_SECOND
                    ),
                },
            }
        ),
        "calibration": {
            "video_width": calibration.video_width,
            "video_height": calibration.video_height,
            "points": {name: list(point) for name, point in zip(
                ("top_left", "top_right", "bottom_right", "bottom_left"), calibration.points,
            )},
        },
        "model_provenance": {
            "profile": "blurball_v1",
            "component_version": loaded.component_version,
            "roi": {
                "x": analysis_roi.x0,
                "y": analysis_roi.y0,
                "width": analysis_roi.width,
                "height": analysis_roi.height,
            },
            "main_input": {
                "width": stats.model_width,
                "height": stats.model_height,
            },
            "aux_input": None,
            **({
                "detection": {
                    "confidence_threshold": final_threshold,
                    "step": 1 if effective_config["mode"] == "two_stage" else stats.step,
                    "maximum_displacement_pixels": stats.maximum_displacement_pixels,
                    "landing_region": "expanded_table",
                },
            } if recognition_method == "bounce_events" else {}),
            "analysis": {
                "schema_version": 2,
                "mode": effective_config["mode"],
                **({"interval_expansion_seconds": expansion_seconds} if expansion_seconds is not None else {}),
                "stages": stages,
            },
        },
    }
    if bounce_times is not None:
        result["bounce_times_seconds"] = bounce_times
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
