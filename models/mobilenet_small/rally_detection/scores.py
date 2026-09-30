"""Score sequence interchange, without a dependency on Torch or video decoding."""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


CLASSES = ("serve", "play", "other")


@dataclass
class Scores:
    values: np.ndarray
    fps: float
    metadata: dict

    def __post_init__(self):
        self.values = np.asarray(self.values, dtype=np.float64)
        if not np.isfinite(self.fps) or self.fps <= 0:
            raise ValueError("fps must be positive and finite")
        p = self.values
        if (p.ndim != 2 or p.shape[1] != 3 or not len(p)
                or not np.isfinite(p).all() or np.any(p < 0) or np.any(p > 1)
                or not np.allclose(p.sum(axis=1), 1, atol=1e-4)):
            raise ValueError("Expected a nonempty N x 3 sequence of finite softmax scores")

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("wb") as stream:
            np.savez_compressed(stream, scores=self.values.astype(np.float32), fps=self.fps,
                                metadata=json.dumps(self.metadata, ensure_ascii=False))
        temporary.replace(path)

    @classmethod
    def load(cls, path: Path, fps: float | None = None) -> Scores:
        if path.suffix.lower() == ".npz":
            with np.load(path, allow_pickle=False) as saved:
                return cls(saved["scores"], float(saved["fps"]), json.loads(str(saved["metadata"])))
        if fps is None:
            raise ValueError("CSV input requires an explicit --fps")
        with path.open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        if not rows:
            raise ValueError("Empty score CSV")
        columns = CLASSES if all(k in rows[0] for k in CLASSES) else ("FIRE", "PLAY", "OTHER")
        ids = {r.get("video_id", "") for r in rows}
        if len(ids) != 1:
            raise ValueError("A score file must contain exactly one video")
        for i, row in enumerate(rows):
            if int(row["frame_index"]) != i + 1 or abs(float(row["time_sec"]) - i / fps) > 1e-5:
                raise ValueError("Scores must be dense, ordered, start at frame 1/time 0, and match fps")
        return cls(np.array([[float(r[k]) for k in columns] for r in rows]), fps,
                   {"video_id": next(iter(ids)), "input_csv": str(path.resolve())})


def from_labels(labels: list[str], fps: float, confidence: float = 0.9) -> Scores:
    """Compatibility for hard labels; retaining the original soft scores is preferable."""
    if not 1 / 3 < confidence <= 1:
        raise ValueError("confidence must be in (1/3, 1]")
    lookup = {"FIRE": 0, "PLAY": 1, "OTHER": 2, **{v: i for i, v in enumerate(CLASSES)}}
    values = np.full((len(labels), 3), (1 - confidence) / 2)
    for i, label in enumerate(labels):
        if label not in lookup:
            raise ValueError(f"Unknown label: {label}")
        values[i, lookup[label]] = confidence
    return Scores(values, fps, {"hard_labels_only": True})
