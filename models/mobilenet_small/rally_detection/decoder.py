"""Duration-constrained Viterbi decoding and explicit rally assembly.

The objective integrates log scores over seconds and charges for state changes.
Minimum dwell times suppress brief dropouts, without imposing a maximum rally
length or inventing a serve at the beginning of a clipped video.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from .scores import CLASSES, Scores


@dataclass(frozen=True)
class DecoderConfig:
    min_duration_sec: tuple[float, float, float] = (0.4, 0.5, 0.5)
    switch_cost: float = 0.5
    # All transitions remain possible: failed serves, clipped footage and missed
    # serves occur in real video. The usual cycle receives a lower cost.
    transition_cost: tuple[tuple[float, ...], ...] = ((0., 0., 0.2), (0.2, 0., 0.), (0., 0.2, 0.))

    def to_dict(self):
        return asdict(self)


def decode(values: np.ndarray, fps: float, config: DecoderConfig) -> np.ndarray:
    p = Scores(values, fps, {}).values
    minimum = np.asarray(config.min_duration_sec, dtype=float)
    transition = np.asarray(config.transition_cost, dtype=float)
    if (minimum.shape != (3,) or not np.isfinite(minimum).all() or np.any(minimum < 0)
            or not np.isfinite(config.switch_cost) or config.switch_cost < 0
            or transition.shape != (3, 3) or not np.isfinite(transition).all()
            or np.any(transition < 0)):
        raise ValueError("Invalid duration or transition costs")
    dwell = np.maximum(1, np.ceil(minimum * fps - 1e-9).astype(int))
    n = len(p)
    prefix = np.vstack([np.zeros(3), np.cumsum(np.log(np.maximum(p, 1e-7)) / fps, axis=0)])
    best = np.full((n + 1, 3), -np.inf)
    previous_class = np.full((n + 1, 3), -1, dtype=np.int8)
    previous_time = np.zeros((n + 1, 3), dtype=np.int32)
    # The first segment is left-censored, so its minimum duration is relaxed.
    entry_value = np.zeros(3)
    entry_time = np.zeros(3, dtype=np.int32)
    entry_class = np.full(3, -1, dtype=np.int8)
    cost = transition + config.switch_cost
    np.fill_diagonal(cost, np.inf)
    classes = np.arange(3)
    for end in range(1, n + 1):
        starts = end - dwell
        safe_starts = np.maximum(starts, 0)
        candidates = best[safe_starts] - cost.T
        parents = np.argmax(candidates, axis=1)
        candidate_values = candidates[classes, parents] - prefix[safe_starts, classes]
        improve = (starts >= 1) & (candidate_values > entry_value)
        entry_value[improve] = candidate_values[improve]
        entry_time[improve] = starts[improve]
        entry_class[improve] = parents[improve]
        best[end] = prefix[end] + entry_value
        previous_time[end] = entry_time
        previous_class[end] = entry_class
    # The last segment is right-censored too; never erase a short final event.
    for state in range(3):
        for start in range(max(1, n - dwell[state] + 1), n):
            parent = int(np.argmax(best[start] - cost[:, state]))
            value = best[start, parent] - cost[parent, state] + prefix[n, state] - prefix[start, state]
            if value > best[n, state]:
                best[n, state] = value
                previous_time[n, state] = start
                previous_class[n, state] = parent
    labels = np.empty(n, dtype=np.int8)
    end, state = n, int(np.argmax(best[n]))
    while end > 0:
        start = int(previous_time[end, state])
        labels[start:end] = state
        state, end = int(previous_class[end, state]), start
    return labels


def segments(labels: np.ndarray, fps: float, scores: np.ndarray | None = None) -> list[dict]:
    labels = np.asarray(labels)
    if labels.ndim != 1 or not np.isin(labels, [0, 1, 2]).all() or fps <= 0:
        raise ValueError("Expected a one-dimensional three-class timeline and positive fps")
    if not len(labels):
        return []
    changes = np.r_[0, np.flatnonzero(labels[1:] != labels[:-1]) + 1, len(labels)]
    result = []
    for start, end in zip(changes[:-1], changes[1:]):
        state = int(labels[start])
        item = {"label": CLASSES[state], "start_frame": int(start) + 1, "end_frame": int(end),
                "start_sec": float(start / fps), "end_sec": float(end / fps),
                "duration_sec": float((end - start) / fps)}
        if scores is not None:
            item["mean_score"] = float(np.mean(scores[start:end, state]))
        result.append(item)
    return result


def assemble_rallies(phases: list[dict], duration_sec: float) -> list[dict]:
    """Join serve -> play, split on OTHER or play -> a new serve.

    This deliberately does not bridge detected OTHER. Dropout removal belongs
    in the decoder, where all three score streams compete for the same time.
    """
    result, current = [], None

    def finish():
        nonlocal current
        if current is None:
            return
        current["rally_id"] = len(result) + 1
        current["duration_sec"] = current["end_sec"] - current["start_sec"]
        current["has_serve"] = any(p["label"] == "serve" for p in current["phases"])
        current["has_play"] = any(p["label"] == "play" for p in current["phases"])
        current["kind"] = ("serve_and_play" if current["has_serve"] and current["has_play"]
                           else "serve_only" if current["has_serve"] else "play_only")
        current["touches_video_start"] = current["start_sec"] <= 1e-7
        current["touches_video_end"] = current["end_sec"] >= duration_sec - 1e-7
        result.append(current)
        current = None

    for phase in phases:
        if phase["label"] == "other":
            finish()
            continue
        if current is not None and (phase["label"] == "serve"
                                    or phase["start_sec"] > current["end_sec"] + 1e-7):
            finish()
        if current is None:
            current = {"start_sec": phase["start_sec"], "end_sec": phase["end_sec"], "phases": []}
        current["end_sec"] = phase["end_sec"]
        current["phases"].append(dict(phase))
    finish()
    return result
