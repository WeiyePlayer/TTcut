from __future__ import annotations

import math
from typing import Iterable

import numpy as np


def heatmap_candidates(heatmap: np.ndarray, threshold: float, max_candidates: int = 3) -> list[dict]:
    import cv2

    binary = (np.asarray(heatmap, dtype=np.float32) >= threshold).astype(np.uint8) * 255
    if not np.any(binary):
        return []
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[dict] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        region = heatmap[y:y + height, x:x + width]
        candidates.append({
            "x": x, "y": y, "w": width, "h": height,
            "cx": x + width / 2.0, "cy": y + height / 2.0,
            "area": float(width * height),
            "confidence": float(np.max(region)) if region.size else 0.0,
        })
    candidates.sort(key=lambda item: (item["confidence"], item["area"]), reverse=True)
    return candidates[:max_candidates]


def select_best_candidate(
    candidates: Iterable[dict], history: list[tuple[float, float, int]],
    *, frame_width: int, frame_height: int, miss_count: int = 0,
) -> dict | None:
    candidates = [c for c in candidates if 0 <= c["cx"] < frame_width and 0 <= c["cy"] < frame_height]
    if not candidates:
        return None
    visible = [(x, y) for x, y, found in history if found]
    if not visible:
        return max(candidates, key=lambda item: (item["confidence"], item["area"]))
    last_x, last_y = visible[-1]
    if len(visible) >= 2:
        prior_x, prior_y = visible[-2]
        predicted_x, predicted_y = last_x * 2 - prior_x, last_y * 2 - prior_y
    else:
        predicted_x, predicted_y = last_x, last_y
    diagonal = math.hypot(frame_width, frame_height)
    maximum_gap = diagonal * (0.14 if miss_count == 0 else min(0.45, 0.14 + miss_count * 0.06))
    viable = []
    for item in candidates:
        last_distance = math.hypot(item["cx"] - last_x, item["cy"] - last_y)
        if last_distance > maximum_gap:
            continue
        predicted_distance = math.hypot(item["cx"] - predicted_x, item["cy"] - predicted_y)
        viable.append((predicted_distance, last_distance, -item["confidence"], -item["area"], item))
    return min(viable, key=lambda item: item[:4])[-1] if viable else None

