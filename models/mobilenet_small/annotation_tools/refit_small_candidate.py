"""Refit the frozen candidate's temporal decoder against submitted manual labels."""

from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import itertools
import json
from pathlib import Path
import sys
import time

import numpy as np

from .common import probe_video, read_csv, write_csv
from .converter import convert_tasks, INTERVAL_FIELDS
from huji_student.common import atomic_json, sha256_file
from rally_detection import calibration
from rally_detection.evaluation import evaluate, reference_rallies, summarize
from rally_detection.fit import fold_sites
from rally_detection.pipeline import decode_timeline, recognize
from rally_detection.refinement import RefinementConfig, refine
from rally_detection.scores import Scores


ROOT = Path(__file__).resolve().parents[1]
CHECKPOINT = ROOT / "huji_student/runs/manual_p3_20260930_epoch1/best.pt"
CHECKPOINT_SHA = "22f0d7639106e5997c77e76d948f1b11848cd6af7efd6fbf75d3f19e97c982ed"
IMAGE_DATASET = ROOT / "huji_student/data/manual_p3_20260930_v2"
DATASET = ROOT / "data/rally_detection/manual_continuous_20260930"
FPS = 6
LABELS = {"FIRE": 0, "PLAY": 1, "OTHER": 2}


def prepare(export: Path, continuous_export: Path):
    if (DATASET / "manifest.json").exists():
        raise FileExistsError("Continuous manual dataset is already frozen")
    image_manifest = json.loads((IMAGE_DATASET / "manifest.json").read_text(encoding="utf-8"))
    if sha256_file(export) != image_manifest["export_sha256"]:
        raise ValueError("Project 3 annotations changed since the bounded dataset")
    raw = ROOT / "data/annotations/label_studio_export.json"
    if sha256_file(continuous_export) != sha256_file(raw):
        raise ValueError("Project 2 changed: review new overlaps and frame bounds before reusing reviewed corrections")
    corrected = ROOT / "data/annotations/label_studio_export.corrected.json"
    if sha256_file(corrected) != corrected.with_suffix(".json.sha256").read_text().split()[0]:
        raise ValueError("Reviewed continuous annotation corrections changed")
    normalized, warnings = convert_tasks(json.loads(corrected.read_text(encoding="utf-8")))
    if warnings:
        raise ValueError(warnings)
    old_intervals = read_csv(ROOT / "data/annotations/intervals.csv")
    signature = lambda rs: sorted((r["video_id"], r["label"], int(r["start_frame"]), int(r["end_frame"])) for r in rs)
    if signature(normalized) != signature(old_intervals):
        raise ValueError("Reviewed interval CSV does not match the corrected project 2 snapshot")
    by_video = defaultdict(list)
    for row in old_intervals:
        by_video[row["video_id"]].append(row)
    selected = {v for v, rows in by_video.items() if sum(r["label"] == "PLAY" for r in rows) >= 2
                and any(r["label"] == "FIRE" for r in rows)}
    sources = {r["video_id"]: r for r in read_csv(ROOT / "data/manifests/videos.csv")}
    splits = {r["video_id"]: r for r in read_csv(ROOT / "data/splits/videos.csv")}
    parent = json.loads((ROOT / "huji_student/data/v1/inventory.json").read_text(encoding="utf-8"))
    hashes = {r["relative_path"]: r["source_sha256"] for r in parent["videos"]}
    tasks = {t["data"]["video_id"]: t for t in json.loads(continuous_export.read_text(encoding="utf-8"))}
    from urllib.parse import unquote

    def continuous_video(ident):
        source, split = sources[ident], splits[ident]
        task = tasks[ident]
        proxy = Path("E:/NEWMODEL") / unquote(task["data"]["video"].split("?d=", 1)[1])
        count = int(probe_video(proxy)["frame_count"])
        previous_end = 0
        for r in sorted(by_video[ident], key=lambda x: int(x["start_frame"])):
            start, end = int(r["start_frame"]), int(r["end_frame"])
            if not 1 <= start <= end <= count or start <= previous_end:
                raise ValueError(f"Reviewed continuous ranges overlap or exceed actual video: {ident}")
            previous_end = end
        return {"video_id": ident, "relative_path": source["relative_path"],
            "absolute_path": source["absolute_path"], "duration_sec": source["duration_sec"],
            "source_sha256": hashes[source["relative_path"]], "proxy_frame_count": count,
            "split": split["split"], "site_session_id": split["site_session_id"],
            "task_id": task["id"], "annotation_project": 2, "annotation_role": "continuous_serve_play_other"}

    with ThreadPoolExecutor(max_workers=4) as pool:
        videos = list(pool.map(continuous_video, sorted(selected)))
    rows = [r for ident in selected for r in by_video[ident]]
    short_intervals = read_csv(IMAGE_DATASET / "intervals.csv")
    short_by_video = defaultdict(list)
    for r in short_intervals:
        short_by_video[r["video_id"]].append(r)
    excluded = []
    for video in read_csv(IMAGE_DATASET / "videos.csv"):
        ident = video["video_id"]
        if ident in selected:
            excluded.append({"task_id": video["task_id"], "reason": "replaced_by_complete_project_2_annotation"})
        elif not any(r["label"] in ("FIRE", "PLAY") for r in short_by_video[ident]):
            excluded.append({"task_id": video["task_id"], "reason": "other_only_not_used_for_rally_fitting"})
        else:
            videos.append({k: video[k] for k in videos[0] if k in video} | {
                "annotation_project": 3, "annotation_role": "annotated_active_clip"})
            rows.extend(short_by_video[ident])
    for key in ("site_session_id", "source_sha256"):
        groups = defaultdict(set)
        for video in videos:
            groups[video[key]].add(video["split"])
        if any(len(s) > 1 for s in groups.values()):
            raise ValueError(f"Source sessions or bytes cross train/val/test: {key}")
    DATASET.mkdir(parents=True, exist_ok=True)
    rows.sort(key=lambda r: (r["video_id"], int(r["start_frame"])))
    videos.sort(key=lambda v: (v["annotation_project"], v["video_id"]))
    write_csv(DATASET / "videos.csv", videos, videos[0].keys())
    write_csv(DATASET / "intervals.csv", rows, INTERVAL_FIELDS)
    manifest = {"export_sha256": sha256_file(export), "continuous_export_path": str(continuous_export.resolve()),
        "continuous_export_sha256": sha256_file(continuous_export), "reviewed_corrected_export_sha256": sha256_file(corrected),
        "videos_sha256": sha256_file(DATASET / "videos.csv"), "intervals_sha256": sha256_file(DATASET / "intervals.csv"),
        "continuous_videos": len(selected), "video_count": len(videos), "interval_count": len(rows),
        "excluded_project_3_tasks": excluded, "other_only_excluded": True,
        "split_rule": "preserve earlier source-session split; full project 2 annotations replace duplicate partial project 3 labels",
        "image_model_exposure": "Small has seen these continuous videos; evaluation measures the decoder on held-out sessions, not unseen-image generalization"}
    atomic_json(DATASET / "manifest.json", manifest)
    print("PREPARED", json.dumps(manifest, ensure_ascii=False), flush=True)


def inputs(export: Path):
    manifest = json.loads((DATASET / "manifest.json").read_text(encoding="utf-8"))
    # Reuse only an exactly matching, already bounded and source-verified dataset.
    if sha256_file(export) != manifest["export_sha256"]:
        raise ValueError("Manual annotations changed: rebuild the bounded manual dataset first")
    if sha256_file(Path(manifest["continuous_export_path"])) != manifest["continuous_export_sha256"]:
        raise ValueError("Frozen continuous source annotations changed")
    for name in ("videos", "intervals"):
        if sha256_file(DATASET / f"{name}.csv") != manifest[f"{name}_sha256"]:
            raise ValueError(f"Frozen manual {name} changed")
    if sha256_file(CHECKPOINT) != CHECKPOINT_SHA:
        raise ValueError("Frozen first-stage fine-tuned candidate changed")
    videos = read_csv(DATASET / "videos.csv")
    intervals = defaultdict(list)
    for row in read_csv(DATASET / "intervals.csv"):
        intervals[row["video_id"]].append(row)
    return manifest, videos, intervals


def score(export: Path, output: Path, worker: Path, video_ids=None):
    import cv2
    import torch
    from rally_detection.score import infer, load_student, PREPROCESSING

    sys.path.insert(0, str(worker.resolve()))
    from ttcut_worker.mobilenet_sampling import video_arrays

    _, videos, _ = inputs(export)
    if video_ids:
        videos = [v for v in videos if v["video_id"] in set(video_ids)]
    output.mkdir(parents=True, exist_ok=True)
    cv2.setNumThreads(1)
    torch.set_num_threads(4)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_student(CHECKPOINT, device)
    for index, video in enumerate(videos, 1):
        destination = output / (video["video_id"] + ".npz")
        source = Path(video["absolute_path"])
        identity = {"checkpoint_sha256": CHECKPOINT_SHA, "source_sha256": video["source_sha256"],
                    "preprocessing": PREPROCESSING, "video_path": str(source), "sampling_fps": FPS}
        if destination.exists():
            saved = Scores.load(destination)
            if saved.fps != FPS or any(saved.metadata.get(k) != v for k, v in identity.items()):
                raise ValueError(f"Stale temporal scores: {destination}")
            continue
        if sha256_file(source) != video["source_sha256"]:
            raise ValueError(f"Source video changed: {source}")
        started = time.perf_counter()
        frames = video_arrays(source, FPS, decode_threads=4)
        chunks, batch = [], []
        try:
            for image in frames:
                batch.append(image)
                if len(batch) == 64:
                    chunks.append(infer(model, batch, device))
                    batch.clear()
            if batch:
                chunks.append(infer(model, batch, device))
        finally:
            frames.close()
        if not chunks:
            raise ValueError(f"No video frames: {source}")
        if sha256_file(source) != video["source_sha256"]:
            raise ValueError(f"Source changed during scoring: {source}")
        values = np.concatenate(chunks)
        expected = round(int(video["proxy_frame_count"]) / 30 * FPS)
        if abs(len(values) - expected) > 1:
            raise ValueError(f"Source/proxy duration mismatch: {source}, {len(values)} vs {expected}")
        Scores(values, FPS, {**identity, "device": str(device), "relative_path": video["relative_path"]}).save(destination)
        print(f"SCORED {index}/{len(videos)} {video['relative_path']} n={len(values)} sec={time.perf_counter()-started:.1f}", flush=True)
    atomic_json(output / "receipt.json", {"checkpoint_sha256": CHECKPOINT_SHA,
                "sampling_fps": FPS, "video_count": len(videos), "export_sha256": sha256_file(export),
                "preprocessing": PREPROCESSING, "scores_from_original_source_videos": True,
                "complete_dataset": not bool(video_ids)})


def load_manual(export: Path, cache: Path):
    _, videos, by_video = inputs(export)
    result = []
    for video in videos:
        scored = Scores.load(cache / (video["video_id"] + ".npz"))
        if scored.fps != FPS or scored.metadata["checkpoint_sha256"] != CHECKPOINT_SHA:
            raise ValueError("Wrong candidate or sampling timeline")
        if scored.metadata["source_sha256"] != video["source_sha256"]:
            raise ValueError("Wrong annotated source video")
        truth = np.full(len(scored.values), -1, dtype=np.int8)
        canonical = np.arange(len(truth)) * 5  # 6 fps times, in 30 fps proxy units.
        intervals = sorted(by_video[video["video_id"]], key=lambda x: int(x["start_frame"]))
        merged = []
        for row in intervals:
            start, end = int(row["start_frame"]), int(row["end_frame"])
            if not 1 <= start <= end <= int(video["proxy_frame_count"]):
                raise ValueError("Annotations extend beyond actual video")
            mask = (canonical >= start - 1) & (canonical < end)
            if np.any(truth[mask] >= 0):
                raise ValueError("Overlapping manual annotations")
            truth[mask] = LABELS.get(row["label"], -1)
            # Adjacent same-class annotations are one continuous phase.
            if merged and merged[-1]["label"] == row["label"] and int(merged[-1]["end_frame"]) + 1 == start:
                merged[-1] = {**merged[-1], "end_frame": row["end_frame"], "end_sec": row["end_sec"]}
            else:
                merged.append(dict(row))
        result.append({"video_id": video["video_id"], "relative_path": video["relative_path"],
            "split": video["split"], "site": video["site_session_id"], "fps": FPS,
            "scores": scored.values, "truth": truth, "intervals": merged,
            "reference_rallies": reference_rallies(merged), "metadata": scored.metadata})
    return result


def decoded(sequence, calibrated, decoder, weight, refinement):
    mixed = calibration.combine_activity(sequence["scores"], calibrated, FPS, weight)
    core = decode_timeline(mixed, FPS, decoder, FPS)
    return refine(core, sequence["scores"], calibrated, FPS, refinement)


def summarize_manual(rows):
    result = summarize(rows)
    for site, metrics in result["per_site"].items():
        confusion = np.sum([r["confusion"] for r in rows if r["site"] == site], axis=0)
        metrics["reviewed_other_false_activity_rate"] = float(confusion[2, :2].sum() / max(1, confusion[2].sum()))
    return result


def selection_value(report):
    """Equal-site score explicitly penalizing splits, merges and OTHER activity."""
    values = []
    for site in report["per_site"].values():
        rallies, frame = site["rallies"], site["frame"]
        reference = max(1, rallies["reference"])
        predicted = max(1, rallies["predicted"])
        # Do not optimize total rally count: one split and one merge can cancel.
        split_rate = rallies["split_references"] / reference
        merge_rate = rallies["merged_predictions"] / predicted
        # A negative-only source can have no active ground truth. Precision is
        # then zero even for an entirely correct OTHER timeline, so use the
        # fraction of reviewed OTHER time actually predicted active instead.
        false_activity = site["reviewed_other_false_activity_rate"]
        false_rally_rate = rallies["at_iou"]["0.5"]["fp"] / predicted
        values.append(.40 * rallies["at_iou"]["0.5"]["f1"]
            + .20 * rallies["at_iou"]["0.75"]["f1"] + .10 * frame["macro_f1"]
            + .10 * frame["active_iou"] - .50 * split_rate - .50 * merge_rate
            - .40 * false_activity - .15 * false_rally_rate)
    return float(np.mean(values))


def compact(summary):
    confusion = np.asarray(summary["confusion"])
    recall = np.divide(confusion.diagonal(), confusion.sum(axis=1), out=np.zeros(3), where=confusion.sum(axis=1) > 0)
    precision = np.divide(confusion.diagonal(), confusion.sum(axis=0), out=np.zeros(3), where=confusion.sum(axis=0) > 0)
    frame = {**summary["frame"], "macro_recall": float(recall.mean()),
             "class_recall": dict(zip(("serve", "play", "other"), recall.tolist())),
             "class_precision": dict(zip(("serve", "play", "other"), precision.tolist())),
             "reviewed_other_false_activity_rate": float(confusion[2, :2].sum() / max(1, confusion[2].sum())),
             "reviewed_other_false_activity_sec": float(confusion[2, :2].sum() / FPS)}
    return {"objective": selection_value(summary), "frame": frame,
            "rallies": summary["rallies"], "reviewed_sec": summary["reviewed_sec"]}


def fit(export: Path, cache: Path, output: Path, model_path: Path, reuse_folds: Path | None = None):
    if model_path.exists() or (output / "report.json").exists():
        raise FileExistsError("Use new frozen decoder and report paths")
    sequences = load_manual(export, cache)
    train = [s for s in sequences if s["split"] == "train"]
    folds = fold_sites(train)
    probabilities = {}
    for ridge in (.01, .1):
        oof = [None] * len(train)
        for index, sites in enumerate(folds):
            fitting = [s for s in train if s["site"] not in sites]
            if reuse_folds:
                prior_report = json.loads((reuse_folds / "report.json").read_text(encoding="utf-8"))
                if (prior_report["folds"] != folds or prior_report["checkpoint_sha256"] != CHECKPOINT_SHA
                        or prior_report["export_sha256"] != sha256_file(export)):
                    raise ValueError("Prior calibration folds have different source identities")
                prior_model = json.loads(Path(prior_report["model_path"]).read_text(encoding="utf-8"))
                if (sha256_file(Path(prior_report["model_path"])) != prior_report["model_sha256"]
                        or prior_model["intervals_sha256"] != sha256_file(DATASET / "intervals.csv")
                        or prior_model["split_sha256"] != sha256_file(DATASET / "videos.csv")):
                    raise ValueError("Prior calibration folds have different annotations or splits")
                fitted = json.loads((reuse_folds / "folds" / f"ridge_{ridge}_fold_{index}.json").read_text(encoding="utf-8"))
            else:
                fitted = calibration.fit(fitting, ridge)
            atomic_json(output / "folds" / f"ridge_{ridge}_fold_{index}.json", fitted)
            for position, sequence in enumerate(train):
                if sequence["site"] in sites:
                    oof[position] = calibration.predict(sequence["scores"], FPS, fitted)
            print(f"CALIBRATED ridge={ridge} fold={index+1} held_out_sites={sites}", flush=True)
        probabilities[str(ridge)] = oof
    # First select temporal parameters using out-of-fold train-site predictions.
    # A modest grid includes raw evidence, shorter/longer switching inertia,
    # and explicit PLAY->SERVE reset costs. Validation and test never select.
    candidates = []
    no_growth = RefinementConfig(max_growth_sec=0, max_bridge_sec=0)
    dwell_options = ((0., 0., 0.), (.25, .5, .5), (.25, .5, 1.), (.5, .5, 1.5), (.5, 1., 2.))
    tasks = list(itertools.product(probabilities, (.10, .35, .70), (0., .20), (0., .25, .50), dwell_options))

    def candidate(item):
        name, switch, reset, weight, dwell = item
        decoder = {"min_duration_sec": list(dwell), "switch_cost": switch,
                   "transition_cost": [[0., 0., .2], [reset, 0., 0.], [0., .2, 0.]]}
        rows = []
        for s, p in zip(train, probabilities[name]):
            labels, intervals = decoded(s, p, decoder, weight, no_growth)
            rows.append(evaluate(s, labels, intervals))
        summary = summarize_manual(rows)
        record = {"ridge": float(name), "decoder": decoder, "raw_activity_weight": weight,
                  "metrics": compact(summary)}
        return record

    # Numeric decoding work is bounded to independent candidates; all reads.
    for index, item in enumerate(tasks):
        record = candidate(item)
        candidates.append(record)
        if index % 6 == 0:
            print(f"DECODER {index+1}/{len(tasks)} objective={record['metrics']['objective']:.5f}", flush=True)
    selected = max(candidates, key=lambda r: r["metrics"]["objective"])
    oof = probabilities[str(selected["ridge"])]
    mixed = [calibration.combine_activity(s["scores"], p, FPS, selected["raw_activity_weight"])
             for s, p in zip(train, oof)]
    cores = [decode_timeline(p, FPS, selected["decoder"], FPS) for p in mixed]
    refinement_candidates = []
    refinements = [no_growth] + [RefinementConfig(raw_activity_weight=w, evidence_threshold=t,
        max_growth_sec=g, max_bridge_sec=b) for w, t, g, b in itertools.product(
        (0., .5), (.45, .55, .65), (.5, 1.5), (0., .5))]
    for cfg in refinements:
        rows = []
        for s, p, core in zip(train, oof, cores):
            labels, intervals = refine(core, s["scores"], p, FPS, cfg)
            rows.append(evaluate(s, labels, intervals))
        refinement_candidates.append({"config": cfg.to_dict(), "metrics": compact(summarize_manual(rows))})
    best_ref = max(refinement_candidates, key=lambda r: r["metrics"]["objective"])
    fitted = calibration.fit(train, selected["ridge"])
    model = {"schema_version": 1, "analysis_fps": float(FPS), "class_order": ["serve", "play", "other"],
        "checkpoint_sha256": CHECKPOINT_SHA, "preprocessing": sequences[0]["metadata"]["preprocessing"],
        "algorithm": "huji_evidence_refinement_v1", "decoder": selected["decoder"],
        "raw_activity_weight": selected["raw_activity_weight"], "calibration": fitted,
        "refinement": best_ref["config"], "fit_sites": sorted({s["site"] for s in train}),
        "fit_sampling_fps": FPS, "checkpoint_calibration_status": "refitted_for_pinned_finetuned_checkpoint",
        "annotation_sha256": sha256_file(export), "intervals_sha256": sha256_file(DATASET / "intervals.csv"),
        "split_sha256": sha256_file(DATASET / "videos.csv"),
        "selection": "three-fold source-session held-out predictions within train; val/test excluded",
        "selection_objective": "equal-site rally F1@.5/.75, phase macro F1, active IoU; explicit split/merge/false-activity penalties",
        "unknown_time_policy": "unannotated and IGNORE are excluded, never OTHER"}
    model["selection_objective_weights"] = {"rally_f1_50": .40, "rally_f1_75": .20,
        "phase_macro_f1": .10, "active_iou": .10, "split_penalty": .50,
        "merge_penalty": .50, "other_false_activity_penalty": .40, "false_rally_penalty": .15}
    import hashlib
    model["model_id"] = hashlib.sha256(json.dumps(model, sort_keys=True).encode()).hexdigest()[:16]
    atomic_json(model_path, model)  # Freeze before validation/test evaluation.
    baseline = json.loads((ROOT / "config/rally_decoder_v4_manual_p3_epoch1.json").read_text(encoding="utf-8"))
    baseline["analysis_fps"] = float(FPS)
    evaluations = {}
    for split in ("train", "val", "test"):
        items = [s for s in sequences if s["split"] == split]
        if split != "train" and set(model["fit_sites"]) & {s["site"] for s in items}:
            raise ValueError("Source-session leakage into evaluation")
        methods = {"raw_argmax": [], "candidate_old_decoder": [], "candidate_refitted_decoder": []}
        for s in items:
            methods["raw_argmax"].append(evaluate(s, s["scores"].argmax(axis=1)))
            for name, config in (("candidate_old_decoder", baseline), ("candidate_refitted_decoder", model)):
                p = calibration.predict(s["scores"], FPS, config["calibration"])
                labels, intervals = decoded(s, p, config["decoder"], config["raw_activity_weight"],
                    RefinementConfig(**config["refinement"]))
                methods[name].append(evaluate(s, labels, intervals))
            prediction = recognize(Scores(s["scores"], FPS, s["metadata"]), model)
            atomic_json(output / "predictions" / (s["video_id"] + ".json"), prediction)
        evaluations[split] = {name: {"summary": summarize_manual(rows), "per_video": rows} for name, rows in methods.items()}
        print("EVALUATED", split, json.dumps({name: compact(summarize_manual(rows)) for name, rows in methods.items()}), flush=True)
    report = {"model_path": str(model_path.resolve()), "model_sha256": sha256_file(model_path),
        "checkpoint_path": str(CHECKPOINT), "checkpoint_sha256": CHECKPOINT_SHA,
        "export_path": str(export), "export_sha256": sha256_file(export), "sampling_fps": FPS,
        "annotated_videos": len(sequences), "folds": folds, "selected": selected,
        "selected_refinement": best_ref, "decoder_candidates": candidates,
        "refinement_candidates": refinement_candidates, "evaluations": evaluations,
        "limitations": ["Manual labels are partial; no false-positive claim in unannotated time",
            "OTHER contains empty tables and other non-rally actions; no separate empty-table subclass",
            "Continuous videos use complete, previously reviewed project 2 labels; project 3 Other-only tasks are excluded",
            "Small fine-tuning already used train labels; decoder OOF is not an end-to-end unseen-site test",
            "Test labels were previously evaluated for image candidates; this is a reused evaluation set, not a fresh test",
            "Decoder validation/test were also evaluated in the initial refit; this balanced iteration uses train OOF selection only but is repeated development evaluation",
            "Reference FIRE->PLAY may cross <=1.5 seconds unknown time, never labelled OTHER",
            "No image-weight training in this run; frozen first-stage candidate only"]}
    atomic_json(output / "report.json", report)
    atomic_json(output / "summary.json", {split: {name: compact(value["summary"]) for name, value in methods.items()}
                for split, methods in evaluations.items()})
    print("FROZEN", model_path, sha256_file(model_path), flush=True)


def main():
    global ROOT, CHECKPOINT, IMAGE_DATASET, DATASET
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "score", "fit"))
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--scores", type=Path)
    parser.add_argument("--continuous-export", type=Path)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--video-id", nargs="+")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--model-output", type=Path)
    parser.add_argument("--reuse-folds", type=Path)
    parser.add_argument("--project-root", type=Path, default=ROOT,
                        help="Training-data project root; algorithms are imported from this snapshot")
    args = parser.parse_args()
    ROOT = args.project_root.resolve()
    CHECKPOINT = ROOT / "huji_student/runs/manual_p3_20260930_epoch1/best.pt"
    IMAGE_DATASET = ROOT / "huji_student/data/manual_p3_20260930_v2"
    DATASET = ROOT / "data/rally_detection/manual_continuous_20260930"
    if args.stage == "prepare":
        if args.continuous_export is None:
            parser.error("prepare requires --continuous-export")
        prepare(args.export, args.continuous_export)
    elif args.stage == "score":
        if args.worker is None:
            parser.error("score requires --worker with the actual TTcut sampling implementation")
        score(args.export, args.scores, args.worker, args.video_id)
    else:
        if args.output is None or args.model_output is None:
            parser.error("fit requires --output and --model-output")
        fit(args.export, args.scores, args.output, args.model_output, args.reuse_folds)


if __name__ == "__main__":
    main()
