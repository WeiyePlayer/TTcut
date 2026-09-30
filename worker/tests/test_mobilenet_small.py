from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from ttcut_worker import mobilenet_small as bridge


FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/small-source-test1.json"


class SmallBridgeTests(unittest.TestCase):
    def setUp(self):
        self.source = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.metadata = {"path": "C:/video/test.mp4", "duration_seconds": 38., "fps": 59.94,
                         "width": 1920, "height": 1080, "frame_count": 2278,
                         "variable_frame_rate": False, "video_codec": "h264", "audio_codec": "aac", "container": "mp4"}
        self.request = {"schema_version": 6, "task_id": "11111111-1111-4111-8111-111111111111",
                        "video_path": self.metadata["path"], "video_metadata": self.metadata, "device": "auto"}

    def test_frozen_source_boundaries_and_phases_are_preserved(self):
        result = bridge.convert_result(self.source, self.metadata, "cpu")
        self.assertEqual([(r["start_time_seconds"], r["end_time_seconds"]) for r in result["rallies"]],
                         [(r["start_sec"], r["end_sec"]) for r in self.source["rallies"]])
        self.assertEqual(result["segments"], self.source["segments"])
        self.assertEqual(result["small_model"]["sampling_frame_count"], 1114)
        self.assertEqual(result["video"]["fps"], 59.94)
        self.assertEqual(result["video"]["frame_count"], 2278)
        self.assertNotIn("calibration", result)
        self.assertTrue(all("bounce_count" not in r for r in result["rallies"]))

    def test_zero_rallies_is_a_successful_analysis(self):
        self.source["rallies"] = []
        self.assertEqual(bridge.convert_result(self.source, self.metadata, "cpu")["rallies"], [])

    def test_serve_only_is_removed_and_play_only_remains_eligible(self):
        first, second = self.source["rallies"][:2]
        first.update(kind="serve_only", has_play=False,
                     phases=[p for p in first["phases"] if p["label"] == "serve"])
        second.update(kind="play_only", has_serve=False,
                      phases=[p for p in second["phases"] if p["label"] == "play"])
        result = bridge.convert_result(self.source, self.metadata, "cuda")
        self.assertEqual(len(result["rallies"]), 2)
        self.assertEqual(result["rallies"][0]["kind"], "play_only")
        self.assertEqual([r["id"] for r in result["rallies"]], ["rally_001", "rally_002"])

    def test_play_threshold_uses_actual_intervals_not_total_rally_or_cached_duration(self):
        first, second = self.source["rallies"][:2]
        play = next(p for p in first["phases"] if p["label"] == "play")
        play.update(end_sec=play["start_sec"] + 1.999, duration_sec=99.)
        exact = next(p for p in second["phases"] if p["label"] == "play")
        exact.update(end_sec=exact["start_sec"] + 2., duration_sec=0.)
        result = bridge.convert_result(self.source, self.metadata, "cpu")
        self.assertEqual(len(result["rallies"]), 2)
        self.assertEqual(result["rallies"][0]["start_time_seconds"], second["start_sec"])
        self.assertEqual([r["index"] for r in result["rallies"]], [1, 2])

    def test_play_threshold_is_applied_after_clamping_to_real_video_end(self):
        first = self.source["rallies"][0]
        play = copy.deepcopy(next(p for p in first["phases"] if p["label"] == "play"))
        play.update(start_sec=0., end_sec=2., duration_sec=2.)
        first.update(start_sec=0., end_sec=2., phases=[play])
        self.source["rallies"] = [first]
        self.metadata["duration_seconds"] = 1.9
        self.assertEqual(bridge.convert_result(self.source, self.metadata, "cpu")["rallies"], [])

    def test_canonical_tail_is_clamped_to_actual_media_without_changing_fps(self):
        self.metadata["duration_seconds"] = 37.12
        result = bridge.convert_result(self.source, self.metadata, "cpu")
        self.assertEqual(result["rallies"][-1]["end_time_seconds"], 37.12)
        self.assertEqual(result["segments"][-1]["end_sec"], 37.12)
        self.assertEqual(result["video"]["fps"], 59.94)

    def test_request_rejects_calibration_wrong_device_and_invalid_timebase(self):
        self.assertEqual(bridge.validate_request(self.request), self.request)
        for changes in ({"calibration_choice": {"method": "automatic"}}, {"device": "directml"},
                        {"video_metadata": {**self.metadata, "fps": float("nan")}},
                        {"video_metadata": {**self.metadata, "duration_seconds": True}}):
            with self.subTest(changes=changes), self.assertRaises(bridge.SmallError):
                bridge.validate_request({**self.request, **changes})

    def test_missing_and_changed_resources_have_actionable_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(bridge.SmallError) as error:
                bridge.resources(root)
            self.assertEqual(error.exception.code, "SMALL_RESOURCE_MISSING")
            checkpoint = root / "huji_student/runs/manual_p3_20260930_epoch1/best.pt"
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_bytes(b"changed")
            with self.assertRaises(bridge.SmallError) as error:
                bridge.resources(root)
            self.assertEqual(error.exception.code, "SMALL_RESOURCE_CHANGED")

    def test_jsonl_boundary_keeps_diagnostics_off_stdout(self):
        output, errors = io.StringIO(), io.StringIO()

        def analyze(request, progress):
            print("source diagnostic")
            progress("analysis", 5, 10)
            return bridge.convert_result(self.source, self.metadata, "cpu")

        with patch.object(bridge.sys, "stdin", io.StringIO(json.dumps(self.request))), \
                patch.object(bridge.sys, "stdout", output), patch.object(bridge.sys, "stderr", errors), \
                patch.object(bridge, "analyze", analyze):
            self.assertEqual(bridge.main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([e["type"] for e in events], ["progress", "result"])
        self.assertEqual(events[0]["percent"], 50.)
        self.assertIn("source diagnostic", errors.getvalue())

    def test_decoder_is_closed_on_inference_failure(self):
        closed = []

        def frames(_video, fps):
            self.assertEqual(fps, 6)
            try:
                yield from range(65)
            finally:
                closed.append(True)

        def fail(*_args):
            raise RuntimeError("inference failed")

        modules = {
            "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), device=lambda v: v, set_num_threads=lambda _: None),
            "rally_detection.score": SimpleNamespace(load_student=lambda *_: object(), infer=fail, video_arrays=frames, PREPROCESSING="test"),
            "rally_detection.scores": SimpleNamespace(Scores=object),
            "rally_detection.pipeline": SimpleNamespace(recognize=lambda *_: None),
        }
        with patch.dict(bridge.sys.modules, modules), patch.object(bridge, "video_arrays", frames), \
                patch.object(bridge, "resources", return_value=(Path("model.pt"), {"model_id": "test", "analysis_fps": 10})), \
                patch.object(bridge, "digest", return_value="hash"), patch.object(Path, "is_file", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                bridge.analyze(copy.deepcopy(self.request), lambda *_: None)
        self.assertEqual(closed, [True])

    def test_default_6fps_changes_sampling_scores_and_progress_together(self):
        received = {}
        config = {"model_id": "test", "analysis_fps": 10, "decoder": {"switch_cost": .35}}
        source = self.source

        def scores(values, fps, metadata):
            received.update(count=len(values), fps=fps)
            return SimpleNamespace(values=values, fps=fps, metadata=metadata)

        def recognize(sequence, effective):
            received["config"] = effective
            return {**source, "fps": sequence.fps, "frame_count": len(sequence.values)}

        def frames(_video, fps):
            received["sample_fps"] = fps
            yield from range(65)

        modules = {
            "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), device=lambda v: v, set_num_threads=lambda _: None),
            "rally_detection.score": SimpleNamespace(load_student=lambda *_: object(), infer=lambda _, b, __: np.ones((len(b), 3)) / 3, PREPROCESSING="test"),
            "rally_detection.scores": SimpleNamespace(Scores=scores),
            "rally_detection.pipeline": SimpleNamespace(recognize=recognize),
        }
        progress = []
        with patch.dict(bridge.sys.modules, modules), patch.object(bridge, "video_arrays", frames), \
                patch.object(bridge, "resources", return_value=(Path("model.pt"), config)), \
                patch.object(bridge, "digest", return_value="hash"), patch.object(Path, "is_file", return_value=True):
            result = bridge.analyze(self.request, lambda *v: progress.append(v))
        self.assertEqual(received["sample_fps"], 6)
        self.assertEqual(received["fps"], 6)
        self.assertEqual(received["count"], 65)
        self.assertIn(("analysis", 64, 228), progress)
        self.assertEqual(received["config"]["analysis_fps"], 6)
        self.assertEqual(config["analysis_fps"], 10)
        self.assertEqual(received["config"]["decoder"]["switch_cost"], .35)
        self.assertEqual(result["small_model"]["calibration_status"], "transferred_30fps_without_refit")

    def test_invalid_sampling_rates_are_rejected(self):
        for fps in (0, 13, 24, True, 12.5, "12"):
            with self.subTest(fps=fps), self.assertRaises(bridge.SmallError):
                bridge.validate_request({**self.request, "sampling_fps": fps})

    def test_refitted_candidate_uses_native_identity_at_6fps_and_marks_transfers(self):
        config = {"model_id": "refitted", "analysis_fps": 6., "fit_sampling_fps": 6,
                  "checkpoint_calibration_status": "refitted_for_pinned_finetuned_checkpoint",
                  "decoder": {"switch_cost": .1}}
        native, profile = bridge.temporal_profile(config, 6)
        self.assertEqual(native, config)
        self.assertEqual(profile["config_sha256"], bridge.CONFIG_SHA256)
        self.assertEqual(profile["calibration_status"], "refitted_6fps")
        self.assertEqual(profile["calibration_training_fps"], 6)
        for fps in (12, 30):
            transferred, profile = bridge.temporal_profile(config, fps)
            self.assertEqual(profile["calibration_status"], "transferred_6fps_without_refit")
            self.assertNotEqual(profile["config_sha256"], bridge.CONFIG_SHA256)
            self.assertIn(f"{fps}fps-transfer-from-6", transferred["model_id"])
            self.assertEqual(transferred["decoder"], config["decoder"])

    def test_sweep_rates_preserve_seconds_parameters_and_identify_actual_decoder_rate(self):
        config = {"model_id": "frozen", "analysis_fps": 10.,
                  "decoder": {"switch_cost": .35}, "refinement": {"max_growth_sec": .5}}
        identities = set()
        for fps in range(1, 13):
            self.assertEqual(bridge.validate_request({**self.request, "sampling_fps": fps})["sampling_fps"], fps)
            effective, profile = bridge.temporal_profile(config, fps)
            self.assertEqual(effective["analysis_fps"], fps)
            self.assertEqual(effective["decoder"], config["decoder"])
            self.assertEqual(effective["refinement"], config["refinement"])
            self.assertEqual(profile["decoder_fps"], fps)
            identities.add(profile["config_sha256"])
        self.assertEqual(len(identities), 12)
        self.assertEqual(config["analysis_fps"], 10.)
        baseline, profile = bridge.temporal_profile(config, 30)
        self.assertEqual(baseline, config)
        self.assertEqual(profile["config_sha256"], bridge.CONFIG_SHA256)


if __name__ == "__main__":
    unittest.main()
