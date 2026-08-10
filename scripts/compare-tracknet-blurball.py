from __future__ import annotations

import argparse
import json
from pathlib import Path


def summarize(run: dict) -> dict:
    rallies = run["output"]["rallies"]
    timing = run["timing"]
    return {
        "analysis_seconds": timing["complete_analysis_seconds"],
        "model_load_seconds": timing["model_load_seconds"],
        "predictor_seconds": timing["predictor_seconds"],
        "inference_seconds": timing["inference_seconds"],
        "average_predictor_fps": timing["average_predictor_fps"],
        "decoded_frames": run["output"]["frames"],
        "visible_frames": run["output"]["visible_frames"],
        "bounce_proxy_count": len(run["output"]["bounce_frames"]),
        "rally_count": len(rallies),
        "grouped_bounce_proxy_count": sum(rally["bounce_count"] for rally in rallies),
        "rally_bounce_proxy_counts": [rally["bounce_count"] for rally in rallies],
        "peak_cuda_memory_bytes": timing.get("peak_cuda_memory_bytes", 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare unlabelled TrackNet and BlurBall TTcut runs.")
    parser.add_argument("--tracknet", type=Path, required=True)
    parser.add_argument("--blurball", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tracknet = json.loads(args.tracknet.read_text(encoding="utf-8"))
    blurball = json.loads(args.blurball.read_text(encoding="utf-8"))
    source_unchanged = all(
        run["inputs"]["video_sha256_before"] == run["inputs"]["video_sha256_after"]
        and run["inputs"]["video_size_before"] == run["inputs"]["video_size_after"]
        for run in (tracknet, blurball)
    )
    if tracknet["inputs"]["video_sha256_before"] != blurball["inputs"]["video_sha256_before"]:
        raise ValueError("The two benchmark runs did not use the same source video.")
    report = {
        "statement": (
            "Objective output comparison only. Bounce counts are TTcut bounce/landing proxies, "
            "not manually verified paddle-stroke counts; no labelled ground truth was used to rank accuracy."
        ),
        "source": {
            "video": tracknet["inputs"]["video"],
            "sha256": tracknet["inputs"]["video_sha256_before"],
            "size_bytes": tracknet["inputs"]["video_size_before"],
            "unchanged": source_unchanged,
        },
        "rules": {
            "blurball": {
                "confidence_threshold": 0.7,
                "step": 3,
                "maximum_displacement_pixels": 100,
                "bounce_detector": "blurball_local_trajectory_change",
            },
            "shared_ttcut": {
                "minimum_bounce_interval_seconds": 0.315,
                "table_length_margin_cm": 35.0,
                "table_width_margin_cm": 25.0,
                "rally_maximum_adjacent_gap_seconds": 3.0,
                "landing_region_table_cm": {"x": [-35.0, 309.0], "y": [-25.0, 177.5]},
            },
        },
        "tracknet_v1": summarize(tracknet),
        "blurball_v1": summarize(blurball),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
