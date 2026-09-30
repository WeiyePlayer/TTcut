"""Interval-level evaluation that never treats unannotated time as OTHER."""

from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

import numpy as np

from huji_student.common import video_id
from .decoder import assemble_rallies, segments
from .scores import CLASSES, Scores


LABEL_MAP = {"FIRE": 0, "PLAY": 1, "OTHER": 2}


def read_rows(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def reference_rallies(intervals: list[dict], max_serve_play_gap_sec: float = 1.5) -> list[dict]:
    """Pair the explicitly annotated FIRE -> PLAY, across small unlabeled gaps.

    This is reference construction only, never an inference-time gap filler.
    A known OTHER, IGNORE, new FIRE or a larger blank always separates rallies.
    """
    result = []
    previous = None
    for row in intervals:
        if row["label"] not in ("FIRE", "PLAY"):
            previous = row
            continue
        start, end = float(row["start_sec"]), float(row["end_sec"])
        if (row["label"] == "PLAY" and previous is not None and previous["label"] == "FIRE"
                and start - float(previous["end_sec"]) <= max_serve_play_gap_sec + 1e-6):
            result[-1]["end_sec"] = end
        else:
            result.append({"start_sec": start, "end_sec": end})
        previous = row
    return result


def load_dataset(root: Path, cache: Path, splits=("train", "val")) -> list[dict]:
    source_manifest = {r["video_id"]: r for r in read_rows(root / "data/manifests/videos.csv")}
    annotations = defaultdict(list)
    for row in read_rows(root / "data/annotations/intervals.csv"):
        annotations[row["video_id"]].append(row)
    sequences = []
    for row in read_rows(root / "data/splits/videos.csv"):
        if row["split"] not in splits:
            continue
        ident = video_id(row["relative_path"])
        path = cache / (ident + ".npz")
        scored = Scores.load(path)
        if scored.metadata["relative_path"] != row["relative_path"]:
            raise ValueError(f"Source identity mismatch: {path}")
        original = source_manifest[row["video_id"]]
        if (int(original["size_bytes"]) != scored.metadata["size_bytes"]
                or abs(float(original["duration_sec"]) - scored.metadata["duration_sec"]) > .1):
            raise ValueError(f"Source differs from the annotated source manifest: {path}")
        truth = np.full(len(scored.values), -1, dtype=np.int8)
        intervals = sorted(annotations[row["video_id"]], key=lambda r: int(r["start_frame"]))
        for interval in intervals:
            if float(interval["fps"]) != scored.fps:
                raise ValueError("Annotation and score timelines have different fps")
            start, end = int(interval["start_frame"]) - 1, int(interval["end_frame"])
            if start < 0 or end <= start or end > len(truth):
                raise ValueError(f"Annotation outside scored video: {row['relative_path']}")
            if np.any(truth[start:end] != -1):
                raise ValueError("Overlapping annotations")
            truth[start:end] = LABEL_MAP.get(interval["label"], -1)
        sequences.append({"video_id": ident, "annotation_video_id": row["video_id"],
                          "relative_path": row["relative_path"], "split": row["split"],
                          "site": row["site_session_id"], "fps": scored.fps,
                          "scores": scored.values, "truth": truth, "intervals": intervals,
                          "reference_rallies": reference_rallies(intervals),
                          "metadata": scored.metadata})
    return sequences


def interval_indices(items: list[dict], fps: float, length: int) -> np.ndarray:
    return np.array([[max(0, min(length, round(p["start_sec"] * fps))),
                      max(0, min(length, round(p["end_sec"] * fps)))] for p in items],
                    dtype=int).reshape(-1, 2)


def match_intervals(predicted: list[dict], reference: list[dict], known: np.ndarray,
                    fps: float) -> dict:
    p, r = interval_indices(predicted, fps, len(known)), interval_indices(reference, fps, len(known))
    coverage = np.r_[0, np.cumsum(known)]
    pd = coverage[p[:, 1]] - coverage[p[:, 0]]
    rd = coverage[r[:, 1]] - coverage[r[:, 0]]
    p, pd = p[pd > 0], pd[pd > 0]
    r, rd = r[rd > 0], rd[rd > 0]
    starts = np.maximum(p[:, 0, None], r[None, :, 0])
    ends = np.maximum(starts, np.minimum(p[:, 1, None], r[None, :, 1]))
    intersection = coverage[ends] - coverage[starts]
    union = pd[:, None] + rd[None, :] - intersection
    iou = np.divide(intersection, union, out=np.zeros_like(union, dtype=float), where=union > 0)
    output = {"predicted": len(p), "reference": len(r),
              "predicted_wholly_unreviewed": len(predicted) - len(p), "matches": {}}
    # Maximum-cardinality one-to-one matching at each threshold. A long
    # prediction spanning two rallies can never count as two true positives.
    for threshold in (0.1, 0.5, 0.75):
        adjacency = [list(np.flatnonzero(row >= threshold)[np.argsort(-row[row >= threshold])]) for row in iou]
        owner = {}

        def augment(pred, seen):
            for ref in adjacency[pred]:
                if ref in seen:
                    continue
                seen.add(ref)
                if ref not in owner or augment(owner[ref], seen):
                    owner[ref] = pred
                    return True
            return False

        for pred in np.argsort(-iou.max(axis=1)) if len(r) else []:
            augment(int(pred), set())
        pairs = [(pred, int(ref)) for ref, pred in owner.items()]
        output["matches"][str(threshold)] = {
            "tp": len(pairs), "fp": len(p) - len(pairs), "fn": len(r) - len(pairs),
            "ious": [float(iou[a, b]) for a, b in pairs],
            "start_errors_sec": [float((p[a, 0] - r[b, 0]) / fps) for a, b in pairs],
            "end_errors_sec": [float((p[a, 1] - r[b, 1]) / fps) for a, b in pairs],
        }
    significant = intersection >= np.maximum(1, rd[None, :] * 0.1)
    output["split_references"] = int(np.sum(significant.sum(axis=0) > 1))
    output["merged_predictions"] = int(np.sum(significant.sum(axis=1) > 1))
    return output


def evaluate(sequence: dict, labels: np.ndarray, rally_intervals: list[tuple[int, int]] | None = None) -> dict:
    truth, fps = sequence["truth"], sequence["fps"]
    if len(labels) != len(truth):
        raise ValueError("Prediction length differs from reference timeline")
    known = truth >= 0
    confusion = np.bincount(truth[known] * 3 + labels[known], minlength=9).reshape(3, 3)
    phases = segments(labels, fps)
    rallies = (assemble_rallies(phases, len(labels) / fps) if rally_intervals is None else
               [{"start_sec": start / fps, "end_sec": end / fps} for start, end in rally_intervals])
    result = {"relative_path": sequence["relative_path"], "site": sequence["site"],
              "split": sequence["split"], "duration_sec": len(labels) / fps,
              "reviewed_sec": float(known.sum() / fps), "confusion": confusion.tolist(),
              "rallies": match_intervals(rallies, sequence["reference_rallies"], known, fps),
              "predicted_active_unreviewed_sec": float(np.sum((labels != 2) & ~known) / fps),
              "phases": {}}
    for index, name in enumerate(CLASSES):
        refs = [{"start_sec": float(r["start_sec"]), "end_sec": float(r["end_sec"])}
                for r in sequence["intervals"] if LABEL_MAP.get(r["label"]) == index]
        result["phases"][name] = match_intervals([p for p in phases if p["label"] == name], refs, known, fps)
    return result


def classification_metrics(confusion):
    c = np.asarray(confusion)
    precision = np.divide(c.diagonal(), c.sum(axis=0), out=np.zeros(3), where=c.sum(axis=0) > 0)
    recall = np.divide(c.diagonal(), c.sum(axis=1), out=np.zeros(3), where=c.sum(axis=1) > 0)
    f1 = np.divide(2 * precision * recall, precision + recall, out=np.zeros(3), where=precision + recall > 0)
    active_tp = c[:2, :2].sum()
    active_fp, active_fn = c[2, :2].sum(), c[:2, 2].sum()
    return {"accuracy": float(c.diagonal().sum() / max(1, c.sum())), "macro_f1": float(f1.mean()),
            "class_f1": dict(zip(CLASSES, f1.tolist())),
            "active_precision": float(active_tp / max(1, active_tp + active_fp)),
            "active_recall": float(active_tp / max(1, active_tp + active_fn)),
            "active_iou": float(active_tp / max(1, active_tp + active_fp + active_fn))}


def summarize_matches(items: list[dict]) -> dict:
    result = {k: sum(i[k] for i in items) for k in
              ("predicted", "reference", "predicted_wholly_unreviewed", "split_references", "merged_predictions")}
    result["at_iou"] = {}
    for threshold in ("0.1", "0.5", "0.75"):
        counts = {key: sum(i["matches"][threshold][key] for i in items) for key in ("tp", "fp", "fn")}
        tp, fp, fn = counts["tp"], counts["fp"], counts["fn"]
        entry = {**counts, "precision": tp / max(1, tp + fp), "recall": tp / max(1, tp + fn),
                 "f1": 2 * tp / max(1, 2 * tp + fp + fn)}
        for edge in ("start", "end"):
            errors = [abs(e) for i in items for e in i["matches"][threshold][edge + "_errors_sec"]]
            entry[edge + "_mae_sec"] = float(np.mean(errors)) if errors else None
            entry[edge + "_p90_sec"] = float(np.quantile(errors, .9)) if errors else None
        result["at_iou"][threshold] = entry
    return result


def summarize(results: list[dict]) -> dict:
    if not results:
        raise ValueError("No evaluated videos")
    c = np.sum([r["confusion"] for r in results], axis=0)
    sites = sorted({r["site"] for r in results})
    per_site = {}
    for site in sites:
        rows = [r for r in results if r["site"] == site]
        per_site[site] = {"frame": classification_metrics(np.sum([r["confusion"] for r in rows], axis=0)),
                          "rallies": summarize_matches([r["rallies"] for r in rows])}
    return {"videos": len(results), "sites": len(sites),
            "duration_sec": sum(r["duration_sec"] for r in results),
            "reviewed_sec": sum(r["reviewed_sec"] for r in results),
            "predicted_active_unreviewed_sec": sum(r["predicted_active_unreviewed_sec"] for r in results),
            "frame": classification_metrics(c), "confusion": c.tolist(),
            "rallies": summarize_matches([r["rallies"] for r in results]),
            "phase_segments": {name: summarize_matches([r["phases"][name] for r in results]) for name in CLASSES},
            "site_equal_rally_f1_50": float(np.mean([v["rallies"]["at_iou"]["0.5"]["f1"] for v in per_site.values()])),
            "site_equal_active_iou": float(np.mean([v["frame"]["active_iou"] for v in per_site.values()])),
            "per_site": per_site}
