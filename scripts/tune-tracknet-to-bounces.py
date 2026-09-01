from __future__ import annotations

import argparse
import itertools
import json
import math
import sys
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, fields
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = PROJECT_ROOT / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from ttcut_worker.calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration  # noqa: E402
from ttcut_worker.tracknet_rallies import (  # noqa: E402
    TRACKNET_MINIMUM_HORIZONTAL_RUN_REVERSALS,
    TRACKNET_MINIMUM_RALLY_SECONDS,
    TRACKNET_MINIMUM_SHORT_RALLY_EXPANDED_TABLE_RATIO,
    TRACKNET_RELIABLE_FRAGMENT_BRIDGE_SECONDS,
    TRACKNET_SHORT_RALLY_SECONDS,
    TRACKNET_STRONG_EVIDENCE_MINIMUM_EXPANDED_TABLE_RATIO,
    TRACKNET_STRONG_EVIDENCE_MINIMUM_RALLY_SECONDS,
    tracknet_visibility_rallies,
)
from ttcut_worker.types import TrajectoryPoint  # noqa: E402
from ttcut_worker.visibility_rallies import (  # noqa: E402
    CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS,
    CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO,
    VisibilityMotionConfig,
    VisibilityRallySummary,
    _run_reversals,
    continuous_visibility_rallies,
    is_end_on_table_view,
)


@dataclass(frozen=True)
class Candidate:
    rally: VisibilityRallySummary
    horizontal_run_reversals: int
    expanded_table_ratio: float


@dataclass(frozen=True)
class FilterConfig:
    minimum_duration: float
    minimum_reversals: int
    short_duration: float
    minimum_short_table_ratio: float
    bridge_seconds: float
    strong_evidence_minimum_duration: float | None = None
    strong_evidence_minimum_table_ratio: float | None = None


def restore_point(value: dict) -> TrajectoryPoint:
    allowed = {field.name for field in fields(TrajectoryPoint)}
    return TrajectoryPoint(**{key: item for key, item in value.items() if key in allowed})


def calibration_from_artifact(payload: dict) -> TableCalibration:
    target_payload = json.loads(Path(payload["inputs"]["target"]).read_text(encoding="utf-8"))
    result = target_payload.get("result", target_payload.get("analysis", target_payload))
    calibration = result.get("calibration", target_payload.get("calibration"))
    points = calibration["points"]
    return TableCalibration.from_points(
        calibration["video_width"],
        calibration["video_height"],
        [points[name] for name in ("top_left", "top_right", "bottom_right", "bottom_left")],
    )


def features(
    payload: dict,
    *,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
) -> list[Candidate]:
    points = [restore_point(value) for value in payload["trajectory"]]
    ordered = sorted(points, key=lambda point: point.frame)
    frames = [point.frame for point in ordered]
    fps = float(payload["video"]["fps"])
    roi = payload["inputs"]["analysis_roi"]
    width = float(roi["x1"] - roi["x0"])
    height = float(roi["y1"] - roi["y0"])
    calibration = calibration_from_artifact(payload)
    maximum_missing = math.floor(fps * CONTINUOUS_VISIBILITY_MAX_REVERSAL_GAP_SECONDS)
    minimum_excursion = width * CONTINUOUS_VISIBILITY_MIN_HORIZONTAL_EXCURSION_RATIO
    result = []
    if start_seconds is None or end_seconds is None:
        base_rallies = [VisibilityRallySummary(**value) for value in payload["shared_visibility_rallies"]]
    else:
        base_rallies = list(continuous_visibility_rallies(
            points,
            fps,
            start_seconds=start_seconds,
            end_seconds=end_seconds,
            motion_config=VisibilityMotionConfig(
                width,
                height,
                vertical_exchange_enabled=is_end_on_table_view(calibration.points),
            ),
        ))
    for rally in base_rallies:
        segment = ordered[
            bisect_left(frames, rally.start_frame):bisect_right(frames, rally.end_frame)
        ]
        visible = [point for point in segment if point.visibility]
        reversals = _run_reversals(
            [float(point.x) for point in visible],
            [point.frame for point in visible],
            minimum_excursion,
            maximum_missing,
        )
        expanded = sum(
            -35.0 <= table_x <= TABLE_LENGTH_CM + 35.0
            and -25.0 <= table_y <= TABLE_WIDTH_CM + 25.0
            for table_x, table_y in (
                calibration.image_to_table(point.x, point.y) for point in visible
            )
        )
        result.append(Candidate(rally, reversals, expanded / len(visible)))
    return result


def raw_rallies(payload: dict) -> list[VisibilityRallySummary]:
    points = [restore_point(value) for value in payload["trajectory"]]
    return list(continuous_visibility_rallies(points, float(payload["video"]["fps"])))


def production_rallies(payload: dict) -> list[VisibilityRallySummary]:
    points = [restore_point(value) for value in payload["trajectory"]]
    roi = payload["inputs"]["analysis_roi"]
    calibration = calibration_from_artifact(payload)
    return list(tracknet_visibility_rallies(
        points,
        float(payload["video"]["fps"]),
        calibration,
        motion_config=VisibilityMotionConfig(
            float(roi["x1"] - roi["x0"]),
            float(roi["y1"] - roi["y0"]),
            vertical_exchange_enabled=is_end_on_table_view(calibration.points),
        ),
    ))


def apply_filter(candidates: list[Candidate], config: FilterConfig) -> list[VisibilityRallySummary]:
    accepted = []
    for candidate in candidates:
        rally = candidate.rally
        duration = rally.end_time - rally.start_time
        if duration + 1e-9 < config.minimum_duration:
            if (
                config.strong_evidence_minimum_duration is None
                or config.strong_evidence_minimum_table_ratio is None
                or duration + 1e-9 < config.strong_evidence_minimum_duration
                or candidate.expanded_table_ratio
                < config.strong_evidence_minimum_table_ratio
            ):
                continue
        if candidate.horizontal_run_reversals < config.minimum_reversals:
            continue
        if (
            duration < config.short_duration
            and candidate.expanded_table_ratio < config.minimum_short_table_ratio
        ):
            continue
        accepted.append(rally)
    merged: list[VisibilityRallySummary] = []
    for rally in accepted:
        if merged and 0 < rally.start_time - merged[-1].end_time <= config.bridge_seconds:
            previous = merged[-1]
            merged[-1] = VisibilityRallySummary(
                previous.start_frame, rally.end_frame, previous.start_time, rally.end_time,
            )
        else:
            merged.append(rally)
    return merged


def intervals(values: list[dict], *, bounce: bool = False) -> list[tuple[float, float]]:
    start_key = "start_time" if bounce else "start_time_seconds"
    end_key = "end_time" if bounce else "end_time_seconds"
    return [(float(value[start_key]), float(value[end_key])) for value in values]


def match(predicted: list[VisibilityRallySummary], target: list[tuple[float, float]]) -> dict:
    candidates = []
    for predicted_index, rally in enumerate(predicted):
        for target_index, (target_start, target_end) in enumerate(target):
            overlap = max(0.0, min(rally.end_time, target_end) - max(rally.start_time, target_start))
            target_duration = target_end - target_start
            target_coverage = overlap / target_duration if target_duration > 0 else 0.0
            target_midpoint = (target_start + target_end) / 2
            if overlap >= 0.15 and (target_coverage >= 0.5 or rally.start_time <= target_midpoint <= rally.end_time):
                union = max(rally.end_time, target_end) - min(rally.start_time, target_start)
                iou = overlap / union if union > 0 else 0.0
                candidates.append((target_coverage, iou, overlap, predicted_index, target_index))
    matched_predicted: set[int] = set()
    matched_target: set[int] = set()
    pairs = []
    for coverage, iou, overlap, predicted_index, target_index in sorted(candidates, reverse=True):
        if predicted_index in matched_predicted or target_index in matched_target:
            continue
        matched_predicted.add(predicted_index)
        matched_target.add(target_index)
        pairs.append((predicted_index, target_index, coverage, iou, overlap))
    precision = len(pairs) / len(predicted) if predicted else 0.0
    recall = len(pairs) / len(target) if target else 0.0
    return {
        "predicted": len(predicted),
        "target": len(target),
        "matched": len(pairs),
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "unmatched_predicted": [index + 1 for index in range(len(predicted)) if index not in matched_predicted],
        "unmatched_target": [index + 1 for index in range(len(target)) if index not in matched_target],
    }


def match_overlap(
    predicted: list[VisibilityRallySummary],
    target: list[tuple[float, float]],
    *,
    minimum_overlap: float = 0.2,
) -> dict:
    candidates = []
    for predicted_index, rally in enumerate(predicted):
        for target_index, (target_start, target_end) in enumerate(target):
            overlap = max(0.0, min(rally.end_time, target_end) - max(rally.start_time, target_start))
            if overlap >= minimum_overlap:
                candidates.append((overlap, predicted_index, target_index))
    matched_predicted: set[int] = set()
    matched_target: set[int] = set()
    for overlap, predicted_index, target_index in sorted(candidates, reverse=True):
        if predicted_index in matched_predicted or target_index in matched_target:
            continue
        matched_predicted.add(predicted_index)
        matched_target.add(target_index)
    precision = len(matched_predicted) / len(predicted) if predicted else 0.0
    recall = len(matched_target) / len(target) if target else 0.0
    return {
        "predicted": len(predicted),
        "target": len(target),
        "matched": len(matched_predicted),
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
    }


def unmatched_target_details(
    predicted: list[VisibilityRallySummary],
    target: list[tuple[float, float]],
    unmatched_target_indexes: list[int],
) -> list[dict]:
    details = []
    for one_based_index in unmatched_target_indexes:
        target_start, target_end = target[one_based_index - 1]
        target_duration = target_end - target_start
        nearest = None
        for predicted_index, rally in enumerate(predicted, start=1):
            overlap = max(0.0, min(rally.end_time, target_end) - max(rally.start_time, target_start))
            distance = max(rally.start_time - target_end, target_start - rally.end_time, 0.0)
            candidate = (overlap, -distance, predicted_index, rally)
            if nearest is None or candidate[:3] > nearest[:3]:
                nearest = candidate
        overlap, negative_distance, predicted_index, rally = nearest
        details.append({
            "target_index": one_based_index,
            "target_start": target_start,
            "target_end": target_end,
            "target_duration": target_duration,
            "nearest_predicted_index": predicted_index,
            "predicted_start": rally.start_time,
            "predicted_end": rally.end_time,
            "overlap": overlap,
            "target_coverage": overlap / target_duration if target_duration > 0 else 0.0,
            "distance": -negative_distance,
        })
    return details


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--regression", type=Path, required=True)
    parser.add_argument("--guard", action="append", type=Path, default=[])
    parser.add_argument("--top", type=int, default=20)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    current = json.loads(args.current.read_text(encoding="utf-8"))
    regression = json.loads(args.regression.read_text(encoding="utf-8"))
    guard_payloads = [
        (path, json.loads(path.read_text(encoding="utf-8")))
        for path in args.guard
    ]
    current_features = features(current)
    regression_features = features(regression)
    current_target = intervals(current["bounce_rallies"], bounce=True)
    regression_target = [tuple(map(float, value)) for value in regression["target_rallies"]]
    recorded_regression_rallies = [
        VisibilityRallySummary(**value) for value in regression["visibility_rallies"]
    ]
    guards = []
    for path, payload in guard_payloads:
        production = production_rallies(payload)
        target = intervals(payload["bounce_rallies"], bounce=True)
        guards.append({
            "path": str(path),
            "features": features(payload),
            "production": production,
            "target": target,
            "production_score": match(production, target),
        })
    configs = (
        FilterConfig(*values)
        for values in itertools.product(
            (0.4, 0.6, 0.75, 0.9, 1.0),
            (0, 1),
            (1.5, 2.0, 2.5, 3.0),
            (0.0, 0.1, 0.2, 0.25, 0.3),
            (0.5, 0.75, 1.0, 1.5, 1.75, 2.0, 2.5, 3.0),
        )
    )
    results = []
    for config in configs:
        current_rallies = apply_filter(current_features, config)
        regression_rallies = apply_filter(regression_features, config)
        current_score = match(current_rallies, current_target)
        regression_score = match_overlap(regression_rallies, regression_target)
        results.append({
            "config": config,
            "current": current_score,
            "regression": regression_score,
            "regression_interval_changes": (
                sum(
                    recorded != candidate
                    for recorded, candidate in zip(
                        recorded_regression_rallies, regression_rallies, strict=True,
                    )
                )
                if len(recorded_regression_rallies) == len(regression_rallies)
                else math.inf
            ),
            "guards": [
                {
                    "path": guard["path"],
                    "score": match(
                        guard_rallies := apply_filter(guard["features"], config),
                        guard["target"],
                    ),
                    "production_score": guard["production_score"],
                    "production_interval_changes": (
                        sum(
                            production != candidate
                            for production, candidate in zip(
                                guard["production"], guard_rallies, strict=True,
                            )
                        )
                        if len(guard["production"]) == len(guard_rallies)
                        else math.inf
                    ),
                }
                for guard in guards
            ],
        })
    preserving = [
        item for item in results
        if item["regression"]["matched"] == len(regression_target)
        and item["regression"]["predicted"] == len(regression_target)
    ]
    ranked = sorted(
        preserving,
        key=lambda item: (
            item["current"]["f1"],
            item["current"]["matched"],
            -abs(item["current"]["predicted"] - item["current"]["target"]),
            -item["regression_interval_changes"],
        ),
        reverse=True,
    )
    guarded_ranked = sorted(
        (
            item for item in preserving
            if all(
                guard["score"]["predicted"] == guard["production_score"]["predicted"]
                and guard["score"]["matched"] >= guard["production_score"]["matched"]
                for guard in item["guards"]
            )
        ),
        key=lambda item: (
            item["current"]["f1"],
            item["current"]["matched"],
            -abs(item["current"]["predicted"] - item["current"]["target"]),
            -sum(
                guard["production_interval_changes"]
                for guard in item["guards"]
            ),
        ),
        reverse=True,
    )
    zero_change_ranked = [
        item for item in ranked if item["regression_interval_changes"] == 0
    ]
    one_change_ranked = [
        item for item in ranked if item["regression_interval_changes"] == 1
    ]
    best_by_regression_interval_changes = []
    for change_count in sorted({
        item["regression_interval_changes"] for item in ranked
        if math.isfinite(item["regression_interval_changes"])
    }):
        best_by_regression_interval_changes.append(next(
            item for item in ranked
            if item["regression_interval_changes"] == change_count
        ))
    current_config = FilterConfig(0.9, 1, 2.0, 0.20, 1.50)
    baseline = next(item for item in results if item["config"] == current_config)
    selected_config = FilterConfig(
        TRACKNET_MINIMUM_RALLY_SECONDS,
        TRACKNET_MINIMUM_HORIZONTAL_RUN_REVERSALS,
        TRACKNET_SHORT_RALLY_SECONDS,
        TRACKNET_MINIMUM_SHORT_RALLY_EXPANDED_TABLE_RATIO,
        TRACKNET_RELIABLE_FRAGMENT_BRIDGE_SECONDS,
        TRACKNET_STRONG_EVIDENCE_MINIMUM_RALLY_SECONDS,
        TRACKNET_STRONG_EVIDENCE_MINIMUM_EXPANDED_TABLE_RATIO,
    )
    selected = {
        "current": match(apply_filter(current_features, selected_config), current_target),
        "regression": match_overlap(
            apply_filter(regression_features, selected_config), regression_target,
        ),
    }
    shared_current = match([candidate.rally for candidate in current_features], current_target)
    shared_regression = match_overlap([candidate.rally for candidate in regression_features], regression_target)
    raw_current = match(raw_rallies(current), current_target)
    raw_regression = match_overlap(raw_rallies(regression), regression_target)
    state_results = []
    state_filter_configs = (
        FilterConfig(0.6, 1, 2.5, 0.1, 1.5),
        FilterConfig(0.9, 1, 2.5, 0.1, 1.5),
        FilterConfig(0.9, 1, 2.0, 0.1, 1.5),
    )
    for start_seconds, end_seconds in itertools.product(
        (0.1, 0.15, 0.2, 0.25),
        (0.5, 0.75, 1.0, 1.25),
    ):
        state_current_features = features(
            current, start_seconds=start_seconds, end_seconds=end_seconds,
        )
        state_regression_features = features(
            regression, start_seconds=start_seconds, end_seconds=end_seconds,
        )
        for config in state_filter_configs:
            current_score = match(apply_filter(state_current_features, config), current_target)
            regression_score = match_overlap(apply_filter(state_regression_features, config), regression_target)
            if (
                regression_score["predicted"] == len(regression_target)
                and regression_score["matched"] == len(regression_target)
            ):
                state_results.append({
                    "start_seconds": start_seconds,
                    "end_seconds": end_seconds,
                    "config": config,
                    "current": current_score,
                    "regression": regression_score,
                })
    ranked_state = sorted(
        state_results,
        key=lambda item: (
            item["current"]["f1"],
            item["current"]["matched"],
            -abs(item["current"]["predicted"] - item["current"]["target"]),
        ),
        reverse=True,
    )
    best_details = None
    best_regression_interval_changes = None
    if ranked:
        best_rallies = apply_filter(current_features, ranked[0]["config"])
        best_details = unmatched_target_details(
            best_rallies,
            current_target,
            ranked[0]["current"]["unmatched_target"],
        )
        best_regression_rallies = apply_filter(regression_features, ranked[0]["config"])
        recorded_regression = [
            VisibilityRallySummary(**value) for value in regression["visibility_rallies"]
        ]
        best_regression_interval_changes = [
            {
                "index": index,
                "recorded": [recorded.start_time, recorded.end_time],
                "candidate": [candidate.start_time, candidate.end_time],
            }
            for index, (recorded, candidate) in enumerate(
                zip(recorded_regression, best_regression_rallies, strict=True), start=1,
            )
            if recorded != candidate
        ]
    selected_rallies = apply_filter(current_features, selected_config)
    selected_regression_rallies = apply_filter(regression_features, selected_config)
    production_current_rallies = production_rallies(current)
    production_regression_rallies = production_rallies(regression)
    selected_guards = []
    for guard in guards:
        guard_rallies = apply_filter(guard["features"], selected_config)
        selected_guards.append({
            "path": guard["path"],
            "score": match(guard_rallies, guard["target"]),
            "production_score": guard["production_score"],
            "matches_production_intervals": guard_rallies == guard["production"],
        })
    selected_regression_interval_changes = [
        {
            "index": index,
            "recorded": [recorded.start_time, recorded.end_time],
            "candidate": [candidate.start_time, candidate.end_time],
        }
        for index, (recorded, candidate) in enumerate(
            zip(recorded_regression_rallies, selected_regression_rallies, strict=True),
            start=1,
        )
        if recorded != candidate
    ]
    payload = {
        "raw_visibility_upper_bound": {
            "current": raw_current,
            "regression": raw_regression,
        },
        "shared_upper_bound": {
            "current": shared_current,
            "regression": shared_regression,
        },
        "baseline": {
            "config": baseline["config"].__dict__,
            "current": baseline["current"],
            "regression": baseline["regression"],
        },
        "selected": {
            "config": selected_config.__dict__,
            "current": selected["current"],
            "regression": selected["regression"],
            "unmatched_target_details": unmatched_target_details(
                selected_rallies,
                current_target,
                selected["current"]["unmatched_target"],
            ),
            "regression_interval_changes": selected_regression_interval_changes,
            "guards": selected_guards,
            "production_replay": {
                "current_count": len(production_current_rallies),
                "regression_count": len(production_regression_rallies),
                "matches_selected_current": production_current_rallies == selected_rallies,
                "matches_selected_regression": (
                    production_regression_rallies == selected_regression_rallies
                ),
            },
        },
        "preserving_config_count": len(preserving),
        "guard_baselines": [
            {
                "path": guard["path"],
                "production_score": guard["production_score"],
                "production_count": len(guard["production"]),
            }
            for guard in guards
        ],
        "guarded_top": [
            {
                "config": item["config"].__dict__,
                "current": item["current"],
                "regression": item["regression"],
                "guards": item["guards"],
            }
            for item in guarded_ranked[:args.top]
        ],
        "best_unmatched_target_details": best_details,
        "best_regression_interval_changes": best_regression_interval_changes,
        "state_search_top": [
            {
                "start_seconds": item["start_seconds"],
                "end_seconds": item["end_seconds"],
                "config": item["config"].__dict__,
                "current": item["current"],
                "regression": item["regression"],
            }
            for item in ranked_state[:args.top]
        ],
        "zero_regression_interval_change_top": [
            {
                "config": item["config"].__dict__,
                "current": item["current"],
                "regression": item["regression"],
            }
            for item in zero_change_ranked[:args.top]
        ],
        "one_regression_interval_change_top": [
            {
                "config": item["config"].__dict__,
                "current": item["current"],
                "regression": item["regression"],
            }
            for item in one_change_ranked[:args.top]
        ],
        "best_by_regression_interval_changes": [
            {
                "config": item["config"].__dict__,
                "current": item["current"],
                "regression": item["regression"],
                "regression_interval_changes": item["regression_interval_changes"],
            }
            for item in best_by_regression_interval_changes
        ],
        "top": [
            {
                "config": item["config"].__dict__,
                "current": item["current"],
                "regression": item["regression"],
                "regression_interval_changes": item["regression_interval_changes"],
            }
            for item in ranked[:args.top]
        ],
    }
    output = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n", encoding="utf-8")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
