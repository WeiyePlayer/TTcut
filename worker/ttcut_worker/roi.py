from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .calibration import TABLE_LENGTH_CM, TABLE_WIDTH_CM, TableCalibration
from .errors import AnalysisRoiError


DEFAULT_HEIGHT_RATIO = 0.5
DEFAULT_LENGTH_MARGIN_CM = 35.0
DEFAULT_WIDTH_MARGIN_CM = 25.0
DEFAULT_LENGTH_MARGIN_RATIO = DEFAULT_LENGTH_MARGIN_CM / TABLE_LENGTH_CM
DEFAULT_WIDTH_MARGIN_RATIO = DEFAULT_WIDTH_MARGIN_CM / TABLE_WIDTH_CM
MODEL_STRIDE = 8
MODEL_REFERENCE_WIDTH = 512
MODEL_REFERENCE_HEIGHT = 288
DEFAULT_ROI_MODEL_SCALE = 1.25


@dataclass(frozen=True)
class AnalysisRoiConfig:
    height_ratio: float = DEFAULT_HEIGHT_RATIO
    length_margin_ratio: float = DEFAULT_LENGTH_MARGIN_RATIO
    width_margin_ratio: float = DEFAULT_WIDTH_MARGIN_RATIO

    def validate(self) -> None:
        values = (self.height_ratio, self.length_margin_ratio, self.width_margin_ratio)
        if not all(math.isfinite(float(value)) and float(value) >= 0 for value in values):
            raise AnalysisRoiError("Analysis ROI parameters must be finite and non-negative.")


@dataclass(frozen=True)
class AnalysisRoi:
    x0: int
    y0: int
    x1: int
    y1: int
    projected_polygon: tuple[tuple[float, float], ...]
    top_padding_pixels: float
    source_width: int
    source_height: int

    @property
    def bbox(self) -> tuple[int, int, int, int]:
        return self.x0, self.y0, self.x1, self.y1

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0


def model_dimensions(
    roi: AnalysisRoi | None,
    source_width: int,
    source_height: int,
) -> tuple[int, int]:
    if source_width <= 0 or source_height <= 0:
        raise AnalysisRoiError("Source video dimensions are invalid for ROI analysis.")
    if roi is None:
        return MODEL_REFERENCE_WIDTH, MODEL_REFERENCE_HEIGHT
    if roi.source_width != source_width or roi.source_height != source_height:
        raise AnalysisRoiError(
            "The analysis ROI dimensions do not match the decoded source video.",
        )
    if roi.width <= 0 or roi.height <= 0:
        raise AnalysisRoiError("The analysis ROI has no pixels.")

    def scaled_stride_size(raw_size: float) -> int:
        base_size = math.ceil(raw_size / MODEL_STRIDE) * MODEL_STRIDE
        scaled_size = base_size * DEFAULT_ROI_MODEL_SCALE
        nearest_integer = round(scaled_size)
        if math.isclose(scaled_size, nearest_integer, abs_tol=1e-9):
            scaled_size = nearest_integer
        return max(
            MODEL_STRIDE,
            math.ceil(scaled_size / MODEL_STRIDE) * MODEL_STRIDE,
        )

    width = max(
        MODEL_STRIDE,
        scaled_stride_size(roi.width * MODEL_REFERENCE_WIDTH / source_width),
    )
    height = max(
        MODEL_STRIDE,
        scaled_stride_size(roi.height * MODEL_REFERENCE_HEIGHT / source_height),
    )
    return int(width), int(height)


def dual_model_dimensions(
    roi: AnalysisRoi | None,
    source_width: int,
    source_height: int,
) -> tuple[tuple[int, int], tuple[int, int]]:
    if source_width <= 0 or source_height <= 0:
        raise AnalysisRoiError("Source video dimensions are invalid for dual-model analysis.")
    if roi is not None and (roi.source_width != source_width or roi.source_height != source_height):
        raise AnalysisRoiError("The analysis ROI dimensions do not match the decoded source video.")
    width = roi.width if roi is not None else source_width
    height = roi.height if roi is not None else source_height
    if width <= 0 or height <= 0:
        raise AnalysisRoiError("The dual-model analysis ROI has no pixels.")

    def aligned(value: float, stride: int) -> int:
        return max(32, math.ceil(value / stride) * stride)

    return (
        (aligned(width * 0.5, 4), aligned(height * 0.5, 4)),
        (aligned(width * 0.4, 8), aligned(height * 0.4, 8)),
    )


def _project_table_points(calibration: TableCalibration, points: np.ndarray) -> np.ndarray:
    projected = np.asarray([calibration.table_to_image(float(x), float(y)) for x, y in points], dtype=np.float64)
    if projected.shape != (4, 2) or not np.isfinite(projected).all():
        raise AnalysisRoiError("The table-space ROI could not be projected into the video frame.")
    return projected


def build_analysis_roi(
    calibration: TableCalibration,
    config: AnalysisRoiConfig | None = None,
) -> AnalysisRoi:
    config = config or AnalysisRoiConfig()
    config.validate()
    calibration.validate()

    length_margin = TABLE_LENGTH_CM * config.length_margin_ratio
    width_margin = TABLE_WIDTH_CM * config.width_margin_ratio
    expanded = np.asarray([
        [-length_margin, -width_margin],
        [TABLE_LENGTH_CM + length_margin, -width_margin],
        [TABLE_LENGTH_CM + length_margin, TABLE_WIDTH_CM + width_margin],
        [-length_margin, TABLE_WIDTH_CM + width_margin],
    ], dtype=np.float64)
    projected = _project_table_points(calibration, expanded)

    original_long_edges = _project_table_points(calibration, np.asarray([
        [0.0, 0.0],
        [TABLE_LENGTH_CM, 0.0],
        [TABLE_LENGTH_CM, TABLE_WIDTH_CM],
        [0.0, TABLE_WIDTH_CM],
    ], dtype=np.float64))
    long_edge_lengths = (
        float(np.linalg.norm(original_long_edges[1] - original_long_edges[0])),
        float(np.linalg.norm(original_long_edges[2] - original_long_edges[3])),
    )
    long_edge_pixels = max(long_edge_lengths)
    if not math.isfinite(long_edge_pixels) or long_edge_pixels <= 0:
        raise AnalysisRoiError("The projected table long edge is invalid.")
    top_padding = config.height_ratio * long_edge_pixels

    raw_x0 = math.floor(float(np.min(projected[:, 0])))
    raw_x1 = math.ceil(float(np.max(projected[:, 0])))
    raw_y0 = math.floor(float(np.min(projected[:, 1])) - top_padding)
    raw_y1 = math.ceil(float(np.max(projected[:, 1])))
    x0 = max(0, min(calibration.video_width, raw_x0))
    x1 = max(0, min(calibration.video_width, raw_x1))
    y0 = max(0, min(calibration.video_height, raw_y0))
    y1 = max(0, min(calibration.video_height, raw_y1))
    if x1 <= x0 or y1 <= y0:
        raise AnalysisRoiError("The projected analysis ROI is empty or degenerate.")
    return AnalysisRoi(
        x0,
        y0,
        x1,
        y1,
        tuple((float(x), float(y)) for x, y in projected),
        float(top_padding),
        calibration.video_width,
        calibration.video_height,
    )
