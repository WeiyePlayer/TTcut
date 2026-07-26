from __future__ import annotations

import math

import pytest

from ttcut_worker.calibration import TableCalibration
from ttcut_worker.errors import AnalysisRoiError
from ttcut_worker.roi import (
    DEFAULT_HEIGHT_RATIO,
    DEFAULT_LENGTH_MARGIN_RATIO,
    DEFAULT_WIDTH_MARGIN_RATIO,
    AnalysisRoiConfig,
    AnalysisRoi,
    build_analysis_roi,
    model_dimensions,
)


def calibration() -> TableCalibration:
    return TableCalibration.from_points(
        2000,
        1000,
        [[500, 300], [1500, 300], [1500, 700], [500, 700]],
    )


def test_default_roi_config_uses_requested_table_proportions():
    assert DEFAULT_HEIGHT_RATIO == 0.5
    assert DEFAULT_LENGTH_MARGIN_RATIO == pytest.approx(35.0 / 274.0)
    assert DEFAULT_WIDTH_MARGIN_RATIO == pytest.approx(25.0 / 152.5)


def test_analysis_roi_is_the_outer_bbox_and_extends_above_the_table():
    roi = build_analysis_roi(
        calibration(),
        AnalysisRoiConfig(
            height_ratio=0.1,
            length_margin_ratio=0.0,
            width_margin_ratio=0.0,
        ),
    )

    # The table itself is [500, 300]..[1500, 700]. The two long projected
    # edges are 1000 px, so the 0.1 height ratio moves the top to y=200.
    assert roi.bbox == (500, 200, 1500, 700)
    assert roi.width == 1000
    assert roi.height == 500
    assert roi.top_padding_pixels == pytest.approx(100.0)
    assert len(roi.projected_polygon) == 4


def test_analysis_roi_clips_an_expanded_projection_to_source_frame():
    roi = build_analysis_roi(
        calibration(),
        AnalysisRoiConfig(
            height_ratio=0.0,
            length_margin_ratio=0.5,
            width_margin_ratio=0.5,
        ),
    )

    assert roi.bbox == (0, 100, 2000, 900)
    assert roi.width == 2000
    assert roi.height == 800


def test_analysis_roi_uses_longer_projected_edge_under_perspective():
    perspective = TableCalibration.from_points(
        1000,
        600,
        [[400, 200], [650, 220], [750, 500], [250, 450]],
    )

    roi = build_analysis_roi(
        perspective,
        AnalysisRoiConfig(
            height_ratio=0.2,
            length_margin_ratio=0.0,
            width_margin_ratio=0.0,
        ),
    )

    # The bottom projected length edge is longer than the top edge, so the
    # upper bound is floor(200 - hypot(500, 50) * 0.2) = 99.
    assert roi.bbox == (250, 99, 750, 500)


def test_analysis_roi_rejects_invalid_parameters_with_structured_error():
    with pytest.raises(AnalysisRoiError) as error:
        build_analysis_roi(
            calibration(),
            AnalysisRoiConfig(
                height_ratio=-0.1,
                length_margin_ratio=0.0,
                width_margin_ratio=0.0,
            ),
        )

    assert error.value.code == "ANALYSIS_ROI_FAILED"
    assert error.value.recoverable is False


def test_model_dimensions_rejects_degenerate_roi_with_structured_error():
    roi = AnalysisRoi(
        x0=10,
        y0=10,
        x1=10,
        y1=20,
        projected_polygon=((10.0, 10.0),) * 4,
        top_padding_pixels=0.0,
        source_width=100,
        source_height=80,
    )

    with pytest.raises(AnalysisRoiError) as error:
        model_dimensions(roi, 100, 80)

    assert error.value.code == "ANALYSIS_ROI_FAILED"
    assert error.value.recoverable is False


def test_analysis_roi_rejects_non_finite_projection():
    with pytest.raises(AnalysisRoiError):
        build_analysis_roi(
            calibration(),
            AnalysisRoiConfig(
                height_ratio=math.inf,
                length_margin_ratio=0.0,
                width_margin_ratio=0.0,
            ),
        )
