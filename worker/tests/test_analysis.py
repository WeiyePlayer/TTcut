from __future__ import annotations

from ttcut_worker.bounce import detect_bounce_frames
from ttcut_worker.calibration import TableCalibration
from ttcut_worker.rallies import group_rallies
from ttcut_worker.types import TrajectoryPoint
from ttcut_worker.worker import validate_request


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


def valid_request():
    return {
        "schema_version": 1,
        "task_id": "22222222-2222-4222-8222-222222222222",
        "video_path": "match.mp4",
        "device": "cpu",
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
    request["calibration"]["points"]["center"] = [640, 360]
    try:
        validate_request(request)
    except Exception as exc:
        assert "fields" in str(exc).lower()
    else:
        raise AssertionError("unknown calibration point fields must fail")
