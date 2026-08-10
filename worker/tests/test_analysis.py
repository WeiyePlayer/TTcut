from __future__ import annotations

import numpy as np
from pathlib import Path
from types import SimpleNamespace

from ttcut_worker.bounce import detect_bounce_frames
from ttcut_worker.calibration import TableCalibration
from ttcut_worker import calibration_worker
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


def test_three_frame_v_bounce_and_default_minimum_interval():
    points = [
        point(0, 0.00, 100, 20),
        point(1, 0.05, 101, 40),
        point(2, 0.10, 102, 20),
        point(3, 0.15, 103, 42),
        point(4, 0.20, 104, 20),
    ]
    assert detect_bounce_frames(points, calibration()) == [1]


def test_minimum_interval_compares_with_the_last_counted_bounce():
    points = [
        point(0, 0.0, 100, 20),
        point(1, 0.1, 101, 40),
        point(2, 0.2, 102, 20),
        point(3, 0.3, 103, 42),
        point(4, 0.4, 104, 20),
        point(5, 0.5, 105, 44),
        point(6, 0.6, 106, 20),
    ]

    assert detect_bounce_frames(points, calibration()) == [1, 5]
    assert detect_bounce_frames(
        points, calibration(), minimum_interval_seconds=0.12,
    ) == [1, 3, 5]


def test_minimum_interval_is_strictly_less_than_0_315_seconds():
    exact_boundary = [
        point(0, 0.00, 100, 20),
        point(1, 0.05, 101, 40),
        point(2, 0.10, 102, 20),
        point(3, 0.365, 103, 42),
        point(4, 0.40, 104, 20),
    ]
    below_boundary = [
        point(0, 0.00, 100, 20),
        point(1, 0.05, 101, 40),
        point(2, 0.10, 102, 20),
        point(3, 0.364999, 103, 42),
        point(4, 0.40, 104, 20),
    ]

    assert detect_bounce_frames(exact_boundary, calibration()) == [1, 3]
    assert detect_bounce_frames(below_boundary, calibration()) == [1]


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
        "schema_version": 2,
        "task_id": "22222222-2222-4222-8222-222222222222",
        "video_path": "match.mp4",
        "device": "cpu",
        "ball_model_profile": "tracknet_v1",
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


def test_worker_request_rejects_unknown_fields():
    request = valid_request()
    request["unexpected"] = True
    try:
        validate_request(request)
    except Exception as exc:
        assert "schema" in str(exc).lower()
    else:
        raise AssertionError("unknown request fields must fail")


def test_worker_request_accepts_mov_video_path():
    request = valid_request()
    request["video_path"] = "IMG_0070.MOV"
    assert validate_request(request) is request


def test_worker_request_v2_accepts_tracknet_and_blurball_only():
    request = valid_request()
    request.update(schema_version=2, device="cpu", ball_model_profile="blurball_v1")
    assert validate_request(request) is request
    request["device"] = "auto"
    assert validate_request(request) is request
    request["ball_model_profile"] = "tracknet_v1"
    assert validate_request(request) is request
    request["ball_model_profile"] = "uplifting_dual_v1"
    try:
        validate_request(request)
    except Exception as exc:
        assert "fields" in str(exc).lower()
    else:
        raise AssertionError("removed model profiles must be rejected")


def test_worker_request_rejects_unrelated_video_container():
    request = valid_request()
    request["video_path"] = "match.avi"
    try:
        validate_request(request)
    except Exception as exc:
        assert "fields" in str(exc).lower()
    else:
        raise AssertionError("unsupported video container must fail")


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


def test_worker_request_accepts_precalibrated_table_diagnostics():
    request = valid_request()
    request["calibration_choice"] = {
        "method": "precalibrated",
        "calibration": valid_request()["calibration_choice"]["calibration"],
        "table_analysis": {"schema_version": 1, "diagnostic": "preserved"},
    }
    assert validate_request(request) == request


def test_calibration_worker_runs_table_model_without_tracknet(monkeypatch):
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

    assert progress == [(
        request["video_path"],
        "table.pt",
        "cpu",
        request["video_metadata"],
    )]
    assert result["calibration"]["video_width"] == 274
    assert result["calibration"]["points"]["bottom_right"] == [273.0, 152.0]
    assert result["table_analysis"]["diagnostic"] == "five-frame"


def test_worker_request_rejects_invalid_video_metadata():
    request = valid_request()
    request["video_metadata"]["duration_seconds"] = 0
    try:
        validate_request(request)
    except Exception as exc:
        assert "fields" in str(exc).lower()
    else:
        raise AssertionError("invalid video metadata must fail")


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


def test_worker_analysis_reuses_precalibrated_diagnostics_without_table_model(monkeypatch):
    request = valid_request()
    request["calibration_choice"] = {
        "method": "precalibrated",
        "calibration": request["calibration_choice"]["calibration"],
        "table_analysis": {"schema_version": 1, "diagnostic": "preserved"},
    }
    captured = {}

    class FakePredictor:
        def __init__(self, loaded):
            captured["loaded"] = loaded

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
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
    monkeypatch.delenv("TTCUT_TABLE_ANALYZE_WEIGHTS", raising=False)
    monkeypatch.setattr("ttcut_worker.worker.load_tracknet", lambda path, device: object())
    monkeypatch.setattr("ttcut_worker.worker.TrackNetPredictor", FakePredictor)

    result = analyze(request)

    assert result["table_analysis"] == request["calibration_choice"]["table_analysis"]
    assert captured["loaded"] is not None


def test_worker_v2_routes_blurball_profile_and_records_fixed_parameters(monkeypatch):
    request = valid_request()
    request.update(schema_version=2, device="cpu", ball_model_profile="blurball_v1")
    captured = {}

    class FakeBlurBallPredictor:
        def __init__(self, loaded):
            captured["loaded"] = loaded

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            captured["roi"] = analysis_roi
            points = [
                TrajectoryPoint(i, i * 0.1, 1, 640, 360, "blurball", 1.0)
                for i in range(6)
            ]
            return points, VideoInfo(Path(video_path), 1280, 720, 10.0, 6, 6, 0.6), SimpleNamespace(
                model_width=512,
                model_height=288,
                confidence_threshold=0.7,
                step=3,
                maximum_displacement_pixels=100.0,
            )

    fake_loaded = SimpleNamespace(component_version="1.0.0")
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", "blurball.pt")
    def fake_load_blurball(path, device):
        captured["weight_path"] = path
        captured["device"] = device
        return fake_loaded

    monkeypatch.setattr("ttcut_worker.worker.load_blurball", fake_load_blurball)
    monkeypatch.setattr("ttcut_worker.worker.BlurBallPredictor", FakeBlurBallPredictor)
    monkeypatch.setattr("ttcut_worker.worker.detect_blurball_bounce_frames", lambda points, calibration: [0, 5])

    result = analyze(request)

    assert captured["loaded"] is fake_loaded
    assert captured["weight_path"] == "blurball.pt"
    assert captured["device"] == "cpu"
    assert captured["roi"].source_width == 1280
    assert result["rallies"][0]["bounce_count"] == 2
    assert result["model_provenance"]["profile"] == "blurball_v1"
    assert result["model_provenance"]["main_input"] == {"width": 512, "height": 288}
    assert result["model_provenance"]["aux_input"] is None
    assert result["model_provenance"]["detection"] == {
        "confidence_threshold": 0.7,
        "step": 3,
        "maximum_displacement_pixels": 100.0,
        "landing_region": "expanded_table",
    }
