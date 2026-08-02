from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path


def percentile(values: list[float], ratio: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * ratio
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - index) + ordered[upper] * (index - lower)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two unlabelled TTcut ball-model benchmark runs.")
    parser.add_argument("--tracknet", type=Path, required=True)
    parser.add_argument("--dual", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    old = json.loads(args.tracknet.read_text(encoding="utf-8"))
    new = json.loads(args.dual.read_text(encoding="utf-8"))
    old_points = old["output"]["trajectory"]
    new_points = new["output"]["trajectory"]
    if len(old_points) != len(new_points):
        raise ValueError("Benchmark trajectories have different decoded frame counts.")
    source_width = old["inputs"]["analysis_roi"]["source_width"]
    source_height = old["inputs"]["analysis_roi"]["source_height"]
    distances = []
    shared = 0
    old_only = 0
    new_only = 0
    for left, right in zip(old_points, new_points):
        if left["visibility"] and right["visibility"]:
            shared += 1
            dx = (left["x"] - right["x"]) * 1920 / source_width
            dy = (left["y"] - right["y"]) * 1080 / source_height
            distances.append(math.hypot(dx, dy))
        elif left["visibility"]:
            old_only += 1
        elif right["visibility"]:
            new_only += 1
    old_bounces = set(old["output"]["bounce_frames"])
    new_bounces = set(new["output"]["bounce_frames"])
    old_rallies = old["output"]["rallies"]
    new_rallies = new["output"]["rallies"]
    for run in (old, new):
        timing = run["timing"]
        timing.setdefault(
            "measured_components_total_seconds",
            timing["model_load_seconds"] + timing["predictor_seconds"],
        )
    report = {
        "statement": "Objective A/B differences only; no labelled ground truth was used, so this report does not rank accuracy.",
        "source_unchanged": {
            "tracknet": old["inputs"]["video_sha256_before"] == old["inputs"]["video_sha256_after"] and old["inputs"]["video_size_before"] == old["inputs"]["video_size_after"],
            "uplifting_dual": new["inputs"]["video_sha256_before"] == new["inputs"]["video_sha256_after"] and new["inputs"]["video_size_before"] == new["inputs"]["video_size_after"],
            "sha256": old["inputs"]["video_sha256_before"],
            "size_bytes": old["inputs"]["video_size_before"],
        },
        "timing": {"tracknet_v1": old["timing"], "uplifting_dual_v1": new["timing"]},
        "input_sizes": {
            "tracknet": [old["timing"]["model_width"], old["timing"]["model_height"]],
            "main": [new["timing"]["main_width"], new["timing"]["main_height"]],
            "aux": [new["timing"]["aux_width"], new["timing"]["aux_height"]],
        },
        "trajectory": {
            "tracknet_visible": old["output"]["visible_frames"],
            "dual_visible": new["output"]["visible_frames"],
            "shared_visible": shared,
            "tracknet_only": old_only,
            "dual_only": new_only,
            "shared_distance_canonical_pixels": {
                "mean": statistics.fmean(distances) if distances else None,
                "p50": percentile(distances, 0.5), "p90": percentile(distances, 0.9),
                "p95": percentile(distances, 0.95), "max": max(distances) if distances else None,
            },
        },
        "bounces": {
            "common": sorted(old_bounces & new_bounces),
            "tracknet_only": sorted(old_bounces - new_bounces),
            "dual_only": sorted(new_bounces - old_bounces),
        },
        "rallies": {
            "tracknet_count": len(old_rallies), "dual_count": len(new_rallies),
            "bounce_count_by_index": [
                {"index": index + 1, "tracknet": old_rallies[index]["bounce_count"] if index < len(old_rallies) else None, "dual": new_rallies[index]["bounce_count"] if index < len(new_rallies) else None}
                for index in range(max(len(old_rallies), len(new_rallies)))
            ],
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
