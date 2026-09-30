"""Fit on train sites, select using train-site out-of-fold scores, then evaluate val once."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from huji_student.common import atomic_json, sha256_file
from . import calibration
from .decoder import DecoderConfig
from .evaluation import evaluate, load_dataset, summarize
from .pipeline import decode_timeline, recognize
from .scores import Scores


ROOT = Path(__file__).resolve().parents[1]


def fold_sites(sequences: list[dict], count: int = 3) -> list[list[str]]:
    sites = {s["site"] for s in sequences}
    sizes = {site: sum(np.sum(s["truth"] >= 0) for s in sequences if s["site"] == site) for site in sites}
    folds, totals = [[] for _ in range(count)], [0] * count
    for site in sorted(sites, key=lambda s: (-sizes[s], s)):
        target = int(np.argmin(totals))
        folds[target].append(site)
        totals[target] += sizes[site]
    return folds


def duration_prior(sequences: list[dict]) -> tuple:
    # Conservative lower-tail bounds, not medians or a hard maximum duration.
    return tuple(float(np.clip(np.quantile([
        float(r["end_sec"]) - float(r["start_sec"])
        for s in sequences for r in s["intervals"] if r["label"] == label], .1), .1, 1.5))
        for label in ("FIRE", "PLAY", "OTHER"))


def objective(report: dict) -> float:
    values = []
    for site in report["per_site"].values():
        metrics = site["rallies"]["at_iou"]
        values.append(.5 * metrics["0.5"]["f1"] + .2 * metrics["0.75"]["f1"]
                      + .15 * site["frame"]["macro_f1"] + .15 * site["frame"]["active_iou"])
    return float(np.mean(values))


def run(cache: Path, output: Path, model_path: Path, hierarchical: bool = False):
    if model_path.exists() or (output / "report.json").exists():
        raise FileExistsError("Choose new paths to preserve the fitted model and evaluation receipt")
    # The historical sealed test is never read here. Small itself saw all these
    # videos during distillation, so even val is only a decoder holdout.
    train = load_dataset(ROOT, cache, ("train",))
    folds = fold_sites(train)
    prior = duration_prior(train)
    oof_options = {} if hierarchical else {"raw": [s["scores"] for s in train]}
    for regularization in ((.01,) if hierarchical else (.01, .1)):
        predictions = [None] * len(train)
        for index, sites in enumerate(folds):
            fitting = [s for s in train if s["site"] not in sites]
            fitted = calibration.fit(fitting, regularization)
            for position, sequence in enumerate(train):
                if sequence["site"] in sites:
                    predictions[position] = calibration.predict(sequence["scores"], sequence["fps"], fitted)
            print(f"CALIBRATED ridge={regularization} fold={index + 1} held_out_sites={sites}", flush=True)
        oof_options[str(regularization)] = predictions
    best_score, selected, candidates = -1., None, []
    if hierarchical:
        grid = list(itertools.product((0.,), (.1, .35, .7), (0., .25, .5, .75, 1.), (.2, 1., 3.)))
    else:
        grid = [(duration, switch, 0., .2) for duration in (.0, .35, .7) for switch in (.1, .35, .7, 1.2)]
    for name, probabilities in oof_options.items():
        for duration_scale, switch, activity_weight, reset_cost in grid:
            config = DecoderConfig(tuple(round(d * duration_scale, 3) for d in prior), switch,
                                   ((0., 0., .2), (reset_cost, 0., 0.), (0., .2, 0.))).to_dict()
            combined = [calibration.combine_activity(s["scores"], p, s["fps"], activity_weight)
                        for s, p in zip(train, probabilities)]
            results = [evaluate(s, decode_timeline(p, s["fps"], config)) for s, p in zip(train, combined)]
            summary = summarize(results)
            score = objective(summary)
            record = {"calibration": name, "duration_scale": duration_scale, "decoder": config,
                      "raw_activity_weight": activity_weight,
                      "objective": score, "rally_f1_50": summary["rallies"]["at_iou"]["0.5"]["f1"],
                      "site_equal_rally_f1_50": summary["site_equal_rally_f1_50"]}
            candidates.append(record)
            if score > best_score:
                best_score, selected = score, record
            print(f"CANDIDATE {name} min={duration_scale} switch={switch} active={activity_weight} "
                  f"reset={reset_cost} objective={score:.4f}", flush=True)
    fitted = None if selected["calibration"] == "raw" else calibration.fit(train, float(selected["calibration"]))
    identities = {s["metadata"]["checkpoint_sha256"] for s in train}
    preprocessing = {s["metadata"]["preprocessing"] for s in train}
    if len(identities) != 1 or len(preprocessing) != 1:
        raise ValueError("Mixed checkpoints or preprocessing in calibration data")
    model = {"schema_version": 1, "analysis_fps": 10., "class_order": ["serve", "play", "other"],
             "checkpoint_sha256": next(iter(identities)), "preprocessing": next(iter(preprocessing)),
             "decoder": selected["decoder"], "calibration": fitted,
             "raw_activity_weight": selected["raw_activity_weight"],
             "fit_sites": sorted({s["site"] for s in train}),
             "selection": "three-fold site-held-out predictions within train; val excluded from fitting and selection",
             "annotation_sha256": sha256_file(ROOT / "data/annotations/intervals.csv"),
             "split_sha256": sha256_file(ROOT / "data/splits/videos.csv"),
             "generalization_status": "decoder_holdout_only; image model saw all current source videos"}
    model["model_id"] = hashlib.sha256(json.dumps(model, sort_keys=True).encode()).hexdigest()[:16]
    atomic_json(model_path, model)  # Freeze before opening/evaluating val.
    validation = load_dataset(ROOT, cache, ("val",))
    if set(model["fit_sites"]) & {s["site"] for s in validation}:
        raise ValueError("Calibration/validation site leakage")
    reports = {}
    for split, sequences in (("train_fit_diagnostic", train), ("val_decoder_holdout", validation)):
        methods = {"raw_argmax": [], "duration_only": [], "temporal_decoder": []}
        for sequence in sequences:
            p, fps = sequence["scores"], sequence["fps"]
            methods["raw_argmax"].append(evaluate(sequence, p.argmax(axis=1)))
            methods["duration_only"].append(evaluate(sequence, decode_timeline(p, fps, model["decoder"])))
            q = calibration.predict(p, fps, fitted)
            q = calibration.combine_activity(p, q, fps, model["raw_activity_weight"])
            methods["temporal_decoder"].append(evaluate(sequence, decode_timeline(q, fps, model["decoder"])))
            result = recognize(Scores(p, fps, sequence["metadata"]), model)
            atomic_json(output / "predictions" / (sequence["video_id"] + ".json"), result)
        reports[split] = {name: {"summary": summarize(rows), "per_video": rows} for name, rows in methods.items()}
    report = {"schema_version": 1, "created_at_utc": datetime.now(timezone.utc).isoformat(),
              "model_path": str(model_path.resolve()), "model_sha256": sha256_file(model_path),
              "model_id": model["model_id"], "folds": folds, "train_duration_q10_sec": prior,
              "selection_objective": "site mean: .5 rally F1@.5 + .2 rally F1@.75 + .15 phase macro F1 + .15 active IoU",
              "selected": selected, "candidates": candidates, "evaluations": reports,
              "limitations": ["Small was distilled on all current videos; no unseen-video end-to-end test",
                              "Unknown/IGNORE time is masked; no full-video false-positive claim in unreviewed gaps",
                              "References pair FIRE->PLAY across <=1.5s blank, never across annotated OTHER",
                              "Boundary errors compare annotated endpoints on one-to-one matched intervals",
                              "No temporal test split was consumed; future-context offline algorithm"]}
    report["validation_use"] = ("Repeated development validation after v1; not a fresh test" if hierarchical
                                else "First decoder validation; Small itself saw these source videos")
    atomic_json(output / "report.json", report)
    compact = {name: value["summary"] for name, value in reports["val_decoder_holdout"].items()}
    atomic_json(output / "validation_summary.json", compact)
    print(json.dumps({"selected": selected, "validation": {
        name: {"rallies": value["rallies"], "frame": value["frame"]}
        for name, value in compact.items()}}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scores", type=Path, default=ROOT / "data/rally_detection/scores")
    parser.add_argument("--output", type=Path, default=ROOT / "data/reports/rally_detection_v1")
    parser.add_argument("--model-output", type=Path, default=ROOT / "config/rally_decoder.json")
    parser.add_argument("--hierarchical", action="store_true", help="Separate activity evidence from phase evidence")
    args = parser.parse_args()
    run(args.scores, args.output, args.model_output, args.hierarchical)


if __name__ == "__main__":
    main()
