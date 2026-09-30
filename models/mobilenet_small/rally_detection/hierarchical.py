"""Huji-inspired active-first recognition, with independent phase decoding.

Algorithmic references (inspected at commit 82cd429e):
  hhoao/huji-algorithm, action_segment_detector.py (window evidence density),
  autoclip_constant.py (merge FIRE/PLAY before detecting matches).
This is a new score-based implementation, not a vendored upstream detector.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from .calibration import mean_window
from .scores import Scores


@dataclass(frozen=True)
class HierarchicalConfig:
    raw_activity_weight: float = .25
    activity_threshold: float = .5
    activity_switch_cost: float = .25
    activity_smooth_sec: float = .3
    evidence_window_sec: float = .8
    evidence_fraction: float = .6
    evidence_threshold: float = .6
    min_evidence_sec: float = .2
    phase_switch_cost: float = .15
    phase_mode: str = "ordered"
    analysis_fps: float = 10.

    def to_dict(self):
        return asdict(self)

    def validate(self):
        for name in ("raw_activity_weight", "evidence_fraction", "evidence_threshold"):
            if not np.isfinite(getattr(self, name)) or not 0 <= getattr(self, name) <= 1:
                raise ValueError(f"{name} must be in [0, 1]")
        if not np.isfinite(self.activity_threshold) or not 0 < self.activity_threshold < 1:
            raise ValueError("activity_threshold must be in (0, 1)")
        for name in ("activity_switch_cost", "activity_smooth_sec", "evidence_window_sec",
                     "min_evidence_sec", "phase_switch_cost"):
            if not np.isfinite(getattr(self, name)) or getattr(self, name) < 0:
                raise ValueError(f"{name} must be finite and nonnegative")
        if not np.isfinite(self.analysis_fps) or self.analysis_fps <= 0:
            raise ValueError("analysis_fps must be positive")
        if self.phase_mode not in {"ordered", "free"}:
            raise ValueError("Unknown phase decoder")


def binary_viterbi(active: np.ndarray, fps: float, switch_cost: float, threshold: float) -> np.ndarray:
    """Two-state objective; ambiguity between serve and play cannot vote OTHER."""
    probability = np.clip(active, 1e-7, 1 - 1e-7)
    odds = np.log(probability / (1 - probability)) - np.log(threshold / (1 - threshold))
    emission = np.column_stack([np.zeros(len(active)), odds / fps])
    state = emission[0].copy()
    parents = np.zeros((len(active), 2), dtype=np.int8)
    for i in range(1, len(active)):
        stay0, change0 = state[0], state[1] - switch_cost
        stay1, change1 = state[1], state[0] - switch_cost
        parents[i] = (int(change0 > stay0), int(stay1 >= change1))
        state = np.array([max(stay0, change0), max(stay1, change1)]) + emission[i]
    labels = np.empty(len(active), dtype=np.int8)
    labels[-1] = state.argmax()
    for i in range(len(active) - 1, 0, -1):
        labels[i - 1] = parents[i, labels[i]]
    return labels.astype(bool)


def active_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    boundaries = np.flatnonzero(np.diff(np.r_[False, mask, False]))
    return [(int(a), int(b)) for a, b in boundaries.reshape(-1, 2)]


def activity_segments(raw: np.ndarray, calibrated: np.ndarray, fps: float,
                      config: HierarchicalConfig) -> list[tuple[int, int]]:
    config.validate()
    if raw.shape != calibrated.shape:
        raise ValueError("Raw and calibrated scores must share a timeline")
    raw_active, calibrated_active = raw[:, :2].sum(axis=1), calibrated[:, :2].sum(axis=1)
    active = config.raw_activity_weight * raw_active + (1 - config.raw_activity_weight) * calibrated_active
    radius = max(0, round(config.activity_smooth_sec * fps / 2))
    active = mean_window(active[:, None], radius, radius)[:, 0]
    stride = max(1, round(fps / config.analysis_fps))
    starts = np.arange(0, len(active), stride)
    count = np.minimum(stride, len(active) - starts)
    pooled = np.add.reduceat(active, starts) / count
    mask = np.repeat(binary_viterbi(pooled, fps / stride, config.activity_switch_cost,
                                    config.activity_threshold), stride)[:len(active)]
    result = []
    for begin, end in active_runs(mask):
        evidence = active[begin:end] >= config.evidence_threshold
        window = max(1, round(config.evidence_window_sec * fps))
        half = window // 2
        density = mean_window(evidence[:, None].astype(float), half, half)[:, 0]
        # Absolute evidence time prevents isolated spikes passing at a clipped
        # edge. A genuinely very short high-confidence clip remains admissible.
        required = min(config.min_evidence_sec, (end - begin) / fps)
        if density.max() >= config.evidence_fraction and evidence.sum() / fps + 1e-9 >= required:
            result.append((begin, end))
    return result


def phase_labels(probabilities: np.ndarray, fps: float, switch_cost: float,
                 mode: str = "ordered") -> np.ndarray:
    """A rally can start in PLAY, finish in SERVE, or make one SERVE->PLAY change.

    In ordered mode both zero-length edge phases are legal. No artificial serve
    is prepended to a clip that begins during an exchange.
    """
    conditional = probabilities[:, :2] / np.maximum(probabilities[:, :2].sum(axis=1, keepdims=True), 1e-7)
    if mode == "free":
        return binary_viterbi(conditional[:, 1], fps, switch_cost, .5).astype(np.int8)
    likelihood = np.log(np.maximum(conditional, 1e-7)) / fps
    prefix = np.r_[0., np.cumsum(likelihood[:, 0])]
    suffix = np.r_[np.cumsum(likelihood[::-1, 1])[::-1], 0.]
    choices = prefix + suffix
    choices[1:-1] -= switch_cost
    boundary = int(np.argmax(choices))
    labels = np.ones(len(probabilities), dtype=np.int8)
    labels[:boundary] = 0
    return labels


def decode(raw: np.ndarray, calibrated: np.ndarray, fps: float,
           config: HierarchicalConfig) -> tuple[np.ndarray, list[tuple[int, int]]]:
    raw = Scores(raw, fps, {}).values
    calibrated = Scores(calibrated, fps, {}).values
    intervals = activity_segments(raw, calibrated, fps, config)
    labels = np.full(len(raw), 2, dtype=np.int8)
    for begin, end in intervals:
        labels[begin:end] = phase_labels(calibrated[begin:end], fps, config.phase_switch_cost, config.phase_mode)
    return labels, intervals


def huji_density_baseline(raw: np.ndarray, fps: float, window_sec: float = 2.,
                          minimum_hits: int = 5, sample_fps: float = 6.) -> list[tuple[int, int]]:
    """Reproduce Huji's merged-label window-count idea on Small predictions.

    This is a comparison adapter, not an evaluation of Huji's original model.
    Sample endpoints are extended by one sample period for half-open intervals;
    no clipping padding, minimum-length output filter or replay filter is used.
    """
    stride = max(1, round(fps / sample_fps))
    indices = np.arange(0, len(raw), stride)
    hits = indices[raw[indices].argmax(axis=1) != 2]
    if len(hits) < minimum_hits:
        return []
    left, right, groups = 0, 0, []
    while right < len(hits):
        while (hits[right] - hits[left]) / fps > window_sec + 1e-9:
            left += 1
        if right - left + 1 < minimum_hits:
            right += 1
            continue
        begin = int(hits[left])
        while right + 1 < len(hits):
            following = right + 1
            while (hits[following] - hits[left]) / fps > window_sec + 1e-9:
                left += 1
            if following - left + 1 < minimum_hits:
                break
            right = following
        groups.append((begin, min(len(raw), int(hits[right]) + stride)))
        right += 1
        left = right
    return groups


def assemble(intervals: list[tuple[int, int]], phases: list[dict], fps: float, length: int) -> list[dict]:
    """Authoritative rally boundaries come from activity, never phase flips."""
    result = []
    for start, end in intervals:
        local = []
        for p in phases:
            left, right = max(start, p["start_frame"] - 1), min(end, p["end_frame"])
            if left >= right or p["label"] == "other":
                continue
            item = dict(p)
            if left != p["start_frame"] - 1 or right != p["end_frame"]:
                item.pop("mean_score", None)
            item.update(start_frame=left + 1, end_frame=right, start_sec=left / fps,
                        end_sec=right / fps, duration_sec=(right - left) / fps)
            local.append(item)
        has_serve = any(p["label"] == "serve" for p in local)
        has_play = any(p["label"] == "play" for p in local)
        result.append({"rally_id": len(result) + 1, "start_sec": start / fps, "end_sec": end / fps,
                       "duration_sec": (end - start) / fps, "phases": local,
                       "has_serve": has_serve, "has_play": has_play,
                       "kind": "serve_and_play" if has_serve and has_play else "serve_only" if has_serve else "play_only",
                       "touches_video_start": start == 0, "touches_video_end": end == length})
    return result
