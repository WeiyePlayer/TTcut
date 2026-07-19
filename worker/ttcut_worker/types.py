from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

PointSource = Literal["tracknet", "missing"]
TimeSource = Literal["decoder", "fps_estimation"]


@dataclass(frozen=True)
class TrajectoryPoint:
    frame: int
    time: float
    visibility: int
    x: int
    y: int
    source: PointSource = "missing"
    confidence: float = 0.0
    time_source: TimeSource = "fps_estimation"

    def normalized(self, width: int, height: int) -> "TrajectoryPoint":
        if not self.visibility:
            return replace(self, visibility=0, x=0, y=0, source="missing", confidence=0.0)
        return replace(
            self,
            visibility=1,
            x=min(max(int(round(self.x)), 0), max(width - 1, 0)),
            y=min(max(int(round(self.y)), 0), max(height - 1, 0)),
            source="tracknet",
        )


@dataclass(frozen=True)
class RallySummary:
    start_frame: int
    end_frame: int
    start_time: float
    end_time: float
    bounce_count: int

