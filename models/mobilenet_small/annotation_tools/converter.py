from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import LABELS
from .common import write_csv


INTERVAL_FIELDS = (
    "video_id",
    "group_id",
    "source_relative_path",
    "label",
    "start_frame",
    "end_frame",
    "fps",
    "start_sec",
    "end_sec",
    "roi_status",
    "roi_x1",
    "roi_y1",
    "roi_x2",
    "roi_y2",
    "task_id",
    "annotation_id",
    "annotator",
    "annotation_updated_at",
)


def select_annotation(task: dict[str, object]) -> dict[str, object] | None:
    annotations = [annotation for annotation in task.get("annotations", []) if not annotation.get("was_cancelled")]
    if not annotations:
        return None
    ground_truth = [annotation for annotation in annotations if annotation.get("ground_truth")]
    candidates = ground_truth or annotations

    def timestamp(annotation: dict[str, object]) -> str:
        # Label Studio emits ISO-8601 timestamps, which preserve ordering as strings.
        return str(annotation.get("updated_at") or annotation.get("created_at") or "")

    return max(candidates, key=timestamp)


def convert_tasks(tasks: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[str]]:
    output: list[dict[str, object]] = []
    warnings: list[str] = []
    for task in tasks:
        data = task.get("data") or {}
        video_id = str(data.get("video_id") or "")
        fps = float(data.get("fps") or 0)
        if not video_id or fps <= 0:
            raise ValueError(f"Task {task.get('id')} is missing video_id or fps")
        annotation = select_annotation(task)
        if annotation is None:
            warnings.append(f"Task {task.get('id')} ({video_id}) has no completed annotation")
            continue
        for result in annotation.get("result", []):
            if result.get("type") != "timelinelabels" or result.get("from_name") != "event_labels":
                continue
            value = result.get("value") or {}
            ranges = value.get("ranges")
            labels = value.get("timelinelabels") or []
            if not ranges:
                warnings.append(f"Ignored malformed TimelineLabels result in task {task.get('id')}")
                continue
            if len(labels) != 1 or labels[0] not in LABELS:
                raise ValueError(f"Invalid label in task {task.get('id')}: {labels}")
            for frame_range in ranges:
                start_frame = int(frame_range["start"])
                end_frame = int(frame_range["end"])
                if start_frame < 1 or end_frame < start_frame:
                    raise ValueError(f"Invalid frame range in task {task.get('id')}: {frame_range}")
                # Label Studio TimelineLabels uses one-based, inclusive frame ranges.
                start_sec = (start_frame - 1) / fps
                end_sec = end_frame / fps
                output.append(
                    {
                        "video_id": video_id,
                        "group_id": data.get("group_id", ""),
                        "source_relative_path": data.get("source_relative_path", ""),
                        "label": labels[0],
                        "start_frame": start_frame,
                        "end_frame": end_frame,
                        "fps": f"{fps:g}",
                        "start_sec": f"{start_sec:.6f}",
                        "end_sec": f"{end_sec:.6f}",
                        "roi_status": data.get("roi_status", ""),
                        "roi_x1": data.get("roi_x1", ""),
                        "roi_y1": data.get("roi_y1", ""),
                        "roi_x2": data.get("roi_x2", ""),
                        "roi_y2": data.get("roi_y2", ""),
                        "task_id": task.get("id", ""),
                        "annotation_id": annotation.get("id", ""),
                        "annotator": annotation.get("completed_by", ""),
                        "annotation_updated_at": annotation.get("updated_at", ""),
                    }
                )
    output.sort(key=lambda row: (str(row["video_id"]), float(row["start_sec"]), float(row["end_sec"])))
    return output, warnings


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a raw Label Studio JSON export to normalized time intervals.")
    parser.add_argument("export", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/annotations/intervals.csv"))
    args = parser.parse_args()

    payload = json.loads(args.export.read_text(encoding="utf-8-sig"))
    tasks = payload if isinstance(payload, list) else payload.get("tasks", [])
    rows, warnings = convert_tasks(tasks)
    write_csv(args.output, rows, INTERVAL_FIELDS)
    for warning in warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    print(f"Wrote {len(rows)} intervals to {args.output}.")


if __name__ == "__main__":
    main()
