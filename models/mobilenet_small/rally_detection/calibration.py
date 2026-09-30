"""Small supervised temporal calibration of the frozen student's score streams.

This operates exclusively on scores, not images. Site-balanced regularized
multinomial logistic regression relates Huji semantics to interval semantics.
Centered, past and future means give it short temporal context for offline use.
"""

from __future__ import annotations

import numpy as np


WINDOWS_SEC = (0.2, 0.5, 1., 2., 4.)


def mean_window(values, left: int, right: int):
    n = len(values)
    prefix = np.vstack([np.zeros((1, values.shape[1])), np.cumsum(values, axis=0)])
    starts = np.maximum(0, np.arange(n) - left)
    ends = np.minimum(n, np.arange(n) + right + 1)
    return (prefix[ends] - prefix[starts]) / (ends - starts)[:, None]


def features(values: np.ndarray, fps: float) -> np.ndarray:
    blocks = [values, np.log(np.maximum(values, 1e-5))]
    for seconds in WINDOWS_SEC:
        half = max(1, round(seconds * fps / 2))
        radius = max(1, round(seconds * fps))
        blocks.extend([mean_window(values, half, half), mean_window(values, radius, 0),
                       mean_window(values, 0, radius)])
    return np.column_stack(blocks).astype(np.float32)


def fit(sequences: list[dict], regularization: float = 0.03) -> dict:
    import torch
    torch.set_num_threads(4)
    xs, ys, sites = [], [], []
    site_names = sorted({s["site"] for s in sequences})
    for sequence in sequences:
        truth = sequence["truth"]
        # 10 Hz is sufficient for fitting; annotation boundaries stay at 30 Hz
        # for final inference and evaluation.
        indices = np.arange(0, len(truth), max(1, round(sequence["fps"] / 10)))
        indices = indices[truth[indices] >= 0]
        xs.append(features(sequence["scores"], sequence["fps"])[indices])
        ys.append(truth[indices])
        sites.extend([site_names.index(sequence["site"])] * len(indices))
    x, y, site = np.concatenate(xs), np.concatenate(ys), np.array(sites)
    if set(y.tolist()) != {0, 1, 2}:
        raise ValueError("Calibration needs reviewed examples of all three phases")
    weight = 1 / np.bincount(site)[site]
    weight /= weight.sum()
    mean = np.sum(x * weight[:, None], axis=0)
    scale = np.maximum(np.sqrt(np.sum((x - mean) ** 2 * weight[:, None], axis=0)), 0.03)
    x = torch.tensor((x - mean) / scale, dtype=torch.float64)
    target = torch.tensor(y, dtype=torch.long)
    sample_weight = torch.tensor(weight, dtype=torch.float64)
    coefficients = torch.zeros((x.shape[1], 3), dtype=torch.float64, requires_grad=True)
    bias = torch.zeros(3, dtype=torch.float64, requires_grad=True)
    optimizer = torch.optim.LBFGS([coefficients, bias], max_iter=100,
                                tolerance_grad=1e-7, line_search_fn="strong_wolfe")

    def closure():
        optimizer.zero_grad()
        losses = torch.nn.functional.cross_entropy(x @ coefficients + bias, target, reduction="none")
        loss = (losses * sample_weight).sum() + regularization * coefficients.square().sum() / 2
        loss.backward()
        return loss

    optimizer.step(closure)
    return {"type": "multiscale_logistic_v1", "windows_sec": list(WINDOWS_SEC),
            "regularization": regularization, "mean": mean.tolist(), "scale": scale.tolist(),
            "coefficients": coefficients.detach().numpy().tolist(), "bias": bias.detach().numpy().tolist(),
            "fit_sites": site_names, "fit_frames": len(y)}


def predict(values: np.ndarray, fps: float, model: dict | None) -> np.ndarray:
    if model is None:
        return values.copy()
    if model["type"] != "multiscale_logistic_v1" or model["windows_sec"] != list(WINDOWS_SEC):
        raise ValueError("Unsupported temporal calibration model")
    x = (features(values, fps) - model["mean"]) / model["scale"]
    logits = x @ np.asarray(model["coefficients"]) + model["bias"]
    logits -= logits.max(axis=1, keepdims=True)
    probabilities = np.exp(logits)
    return probabilities / probabilities.sum(axis=1, keepdims=True)


def combine_activity(raw: np.ndarray, calibrated: np.ndarray, fps: float,
                     raw_activity_weight: float = 0.) -> np.ndarray:
    """Separate being in a rally from the much less stable serve/play decision.

    Raw serve+play preserves evidence when the two active classes are confused.
    Only the active probability is blended; phase proportions stay calibrated.
    """
    if not 0 <= raw_activity_weight <= 1:
        raise ValueError("raw_activity_weight must be in [0, 1]")
    radius = max(1, round(.15 * fps))
    raw_active = mean_window(raw[:, :2].sum(axis=1, keepdims=True), radius, radius)[:, 0]
    calibrated_active = calibrated[:, :2].sum(axis=1)
    active = raw_activity_weight * raw_active + (1 - raw_activity_weight) * calibrated_active
    phase = calibrated[:, :2] / np.maximum(calibrated_active[:, None], 1e-7)
    return np.column_stack([active[:, None] * phase, 1 - active])
