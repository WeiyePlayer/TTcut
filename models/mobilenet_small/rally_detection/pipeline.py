"""Public score-to-segments API and video-to-rallies command line."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from huji_student.common import atomic_json
from .calibration import combine_activity, predict
from .decoder import DecoderConfig, assemble_rallies, decode, segments
from .scores import Scores


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "config/rally_decoder_small_epoch1_refit_6fps_20260930_balanced.json"


def decode_timeline(probabilities: np.ndarray, fps: float, config: dict,
                    analysis_fps: float = 10.) -> np.ndarray:
    if analysis_fps <= 0 or not np.isfinite(analysis_fps):
        raise ValueError("analysis_fps must be finite and positive")
    stride = max(1, round(fps / analysis_fps))
    starts = np.arange(0, len(probabilities), stride)
    counts = np.minimum(stride, len(probabilities) - starts)
    pooled = np.add.reduceat(probabilities, starts, axis=0) / counts[:, None]
    decoded = decode(pooled, fps / stride, DecoderConfig(**config))
    return np.repeat(decoded, stride)[:len(probabilities)]


def recognize(sequence: Scores, model: dict) -> dict:
    if model.get("schema_version") != 1:
        raise ValueError("Unsupported rally decoder version")
    expected = model.get("checkpoint_sha256")
    actual = sequence.metadata.get("checkpoint_sha256")
    if actual and expected and actual != expected:
        raise ValueError("Scores and temporal model use different image checkpoints")
    expected_preprocessing = model.get("preprocessing")
    actual_preprocessing = sequence.metadata.get("preprocessing")
    if actual_preprocessing and expected_preprocessing and actual_preprocessing != expected_preprocessing:
        raise ValueError("Scores and temporal model use different preprocessing")
    probabilities = predict(sequence.values, sequence.fps, model.get("calibration"))
    calibrated = probabilities
    if model.get("algorithm") == "huji_active_first_v1":
        from .hierarchical import HierarchicalConfig, assemble, decode as decode_hierarchical
        labels, intervals = decode_hierarchical(sequence.values, probabilities, sequence.fps,
                                                HierarchicalConfig(**model["hierarchical"]))
    else:
        probabilities = combine_activity(sequence.values, probabilities, sequence.fps,
                                         model.get("raw_activity_weight", 0.))
        labels = decode_timeline(probabilities, sequence.fps, model["decoder"], model["analysis_fps"])
        if model.get("algorithm") == "huji_evidence_refinement_v1":
            from .hierarchical import assemble
            from .refinement import RefinementConfig, refine
            labels, intervals = refine(labels, sequence.values, calibrated, sequence.fps,
                                       RefinementConfig(**model["refinement"]))
    if model.get("phase_model"):
        from .phase import apply as apply_phase
        if model.get("algorithm") not in {"huji_active_first_v1", "huji_evidence_refinement_v1"}:
            raise ValueError("The phase model requires explicit fixed rally intervals")
        labels, probabilities = apply_phase(labels, sequence.values, calibrated, sequence.fps,
                                           intervals, model["phase_model"])
    phases = segments(labels, sequence.fps, probabilities)
    duration = len(labels) / sequence.fps
    rallies = (assemble(intervals, phases, sequence.fps, len(labels))
               if model.get("algorithm") in {"huji_active_first_v1", "huji_evidence_refinement_v1"}
               else assemble_rallies(phases, duration))
    return {"schema_version": 1, "time_intervals": "[start_sec, end_sec)",
            "frame_intervals": "1-based inclusive canonical frames, not original source frame indices",
            "fps": sequence.fps, "frame_count": len(labels), "duration_sec": duration,
            "offline_future_context": True, "source": sequence.metadata,
            "checkpoint_identity_verified": bool(actual and expected),
            "decoder_id": model.get("model_id"), "segments": phases,
            "rallies": rallies,
            "score_note": "mean_score is a temporal model score, not a calibrated correctness probability"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--scores", type=Path)
    source.add_argument("--video", type=Path)
    parser.add_argument("--fps", type=float, help="Required for CSV scores; NPZ includes fps")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--save-scores", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or (args.save_scores and args.save_scores.exists()):
        raise FileExistsError("Refusing to overwrite an existing recognition output")
    model = json.loads(args.model.read_text(encoding="utf-8"))
    if args.video:
        from .score import DEFAULT_CHECKPOINT, score_video
        sequence = score_video(args.video, args.checkpoint or DEFAULT_CHECKPOINT)
    else:
        sequence = Scores.load(args.scores, args.fps)
    result = recognize(sequence, model)
    if args.save_scores:
        sequence.save(args.save_scores)
    atomic_json(args.output, result)
    print(json.dumps({"output": str(args.output.resolve()), "rallies": len(result["rallies"]),
                      "segments": len(result["segments"]), "duration_sec": result["duration_sec"]},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
