"""Compare TrackNet thresholds on identical heatmaps and independent track histories.

ROI scale and rally policy are held fixed. BlurBall history is evaluation input
only and is never passed to the predictor or TrackNet rally policy.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import sys
import time
from dataclasses import asdict, replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))
from ttcut_worker.tracknet_model import load_tracknet
from ttcut_worker.tracknet_predictor import TrackNetPredictor, TRACKNET_ROI_MODEL_SCALE
from ttcut_worker.tracknet_rallies import tracknet_visibility_rallies
from ttcut_worker.roi import build_analysis_roi
from ttcut_worker.visibility_rallies import VisibilityMotionConfig, is_end_on_table_view

spec = importlib.util.spec_from_file_location("tracknet_benchmark", Path(__file__).with_name("benchmark-tracknet-rallies.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)
THRESHOLDS = (0.30, 0.35, 0.40)


class WindowModelCache:
    """One forward pass per window; postprocessing remains threshold-specific."""
    def __init__(self, model):
        self.model = model
        self.output = None
        self.calls = 0

    def __call__(self, tensor):
        if self.output is None:
            self.output = self.model(tensor).detach().to("cpu")
            self.calls += 1
        return self.output


class ThresholdPredictor(TrackNetPredictor):
    def __init__(self, loaded, thresholds=THRESHOLDS):
        self.thresholds = tuple(sorted(set(thresholds) | {0.35}))
        self.window_model = WindowModelCache(loaded.model)
        shared = replace(loaded, model=self.window_model)
        super().__init__(shared, confidence_threshold=.35, roi_model_scale=TRACKNET_ROI_MODEL_SCALE)
        self.peers = {
            threshold: TrackNetPredictor(shared, confidence_threshold=threshold,
                                         roi_model_scale=TRACKNET_ROI_MODEL_SCALE)
            for threshold in self.thresholds
        }
        self.trajectories = {threshold: [] for threshold in self.thresholds}

    def predict(self, *args, **kwargs):
        # A reused benchmark object must not carry tracks across source videos.
        self.window_model.output = None
        self.window_model.calls = 0
        for threshold, peer in self.peers.items():
            peer._model_history.clear()
            peer._miss_count = 0
            peer._inference_seconds = 0.0
            self.trajectories[threshold].clear()
        return super().predict(*args, **kwargs)

    def _predict_window(self, frames, packets, background, info, analysis_roi):
        self.window_model.output = None
        outputs = {}
        # Prepare/infer once, then independently decode the exact same float32 heatmaps.
        outputs[0.35] = self.peers[0.35]._predict_window(frames, packets, background, info, analysis_roi)
        heatmaps = self.window_model.output.numpy()[0]
        for threshold, predictor in self.peers.items():
            if threshold != 0.35:
                outputs[threshold] = predictor._points_from_heatmaps(heatmaps, packets, info, analysis_roi)
            self.trajectories[threshold].extend(outputs[threshold])
        self.window_model.output = None
        return outputs[0.35]


def rank_thresholds(summaries):
    """Weight each reference rally equally, rather than averaging video percentages."""
    ranking = []
    for threshold in summaries[0]["thresholds"]:
        metrics = [video["thresholds"][threshold] for video in summaries]
        predicted = sum(item["predicted_count"] for item in metrics)
        target = sum(item["target_count"] for item in metrics)
        matched = sum(item["matched_count"] for item in metrics)
        ranking.append({
            "threshold": float(threshold), "predicted_count": predicted,
            "target_count": target, "matched_count": matched,
            "precision": matched / predicted if predicted else 0.0,
            "recall": matched / target if target else 0.0,
            "f1": 2 * matched / (predicted + target) if predicted + target else 0.0,
        })
    return sorted(ranking, key=lambda item: item["f1"], reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=Path, action="append", required=True,
                        help="BlurBall history record; repeat for multiple videos")
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    parser.add_argument("--thresholds", type=float, nargs="+", default=THRESHOLDS)
    args = parser.parse_args()
    if any(not 0 < value < 1 for value in args.thresholds):
        parser.error("Thresholds must be between zero and one")
    import torch
    import cv2
    import numpy as np
    if args.device == "mps" and not torch.backends.mps.is_available():
        parser.error("MPS is unavailable")
    loaded = load_tracknet(args.weights, "cpu" if args.device == "mps" else args.device)
    if args.device == "mps":
        loaded = replace(loaded, model=loaded.model.to("mps"), device=torch.device("mps"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    weight_hash = benchmark.sha256(args.weights)
    summaries = []
    for target in args.target:
        history = json.loads(target.read_text())
        if history["analysis"]["model_provenance"]["profile"] != "blurball_v1":
            parser.error(f"Expected a BlurBall reference: {target}")
        video = Path(history["source"]["path"])
        calibration, reference = benchmark.load_target(target)
        roi = build_analysis_roi(calibration)
        config = VisibilityMotionConfig(roi.width, roi.height, is_end_on_table_view(calibration.points))
        predictor = ThresholdPredictor(loaded, args.thresholds)
        started = time.perf_counter()
        last = [0.0]
        def progress(done, total):
            now = time.perf_counter()
            if now - last[0] >= 30:
                print(f"{video.name}: {done}/{total} frames ({now-started:.1f}s)", flush=True)
                last[0] = now
        _, info, stats = predictor.predict(video, progress_callback=progress, analysis_roi=roi)
        payload = {
            "schema_version": 1,
            "inputs": {"video": str(video), "video_sha256": benchmark.sha256(video),
                       "weights_sha256": weight_hash, "target_sha256": benchmark.sha256(target),
                       "calibration": history["calibration"], "roi": asdict(roi),
                       "roi_model_scale": TRACKNET_ROI_MODEL_SCALE,
                       "model_size": [stats.model_width, stats.model_height]},
            "environment": {"platform": platform.platform(), "python": platform.python_version(),
                            "torch": torch.__version__, "opencv": cv2.__version__,
                            "numpy": np.__version__, "device": args.device},
            "video": {"fps": info.fps, "frames": info.decoded_frame_count, "duration": info.duration},
            "shared_forward_passes": predictor.window_model.calls,
            "elapsed_seconds": time.perf_counter() - started,
            "target_rallies": reference,
            "thresholds": {},
        }
        for threshold, points in predictor.trajectories.items():
            if len(points) != info.decoded_frame_count:
                raise ValueError("Threshold trajectory frame count mismatch")
            rallies = tracknet_visibility_rallies(points, info.fps, calibration, motion_config=config)
            intervals = [(r.start_time, r.end_time) for r in rallies]
            payload["thresholds"][str(threshold)] = {
                "detected_frames": sum(p.visibility for p in points),
                "rallies": [asdict(r) for r in rallies],
                "iou_30": benchmark.matching_summary(intervals, reference, minimum_iou=.3),
                "iou_50": benchmark.matching_summary(intervals, reference, minimum_iou=.5),
                "trajectory": [asdict(p) for p in points],
            }
        output = args.output_dir / (video.stem + ".json")
        output.write_text(json.dumps(payload, ensure_ascii=False))
        compact = {"video": video.name, "elapsed_seconds": payload["elapsed_seconds"],
                   "thresholds": {key: {metric: value for metric, value in item["iou_50"].items()
                                        if not isinstance(value, list)}
                                  for key, item in payload["thresholds"].items()}}
        summaries.append(compact)
        (args.output_dir / "summary.json").write_text(json.dumps(summaries, ensure_ascii=False, indent=2))
        print(json.dumps(compact, ensure_ascii=False), flush=True)
    (args.output_dir / "ranking.json").write_text(json.dumps(rank_thresholds(summaries), indent=2))


if __name__ == "__main__":
    main()
