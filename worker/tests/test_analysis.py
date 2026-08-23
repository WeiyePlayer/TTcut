from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np

from ttcut_worker import calibration_worker
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.rallies import group_rallies
from ttcut_worker.table_analyze import _order_corners, _select_coherent_corner_pair
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.video import VideoInfo
from ttcut_worker.worker import analyze, validate_request


def calibration() -> TableCalibration:
    return TableCalibration.from_points(274, 153, [[0, 0], [273, 0], [273, 152], [0, 152]])


def point(frame: int, time: float) -> TrajectoryPoint:
    return TrajectoryPoint(frame, time, 1, 100, 20, "blurball", 1.0)


def valid_request() -> dict:
    return {
        "schema_version": 1,
        "task_id": "22222222-2222-4222-8222-222222222222",
        "video_path": "match.mp4",
        "device": "cpu",
        "video_metadata": {
            "duration_seconds": 10.0,
            "fps": 30.0,
            "frame_count": 300,
            "variable_frame_rate": False,
        },
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


def test_rally_gap_is_inclusive_and_singletons_are_ignored():
    points = [point(0, 0.0), point(1, 3.0), point(2, 6.001), point(3, 10.0), point(4, 12.0)]
    rallies = group_rallies([0, 1, 2, 3, 4], points)
    assert [(item.start_time, item.end_time, item.bounce_count) for item in rallies] == [
        (0.0, 3.0, 2),
        (10.0, 12.0, 2),
    ]


def test_automatic_corners_are_ordered_by_image_geometry():
    fixed_points = np.zeros((13, 3), dtype=np.float64)
    fixed_points[0, :2] = [277.9, 300.0]
    fixed_points[1, :2] = [829.9, 425.4]
    fixed_points[4, :2] = [468.3, 391.6]
    fixed_points[5, :2] = [695.5, 312.9]
    assert _order_corners(fixed_points) == {
        "top_left": [277.9, 300.0], "top_right": [695.5, 312.9],
        "bottom_right": [829.9, 425.4], "bottom_left": [468.3, 391.6],
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
        return {"label": label, "points": points, "valid": np.ones(13, dtype=bool)}

    assert _select_coherent_corner_pair(
        [prediction("first", 0), prediction("25_percent", 4), prediction("50_percent", 0, valid=False)],
        640,
        360,
    ) == (0, 1)


def test_worker_request_rejects_unknown_fields_and_retired_profile():
    request = valid_request()
    request["ball_model_profile"] = "tracknet_v1"
    try:
        validate_request(request)
    except Exception as exc:
        assert "schema" in str(exc).lower()
    else:
        raise AssertionError("a retired model profile must be rejected")


def test_worker_request_accepts_mov_and_precalibrated_diagnostics():
    request = valid_request()
    request["video_path"] = "IMG_0070.MOV"
    request["calibration_choice"] = {
        "method": "precalibrated",
        "calibration": valid_request()["calibration_choice"]["calibration"],
        "table_analysis": {"schema_version": 1, "diagnostic": "preserved"},
    }
    assert validate_request(request) is request


def test_calibration_worker_runs_table_model(monkeypatch):
    request = valid_request()
    request["calibration_choice"] = {"method": "automatic"}
    progress = []

    def fake_analyze_table(video_path, weight_path, device, metadata, callback):
        callback("table_sampling", 5, 5)
        progress.append((video_path, weight_path, device, metadata))
        return calibration(), {"schema_version": 1, "diagnostic": "five-frame"}

    monkeypatch.setenv("TTCUT_TABLE_ANALYZE_WEIGHTS", "table.pt")
    monkeypatch.setattr(calibration_worker, "analyze_table", fake_analyze_table)
    result = calibration_worker.calibrate(request)
    assert progress == [(request["video_path"], "table.pt", "cpu", request["video_metadata"])]
    assert result["calibration"]["video_width"] == 274


def test_worker_always_uses_blurball_and_records_fixed_parameters(monkeypatch):
    captured = {}

    class FakeBlurBallPredictor:
        def __init__(self, loaded):
            captured["loaded"] = loaded

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            captured["roi"] = analysis_roi
            points = [TrajectoryPoint(i, i * 0.1, 1, 640, 360, "blurball", 1.0) for i in range(6)]
            return points, VideoInfo(Path(video_path), 1280, 720, 10.0, 6, 6, 0.6), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=0.7,
                step=3, maximum_displacement_pixels=100.0,
            )

    fake_loaded = SimpleNamespace(component_version="1.0.0")
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", "blurball.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_blurball", lambda path, device: captured.update(weight_path=path, device=device) or fake_loaded)
    monkeypatch.setattr("ttcut_worker.worker.BlurBallPredictor", FakeBlurBallPredictor)
    monkeypatch.setattr("ttcut_worker.worker.detect_blurball_bounce_frames", lambda points, calibration: [0, 5])

    result = analyze(valid_request())
    assert captured["loaded"] is fake_loaded
    assert captured["weight_path"] == "blurball.pt"
    assert captured["device"] == "cpu"
    assert captured["roi"].source_width == 1280
    assert result["rallies"][0]["bounce_count"] == 2
    assert result["bounce_times_seconds"] == [0.0, 0.5]
    assert result["model_provenance"]["profile"] == "blurball_v1"
    assert result["model_provenance"]["detection"] == {
        "confidence_threshold": 0.7, "step": 3,
        "maximum_displacement_pixels": 100.0, "landing_region": "expanded_table",
    }
