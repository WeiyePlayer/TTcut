from __future__ import annotations

import numpy as np
from pathlib import Path

from ttcut_worker.bounce import detect_bounce_frames
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.predictor import PredictionStats
from ttcut_worker.table_analyze import _order_corners, _select_coherent_corner_pair
from ttcut_worker.rallies import group_rallies
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.video import VideoInfo
from ttcut_worker.worker import analyze, validate_request


def calibration() -> TableCalibration:
    return TableCalibration.from_points(
        274,
        153,
        [[0, 0], [273, 0], [273, 152], [0, 152]],
    )


def point(frame: int, time: float, x: int, y: int, visible: int = 1) -> TrajectoryPoint:
    return TrajectoryPoint(
        frame=frame,
        time=time,
        visibility=visible,
        x=x if visible else 0,
        y=y if visible else 0,
        source="tracknet" if visible else "missing",
    )


def test_three_frame_v_bounce_and_minimum_interval():
    points = [
        point(0, 0.00, 100, 20),
        point(1, 0.05, 101, 40),
        point(2, 0.10, 102, 20),
        point(3, 0.15, 103, 42),
        point(4, 0.20, 104, 20),
    ]
    assert detect_bounce_frames(points, calibration()) == [1]


def test_five_frame_window_tolerates_missing_middle_points():
    points = [
        point(0, 0.0, 100, 10),
        point(1, 0.1, 0, 0, 0),
        point(2, 0.2, 105, 50),
        point(3, 0.3, 0, 0, 0),
        point(4, 0.4, 110, 12),
    ]
    assert detect_bounce_frames(points, calibration()) == [2]


def test_rally_gap_is_inclusive_and_singletons_are_ignored():
    points = [
        point(0, 0.0, 100, 20),
        point(1, 3.0, 100, 20),
        point(2, 6.001, 100, 20),
        point(3, 10.0, 100, 20),
        point(4, 12.0, 100, 20),
    ]
    rallies = group_rallies([0, 1, 2, 3, 4], points)
    assert [(item.start_time, item.end_time, item.bounce_count) for item in rallies] == [
        (0.0, 3.0, 2),
        (10.0, 12.0, 2),
    ]


def test_calibration_rejects_wrong_point_order():
    try:
        TableCalibration.from_points(274, 153, [[273, 0], [0, 0], [0, 152], [273, 152]])
    except Exception as exc:
        assert "order" in str(exc).lower() or "convex" in str(exc).lower()
    else:
        raise AssertionError("invalid point order must fail")


def test_automatic_corners_are_ordered_by_image_geometry():
    fixed_points = np.zeros((13, 3), dtype=np.float64)
    fixed_points[0, :2] = [277.9, 300.0]
    fixed_points[1, :2] = [829.9, 425.4]
    fixed_points[4, :2] = [468.3, 391.6]
    fixed_points[5, :2] = [695.5, 312.9]

    assert _order_corners(fixed_points) == {
        "top_left": [277.9, 300.0],
        "top_right": [695.5, 312.9],
        "bottom_right": [829.9, 425.4],
        "bottom_left": [468.3, 391.6],
    }


def test_automatic_calibration_selects_two_coherent_samples():
    def prediction(label, offset, valid=True):
        points = np.zeros((13, 2), dtype=np.float64)
        points[0] = [100 + offset, 100]
        points[1] = [300 + offset, 300]
        points[4] = [100 + offset, 300]
        points[5] = [300 + offset, 100]
        if not valid:
            points[5] = points[0]
        return {
            "label": label,
            "points": points,
            "valid": np.ones(13, dtype=bool),
        }

    predictions = [
        prediction("first", 0),
        prediction("25_percent", 4),
        prediction("50_percent", 0, valid=False),
    ]
    assert _select_coherent_corner_pair(predictions, 640, 360) == (0, 1)


def valid_request():
    return {
        "schema_version": 1,
        "task_id": "22222222-2222-4222-8222-222222222222",
        "video_path": "match.mp4",
        "device": "cpu",
        "calibration_choice": {
            "method": "manual",
            "calibration": {
                "video_width": 1280,
                "video_height": 720,
                "points": {
                    "top_left": [695, 303],
                    "top_right": [934, 315],
                    "bottom_right": [831, 413],
                    "bottom_left": [466, 381],
                },
            },
        },
    }


def test_worker_request_rejects_unknown_fields():
    request = valid_request()
    request["unexpected"] = True
    try:
        validate_request(request)
    except Exception as exc:
        assert "schema" in str(exc).lower()
    else:
        raise AssertionError("unknown request fields must fail")


def test_worker_request_rejects_unknown_calibration_points():
    request = valid_request()
    request["calibration_choice"]["calibration"]["points"]["center"] = [640, 360]
    try:
        validate_request(request)
    except Exception as exc:
        assert "fields" in str(exc).lower()
    else:
        raise AssertionError("unknown calibration point fields must fail")


def test_worker_request_accepts_automatic_calibration_without_points():
    request = valid_request()
    request["calibration_choice"] = {"method": "automatic"}
    assert validate_request(request) == request


def test_worker_analysis_passes_a_validated_roi_to_tracknet(monkeypatch):
    captured = {}

    class FakePredictor:
        def __init__(self, loaded):
            captured["loaded"] = loaded

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            captured["video_path"] = video_path
            captured["roi"] = analysis_roi
            return (
                [],
                VideoInfo(
                    path=Path(video_path),
                    width=1280,
                    height=720,
                    fps=30.0,
                    metadata_frame_count=1,
                    decoded_frame_count=1,
                    duration=1 / 30,
                ),
                PredictionStats(0, 1, 0.01, 100.0, 256, 144, 0.25),
            )

    monkeypatch.setenv("TTCUT_TRACKNET_WEIGHTS", "fake-tracknet.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_tracknet", lambda path, device: object())
    monkeypatch.setattr("ttcut_worker.worker.TrackNetPredictor", FakePredictor)

    result = analyze(valid_request())

    assert result["schema_version"] == 1
    assert captured["roi"].bbox[2] > captured["roi"].bbox[0]
    assert captured["roi"].bbox[3] > captured["roi"].bbox[1]
