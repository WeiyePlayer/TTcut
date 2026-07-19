from __future__ import annotations

import math
from dataclasses import dataclass

from .errors import TimestampError
from .types import TimeSource


@dataclass(frozen=True)
class ResolvedTimestamp:
    seconds: float
    source: TimeSource


def valid_fps(value: float | int | None) -> bool:
    try:
        fps = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(fps) and fps > 1e-6


class TimestampResolver:
    def __init__(self, fps: float | int | None):
        self.fps = float(fps) if valid_fps(fps) else None
        self.previous: float | None = None

    def resolve(self, frame_index: int, decoder_msec: float | int | None) -> ResolvedTimestamp:
        decoder_seconds = self._decoder_seconds(decoder_msec)
        if decoder_seconds is not None and (
            self.previous is None or decoder_seconds > self.previous + 1e-9
        ):
            resolved = ResolvedTimestamp(decoder_seconds, "decoder")
        elif self.fps is not None:
            estimate = frame_index / self.fps
            if self.previous is not None and estimate <= self.previous:
                estimate = self.previous + 1.0 / self.fps
            resolved = ResolvedTimestamp(estimate, "fps_estimation")
        else:
            raise TimestampError("No reliable decoder timestamp or FPS is available.")
        if self.previous is not None and resolved.seconds < self.previous:
            raise TimestampError("Frame timestamps moved backwards.")
        self.previous = resolved.seconds
        return resolved

    @staticmethod
    def _decoder_seconds(decoder_msec: float | int | None) -> float | None:
        try:
            value = float(decoder_msec) / 1000.0
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) and value >= 0 else None

