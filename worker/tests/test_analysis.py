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
from ttcut_worker.visibility_rallies import VisibilityRallySummary
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


def local_tracknet_request() -> dict:
    request = valid_request()
    request.update({
        "schema_version": 4,
        "ball_model_profile": "tracknet_v1",
        "analysis": {"mode": "full", "confidence_threshold": 0.7},
        "rally_recognition": {"method": "bounce_events"},
    })
    return request


def test_worker_request_rejects_a_profile_field_in_legacy_schema():
    request = valid_request()
    request["ball_model_profile"] = "tracknet_v1"
    try:
        validate_request(request)
    except Exception as exc:
        assert "schema" in str(exc).lower()
    else:
        raise AssertionError("legacy request schemas must reject added fields")


def test_worker_request_accepts_the_explicit_local_tracknet_schema():
    request = local_tracknet_request()
    assert validate_request(request) is request


def test_worker_request_accepts_mov_and_precalibrated_diagnostics():
    request = valid_request()
    request["video_path"] = "IMG_0070.MOV"
    request["calibration_choice"] = {
        "method": "precalibrated",
        "calibration": valid_request()["calibration_choice"]["calibration"],
        "table_analysis": {"schema_version": 1, "diagnostic": "preserved"},
    }
    assert validate_request(request) is request


def test_worker_request_validates_the_optional_blurball_threshold():
    request = valid_request()
    request["blurball_confidence_threshold"] = 0.55
    assert validate_request(request) is request

    request["blurball_confidence_threshold"] = 0.99
    try:
        validate_request(request)
    except Exception as exc:
        assert "invalid" in str(exc).lower()
    else:
        raise AssertionError("an out-of-range BlurBall threshold must be rejected")


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


def test_worker_uses_requested_blurball_threshold_and_records_it(monkeypatch):
    captured = {}

    class FakeBlurBallPredictor:
        def __init__(self, loaded, confidence_threshold=0.7):
            captured["loaded"] = loaded
            captured["confidence_threshold"] = confidence_threshold

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            captured["roi"] = analysis_roi
            points = [TrajectoryPoint(i, i * 0.1, 1, 640, 360, "blurball", 1.0) for i in range(6)]
            return points, VideoInfo(Path(video_path), 1280, 720, 10.0, 6, 6, 0.6), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=captured["confidence_threshold"],
                step=3, maximum_displacement_pixels=100.0,
            )

    fake_loaded = SimpleNamespace(component_version="1.0.0")
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", "blurball.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_blurball", lambda path, device: captured.update(weight_path=path, device=device) or fake_loaded)
    monkeypatch.setattr("ttcut_worker.worker.BlurBallPredictor", FakeBlurBallPredictor)
    monkeypatch.setattr("ttcut_worker.worker.detect_blurball_bounce_frames", lambda points, calibration: [0, 5])

    request = valid_request()
    request["blurball_confidence_threshold"] = 0.55
    result = analyze(request)
    assert captured["loaded"] is fake_loaded
    assert captured["weight_path"] == "blurball.pt"
    assert captured["device"] == "cpu"
    assert captured["confidence_threshold"] == 0.55
    assert captured["roi"].source_width == 1280
    assert result["rallies"][0]["bounce_count"] == 2
    assert result["bounce_times_seconds"] == [0.0, 0.5]
    assert result["model_provenance"]["profile"] == "blurball_v1"
    assert result["model_provenance"]["detection"] == {
        "confidence_threshold": 0.55, "step": 3,
        "maximum_displacement_pixels": 100.0, "landing_region": "expanded_table",
    }


def test_worker_uses_the_local_tracknet_weight_without_blurball_provenance(monkeypatch):
    captured = {}

    class FakeTrackNetPredictor:
        def __init__(self, loaded, confidence_threshold, roi_model_scale):
            captured["loaded"] = loaded
            captured["confidence_threshold"] = confidence_threshold
            captured["roi_model_scale"] = roi_model_scale
            self.confidence_threshold = confidence_threshold
            self.roi_model_scale = roi_model_scale

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            captured["roi"] = analysis_roi
            points = [TrajectoryPoint(i, i * 0.1, 1, 640, 360, "tracknet", 0.9) for i in range(6)]
            return points, VideoInfo(Path(video_path), 1280, 720, 10.0, 6, 6, 0.6), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=self.confidence_threshold,
                roi_model_scale=self.roi_model_scale, inference_seconds=0.4, predictor_seconds=0.6,
                detected_frames=6, missing_frames=0,
            )

    fake_loaded = SimpleNamespace()
    monkeypatch.setenv("TTCUT_TRACKNET_WEIGHTS", "D:/local/TrackNet_best.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_tracknet", lambda path, device: captured.update(weight_path=path, device=device) or fake_loaded)
    monkeypatch.setattr("ttcut_worker.worker.TrackNetPredictor", FakeTrackNetPredictor)
    monkeypatch.setattr("ttcut_worker.worker.detect_tracknet_bounce_frames", lambda points, calibration: [0, 5])

    result = analyze(local_tracknet_request())

    assert captured["loaded"] is fake_loaded
    assert captured["weight_path"] == "D:/local/TrackNet_best.pt"
    assert captured["device"] == "cpu"
    assert captured["confidence_threshold"] == 0.35
    assert captured["roi_model_scale"] == 1.0
    assert captured["roi"].source_width == 1280
    provenance = result["model_provenance"]
    assert provenance["profile"] == "tracknet_v1"
    assert provenance["component_version"] is None
    assert provenance["main_input"] == {"width": 512, "height": 288}
    assert "detection" not in provenance
    assert "analysis" not in provenance
    assert provenance["tracknet"] == {
        "confidence_threshold": 0.35,
        "roi_model_scale": 1.0,
        "inference_seconds": 0.4,
        "predictor_seconds": 0.6,
        "detected_frames": 6,
        "missing_frames": 0,
    }


def test_worker_applies_the_tracknet_visibility_filter_and_records_its_thresholds(monkeypatch):
    captured = {}

    class FakeTrackNetPredictor:
        def __init__(self, loaded, confidence_threshold, roi_model_scale):
            captured["confidence_threshold"] = confidence_threshold
            captured["roi_model_scale"] = roi_model_scale

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            points = [
                TrajectoryPoint(frame, frame / 10.0, 1, frame * 100, 300, "tracknet", 0.9)
                for frame in range(20)
            ]
            return points, VideoInfo(Path(video_path), 1280, 720, 10.0, 20, 20, 2.0), SimpleNamespace(
                model_width=248, model_height=136, confidence_threshold=0.35,
                roi_model_scale=1.0, inference_seconds=0.4, predictor_seconds=0.6,
                detected_frames=20, missing_frames=0,
            )

    def fake_tracknet_rallies(points, fps, table, *, motion_config):
        captured["tracknet_filter_called"] = True
        return (VisibilityRallySummary(0, 19, 0.0, 1.9),)

    monkeypatch.setenv("TTCUT_TRACKNET_WEIGHTS", "D:/local/TrackNet_best.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_tracknet", lambda path, device: SimpleNamespace())
    monkeypatch.setattr("ttcut_worker.worker.TrackNetPredictor", FakeTrackNetPredictor)
    monkeypatch.setattr("ttcut_worker.worker.tracknet_visibility_rallies", fake_tracknet_rallies)
    monkeypatch.setattr(
        "ttcut_worker.worker.detect_tracknet_bounce_frames",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("bounce detection must be skipped")),
    )
    request = local_tracknet_request()
    request["rally_recognition"] = {"method": "continuous_visibility"}

    result = analyze(request)

    assert captured == {
        "confidence_threshold": 0.35,
        "roi_model_scale": 1.0,
        "tracknet_filter_called": True,
    }
    assert result["rallies"] == [{
        "id": "rally_001", "index": 1, "start_time_seconds": 0.0, "end_time_seconds": 1.9,
    }]
    assert result["rally_recognition"]["tracknet_filter"] == {
        "minimum_rally_seconds": 0.9,
        "minimum_horizontal_run_reversals": 1,
        "short_rally_seconds": 2.0,
        "minimum_short_rally_expanded_table_ratio": 0.25,
        "expanded_table_length_margin_cm": 35.0,
        "expanded_table_width_margin_cm": 25.0,
        "reliable_fragment_bridge_seconds": 0.75,
    }
    assert result["rally_recognition"]["detection_confidence_threshold"] == 0.35
    assert "bounce_times_seconds" not in result


def test_worker_continuous_visibility_skips_bounce_detection_and_records_provenance(monkeypatch):
    class FakeBlurBallPredictor:
        def __init__(self, loaded, confidence_threshold=0.7):
            self.confidence_threshold = confidence_threshold

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            xs = [100, 300, 500, 100, 500, 100]
            points = [
                TrajectoryPoint(frame, frame / 10.0, 1, x, 20, "blurball", 1.0)
                for frame, x in enumerate(xs)
            ]
            return points, VideoInfo(Path(video_path), 1280, 720, 10.0, 6, 6, 0.5), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=self.confidence_threshold,
                step=3, maximum_displacement_pixels=100.0,
            )

    fake_loaded = SimpleNamespace(component_version="1.0.0")
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", "blurball.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_blurball", lambda path, device: fake_loaded)
    monkeypatch.setattr("ttcut_worker.worker.BlurBallPredictor", FakeBlurBallPredictor)
    monkeypatch.setattr(
        "ttcut_worker.worker.detect_blurball_bounce_frames",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("bounce detection must be skipped")),
    )

    request = valid_request()
    request["schema_version"] = 3
    request["analysis"] = {"mode": "two_stage", "stage1_confidence_threshold": 0.3, "stage2_confidence_threshold": 0.7}
    request["rally_recognition"] = {"method": "continuous_visibility"}
    result = analyze(request)

    assert result["schema_version"] == 2
    assert result["rally_recognition"] == {
        "method": "continuous_visibility",
        "detection_confidence_threshold": 0.3,
        "start_visible_seconds": 0.2,
        "end_invisible_seconds": 0.5,
        "motion_filter": {
            "minimum_horizontal_excursion_ratio": 20.0 / 618.0,
            "maximum_reversal_gap_seconds": 0.35,
            "minimum_horizontal_to_vertical_range_ratio": 0.7,
            "maximum_monotonic_vertical_reversals": 1,
            "minimum_monotonic_horizontal_range_ratio": 200.0 / 618.0,
            "minimum_monotonic_duration_seconds": 0.6,
            "short_vertical_filter_seconds": 1.2,
            "maximum_short_vertical_range_ratio": 0.5,
            "vertical_exchange_enabled": False,
            "minimum_vertical_to_horizontal_range_ratio": 1.0,
            "end_on_min_opposing_edge_balance": 0.85,
            "end_on_min_screen_aspect_ratio": 2.0,
        },
        "fragment_bridge": {
            "maximum_gap_seconds": 1.5,
            "maximum_boundary_displacement_ratio": 0.35,
            "maximum_boundary_speed_ratio_per_second": 0.26,
        },
    }
    assert result["rallies"] == [{
        "id": "rally_001", "index": 1, "start_time_seconds": 0.0, "end_time_seconds": 0.5,
    }]
    assert "bounce_times_seconds" not in result
    assert "detection" not in result["model_provenance"]
    assert result["model_provenance"]["analysis"]["mode"] == "full"
    assert result["model_provenance"]["analysis"]["stages"][0]["confidence_threshold"] == 0.3


def test_worker_two_stage_uses_separate_thresholds_and_only_refinement_results(monkeypatch):
    captured = {"predict": [], "predict_intervals": []}

    class FakeBlurBallPredictor:
        def __init__(self, loaded, confidence_threshold=0.7):
            captured.setdefault("thresholds", []).append(confidence_threshold)
            self.confidence_threshold = confidence_threshold

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            captured["predict"].append(self.confidence_threshold)
            points = [point(0, 1.0), point(1, 2.0), point(2, 3.0), point(3, 4.0)]
            return points, VideoInfo(Path(video_path), 1280, 720, 1.0, 4, 4, 5.0), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=self.confidence_threshold,
                step=3, maximum_displacement_pixels=100.0,
            )

        def predict_intervals(self, video_path, intervals, progress_callback=None, analysis_roi=None, confidence_threshold=None):
            captured["predict_intervals"].append((tuple(intervals), confidence_threshold))
            points = [point(1, 2.0), point(2, 3.0)]
            return points, VideoInfo(Path(video_path), 1280, 720, 1.0, 4, 4, 5.0), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=confidence_threshold,
                step=1, maximum_displacement_pixels=100.0,
            )

    fake_loaded = SimpleNamespace(component_version="1.0.0")
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", "blurball.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_blurball", lambda path, device: fake_loaded)
    monkeypatch.setattr("ttcut_worker.worker.BlurBallPredictor", FakeBlurBallPredictor)
    monkeypatch.setattr("ttcut_worker.worker.detect_blurball_bounce_frames", lambda points, calibration: [0, 3] if len(points) == 4 else [1, 2])

    request = valid_request()
    request["schema_version"] = 2
    request.pop("blurball_confidence_threshold", None)
    request["analysis"] = {
        "mode": "two_stage",
        "stage1_confidence_threshold": 0.3,
        "stage2_confidence_threshold": 0.7,
    }
    result = analyze(request)

    assert captured["predict"] == [0.3]
    assert captured["predict_intervals"] == [(((0.25, 4.75),), 0.7)]
    assert result["bounce_times_seconds"] == [2.0, 3.0]
    assert result["rallies"][0]["bounce_count"] == 2
    assert result["model_provenance"]["analysis"]["schema_version"] == 2
    assert result["model_provenance"]["analysis"]["mode"] == "two_stage"
    assert [stage["confidence_threshold"] for stage in result["model_provenance"]["analysis"]["stages"]] == [0.3, 0.7]
    assert result["model_provenance"]["detection"]["step"] == 1


def test_worker_two_stage_with_no_candidate_rallies_returns_empty_result(monkeypatch):
    calls = {"refine": 0}

    class FakeBlurBallPredictor:
        def __init__(self, loaded, confidence_threshold=0.7):
            self.confidence_threshold = confidence_threshold

        def predict(self, video_path, progress_callback=None, analysis_roi=None):
            points = [point(0, 1.0), point(1, 2.0)]
            return points, VideoInfo(Path(video_path), 1280, 720, 1.0, 2, 2, 3.0), SimpleNamespace(
                model_width=512, model_height=288, confidence_threshold=self.confidence_threshold,
                step=3, maximum_displacement_pixels=100.0,
            )

        def predict_intervals(self, *args, **kwargs):
            calls["refine"] += 1
            raise AssertionError("stage two must be skipped when stage one has no rallies")

    fake_loaded = SimpleNamespace(component_version="1.0.0")
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", "blurball.pt")
    monkeypatch.setattr("ttcut_worker.worker.load_blurball", lambda path, device: fake_loaded)
    monkeypatch.setattr("ttcut_worker.worker.BlurBallPredictor", FakeBlurBallPredictor)
    monkeypatch.setattr("ttcut_worker.worker.detect_blurball_bounce_frames", lambda points, calibration: [])

    request = valid_request()
    request["schema_version"] = 2
    request.pop("blurball_confidence_threshold", None)
    request["analysis"] = {
        "mode": "two_stage",
        "stage1_confidence_threshold": 0.3,
        "stage2_confidence_threshold": 0.7,
    }
    result = analyze(request)

    assert calls["refine"] == 0
    assert result["bounce_times_seconds"] == []
    assert result["rallies"] == []
