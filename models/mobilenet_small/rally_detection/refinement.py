"""Use Huji-style window evidence to refine, rather than replace, phase cores.

Retain PLAY->SERVE resets from the temporal decoder. Bridge only short gaps
whose surrounding phases and activity scores support a single rally. Boundaries
grow to observed activity, never by unconditional editing padding.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from .calibration import mean_window
from .scores import Scores


@dataclass(frozen=True)
class RefinementConfig:
    raw_activity_weight: float = .5
    evidence_threshold: float = .5
    evidence_window_sec: float = .4
    evidence_fraction: float = .5
    max_growth_sec: float = 1.
    max_bridge_sec: float = .5

    def to_dict(self):
        return asdict(self)

    def validate(self):
        for name in ("raw_activity_weight", "evidence_threshold", "evidence_fraction"):
            if not np.isfinite(getattr(self, name)) or not 0 <= getattr(self, name) <= 1:
                raise ValueError(f"{name} must be finite and in [0, 1]")
        for name in ("evidence_window_sec", "max_growth_sec", "max_bridge_sec"):
            if not np.isfinite(getattr(self, name)) or getattr(self, name) < 0:
                raise ValueError(f"{name} must be finite and nonnegative")


def core_intervals(labels: np.ndarray) -> list[tuple[int, int]]:
    """OTHER and a new serve after PLAY separate initial rallies."""
    if not len(labels):
        return []
    boundaries = np.r_[0, np.flatnonzero(labels[1:] != labels[:-1]) + 1, len(labels)]
    result = []
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        if labels[start] == 2:
            continue
        if result and result[-1][1] == start and labels[start] == 1:
            result[-1] = (result[-1][0], int(end))
        else:
            result.append((int(start), int(end)))
    return result


def refine(labels: np.ndarray, raw: np.ndarray, calibrated: np.ndarray, fps: float,
           config: RefinementConfig) -> tuple[np.ndarray, list[tuple[int, int]]]:
    config.validate()
    raw = Scores(raw, fps, {}).values
    calibrated = Scores(calibrated, fps, {}).values
    labels = np.asarray(labels)
    if labels.shape != (len(raw),) or calibrated.shape != raw.shape or not np.isin(labels, [0, 1, 2]).all():
        raise ValueError("Labels and scores must share a three-class timeline")
    output = labels.copy()
    cores = core_intervals(labels)
    if not cores:
        return output, []
    active = (config.raw_activity_weight * raw[:, :2].sum(axis=1)
              + (1 - config.raw_activity_weight) * calibrated[:, :2].sum(axis=1))
    radius = max(0, round(config.evidence_window_sec * fps / 2))
    density = mean_window((active >= config.evidence_threshold)[:, None].astype(float), radius, radius)[:, 0]
    supported = density >= config.evidence_fraction
    # A centered window can reach across a genuine pause. Strong smoothed OTHER
    # evidence is a barrier even if active samples dominate the wider window.
    local_active = mean_window(active[:, None], max(0, round(.1 * fps)), max(0, round(.1 * fps)))[:, 0]
    supported &= local_active >= config.evidence_threshold
    merged = [cores[0]]
    for start, end in cores[1:]:
        previous_start, previous_end = merged[-1]
        gap = start - previous_end
        compatible = labels[previous_end - 1] == 0 and labels[start] == 1
        if (0 < gap <= config.max_bridge_sec * fps + 1e-9 and compatible
                and supported[previous_end:start].all()):
            # Assign the uncertain gap to the nearer endpoint's observed phase.
            midpoint = (previous_end + start) // 2
            output[previous_end:midpoint] = labels[previous_end - 1]
            output[midpoint:start] = labels[start]
            merged[-1] = (previous_start, end)
        else:
            merged.append((start, end))
    growth = round(config.max_growth_sec * fps)
    result = []
    for index, (start, end) in enumerate(merged):
        # Mid-gap limits keep separate rallies separate and prevent overlap.
        left_limit = max(0, start - growth)
        right_limit = min(len(labels), end + growth)
        if index:
            left_limit = max(left_limit, (merged[index - 1][1] + start + 1) // 2)
        if index + 1 < len(merged):
            right_limit = min(right_limit, (end + merged[index + 1][0] + 1) // 2)
        begin, finish = start, end
        while begin > left_limit and supported[begin - 1]:
            begin -= 1
        while finish < right_limit and supported[finish]:
            finish += 1
        output[begin:start] = labels[start]
        output[end:finish] = labels[end - 1]
        result.append((begin, finish))
    return output, result
