from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np

from .errors import CalibrationError

TABLE_LENGTH_CM = 274.0
TABLE_WIDTH_CM = 152.5
POINT_NAMES = ("top_left", "top_right", "bottom_right", "bottom_left")


def _point(value, name: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise CalibrationError(f"Calibration point {name} is invalid.")
    try:
        x, y = float(value[0]), float(value[1])
    except (TypeError, ValueError) as exc:
        raise CalibrationError(f"Calibration point {name} is invalid.") from exc
    if not math.isfinite(x) or not math.isfinite(y):
        raise CalibrationError(f"Calibration point {name} is not finite.")
    return x, y


@dataclass(frozen=True)
class TableCalibration:
    video_width: int
    video_height: int
    top_left: tuple[float, float]
    top_right: tuple[float, float]
    bottom_right: tuple[float, float]
    bottom_left: tuple[float, float]

    @classmethod
    def from_points(
        cls,
        width: int,
        height: int,
        points: Sequence[Sequence[float]] | Mapping[str, Sequence[float]],
    ) -> "TableCalibration":
        if isinstance(points, Mapping):
            missing = [name for name in POINT_NAMES if name not in points]
            if missing:
                raise CalibrationError(f"Calibration points missing: {', '.join(missing)}")
            ordered = [_point(points[name], name) for name in POINT_NAMES]
        else:
            if len(points) != 4:
                raise CalibrationError("Exactly four table points are required.")
            ordered = [_point(value, POINT_NAMES[index]) for index, value in enumerate(points)]
        result = cls(int(width), int(height), *ordered)
        result.validate()
        return result

    @property
    def points(self):
        return (self.top_left, self.top_right, self.bottom_right, self.bottom_left)

    def validate(self) -> None:
        import cv2

        if self.video_width <= 0 or self.video_height <= 0:
            raise CalibrationError("Calibration dimensions are invalid.")
        for name, (x, y) in zip(POINT_NAMES, self.points):
            if not 0 <= x < self.video_width or not 0 <= y < self.video_height:
                raise CalibrationError(f"Calibration point {name} is outside the frame.")
        minimum_distance = max(3.0, math.hypot(self.video_width, self.video_height) * 0.005)
        for first in range(4):
            for second in range(first + 1, 4):
                if math.dist(self.points[first], self.points[second]) < minimum_distance:
                    raise CalibrationError("Calibration points overlap.")
        polygon = np.asarray(self.points, dtype=np.float32)
        if not cv2.isContourConvex(np.round(polygon).astype(np.int32)):
            raise CalibrationError("Calibration points must form a convex quadrilateral.")
        if abs(float(cv2.contourArea(polygon))) < self.video_width * self.video_height * 0.001:
            raise CalibrationError("The calibrated table area is too small.")
        top_y = (self.top_left[1] + self.top_right[1]) / 2
        bottom_y = (self.bottom_left[1] + self.bottom_right[1]) / 2
        left_x = (self.top_left[0] + self.bottom_left[0]) / 2
        right_x = (self.top_right[0] + self.bottom_right[0]) / 2
        if top_y >= bottom_y or left_x >= right_x:
            raise CalibrationError("Point order must be top-left, top-right, bottom-right, bottom-left.")

    @property
    def homography(self):
        import cv2

        source = np.asarray(self.points, dtype=np.float32)
        target = np.asarray([
            [0.0, 0.0], [TABLE_LENGTH_CM, 0.0],
            [TABLE_LENGTH_CM, TABLE_WIDTH_CM], [0.0, TABLE_WIDTH_CM],
        ], dtype=np.float32)
        return cv2.getPerspectiveTransform(source, target)

    def image_to_table(self, x: float, y: float) -> tuple[float, float]:
        import cv2

        point = np.asarray([[[float(x), float(y)]]], dtype=np.float32)
        mapped = cv2.perspectiveTransform(point, self.homography)[0, 0]
        return float(mapped[0]), float(mapped[1])

