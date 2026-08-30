from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from dataclasses import fields
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = PROJECT_ROOT / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from ttcut_worker.types import TrajectoryPoint  # noqa: E402
from ttcut_worker.calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration  # noqa: E402
from ttcut_worker.tracknet_rallies import tracknet_visibility_rallies  # noqa: E402
from ttcut_worker.visibility_rallies import (  # noqa: E402
    VisibilityMotionConfig,
    _run_reversals,
    _significant_reversals,
    continuous_visibility_rallies,
)


def restore_point(value: dict) -> TrajectoryPoint:
    allowed = {field.name for field in fields(TrajectoryPoint)}
    return TrajectoryPoint(**{key: item for key, item in value.items() if key in allowed})


def overlap_metrics(interval: tuple[float, float], target: list[tuple[float, float]]) -> tuple[float, float, int]:
    start, end = interval
    best_overlap = 0.0
    best_iou = 0.0
    best_index = -1
    for index, (target_start, target_end) in enumerate(target):
        overlap = max(0.0, min(end, target_end) - max(start, target_start))
        union = max(end, target_end) - min(start, target_start)
        iou = overlap / union if union > 0 else 0.0
        if overlap > best_overlap or (overlap == best_overlap and iou > best_iou):
            best_overlap, best_iou, best_index = overlap, iou, index
    return best_overlap, best_iou, best_index


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    payload = json.loads(args.artifact.read_text(encoding="utf-8"))
    target_payload = json.loads(Path(payload["inputs"]["target"]).read_text(encoding="utf-8"))
    calibration_value = target_payload["result"]["calibration"]
    calibration_points = calibration_value["points"]
    calibration = TableCalibration.from_points(
        calibration_value["video_width"],
        calibration_value["video_height"],
        [calibration_points[name] for name in ("top_left", "top_right", "bottom_right", "bottom_left")],
    )
    points = [restore_point(value) for value in payload["trajectory"]]
    fps = float(payload["video"]["fps"])
    roi = payload["inputs"]["analysis_roi"]
    target = [tuple(map(float, value)) for value in payload["target_rallies"]]
    config = VisibilityMotionConfig(
        float(roi["x1"] - roi["x0"]),
        float(roi["y1"] - roi["y0"]),
        False,
    )
    shared_rallies = continuous_visibility_rallies(points, fps, motion_config=config)
    rallies = tracknet_visibility_rallies(
        points, fps, calibration, motion_config=config,
    ) if args.summary else shared_rallies
    if args.summary:
        matched_overlap = 0
        matched_iou = 0
        for rally in rallies:
            overlap, iou, _ = overlap_metrics((rally.start_time, rally.end_time), target)
            matched_overlap += overlap >= 0.2
            matched_iou += iou >= 0.3
        print(json.dumps({
            "shared_count": len(shared_rallies),
            "optimized_count": len(rallies),
            "target_count": len(target),
            "matched_with_minimum_0_2_second_overlap": matched_overlap,
            "matched_with_minimum_0_3_iou": matched_iou,
            "rallies": [
                {
                    "start": rally.start_time,
                    "end": rally.end_time,
                    "duration": rally.end_time - rally.start_time,
                }
                for rally in rallies
            ],
        }, indent=2))
        return 0
    by_frame = {point.frame: point for point in points}
    print("index,label,target,overlap,iou,duration,visible,density,mean_conf,p25_conf,x_range,y_range,x_rev,y_rev,run_x_rev,path_ratio,table_ratio,expanded_ratio,x_mid,y_mid")
    for index, rally in enumerate(rallies, start=1):
        segment = [
            by_frame[frame] for frame in range(rally.start_frame, rally.end_frame + 1)
            if frame in by_frame
        ]
        visible = [point for point in segment if point.visibility]
        xs = [float(point.x) for point in visible]
        ys = [float(point.y) for point in visible]
        confidences = sorted(float(point.confidence) for point in visible)
        overlap, iou, target_index = overlap_metrics((rally.start_time, rally.end_time), target)
        path = sum(math.dist((a.x, a.y), (b.x, b.y)) for a, b in zip(visible, visible[1:]))
        x_range = max(xs) - min(xs)
        y_range = max(ys) - min(ys)
        maximum_missing = math.floor(fps * 0.35)
        table_points = [calibration.image_to_table(point.x, point.y) for point in visible]
        table_count = sum(
            0 <= x <= TABLE_LENGTH_CM and 0 <= y <= TABLE_WIDTH_CM for x, y in table_points
        )
        expanded_count = sum(
            -35 <= x <= TABLE_LENGTH_CM + 35 and -25 <= y <= TABLE_WIDTH_CM + 25
            for x, y in table_points
        )
        print(",".join(map(str, (
            index,
            "target" if overlap >= 0.2 else "extra",
            target_index + 1 if target_index >= 0 else "",
            round(overlap, 4), round(iou, 4), round(rally.end_time - rally.start_time, 4),
            len(visible), round(len(visible) / len(segment), 4),
            round(statistics.mean(confidences), 4),
            round(confidences[max(0, math.ceil(len(confidences) * 0.25) - 1)], 4),
            round(x_range / config.analysis_width_pixels, 4),
            round(y_range / config.analysis_height_pixels, 4),
            _significant_reversals(xs, config.analysis_width_pixels * (20 / 618)),
            _significant_reversals(ys, config.analysis_height_pixels * (12 / 347)),
            _run_reversals(xs, [point.frame for point in visible], config.analysis_width_pixels * (20 / 618), maximum_missing),
            round(path / config.analysis_width_pixels, 4),
            round(table_count / len(visible), 4),
            round(expanded_count / len(visible), 4),
            round(statistics.median(xs), 2),
            round(statistics.median(ys), 2),
        ))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
