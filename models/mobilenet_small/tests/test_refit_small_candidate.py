from __future__ import annotations

import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

from annotation_tools import refit_small_candidate as refit
from rally_detection.evaluation import evaluate
from rally_detection.scores import Scores


class ManualDecoderTests(unittest.TestCase):
    def test_actual_end_and_blank_time_are_respected(self):
        video = {"video_id": "short", "relative_path": "short.mp4", "split": "train",
                 "site_session_id": "one", "source_sha256": "source", "proxy_frame_count": "94"}
        rows = [{"label": "PLAY", "start_frame": "1", "end_frame": "30", "start_sec": "0", "end_sec": "1"},
                {"label": "OTHER", "start_frame": "91", "end_frame": "94", "start_sec": "3", "end_sec": str(94 / 30)}]
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            Scores(np.ones((19, 3)) / 3, 6, {"checkpoint_sha256": refit.CHECKPOINT_SHA,
                                            "source_sha256": "source"}).save(cache / "short.npz")
            with patch.object(refit, "inputs", return_value=({}, [video], {"short": rows})):
                sequence = refit.load_manual(Path("export"), cache)[0]
        self.assertEqual(sequence["truth"].tolist(), [1] * 6 + [-1] * 12 + [2])
        self.assertEqual(sequence["reference_rallies"], [{"start_sec": 0., "end_sec": 1.}])

    def test_rejects_extension_beyond_real_last_frame(self):
        video = {"video_id": "short", "relative_path": "short.mp4", "split": "train",
                 "site_session_id": "one", "source_sha256": "source", "proxy_frame_count": "94"}
        rows = [{"label": "PLAY", "start_frame": "1", "end_frame": "100", "start_sec": "0", "end_sec": "3.333333"}]
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            Scores(np.ones((19, 3)) / 3, 6, {"checkpoint_sha256": refit.CHECKPOINT_SHA,
                                            "source_sha256": "source"}).save(cache / "short.npz")
            with patch.object(refit, "inputs", return_value=({}, [video], {"short": rows})):
                with self.assertRaisesRegex(ValueError, "beyond actual"):
                    refit.load_manual(Path("export"), cache)

    def test_negative_only_site_penalizes_actual_false_activity(self):
        sequence = {"relative_path": "empty.mp4", "site": "empty", "split": "train", "fps": 6,
                    "truth": np.full(12, 2), "reference_rallies": [],
                    "intervals": [{"label": "OTHER", "start_sec": "0", "end_sec": "2"}]}
        good = refit.summarize_manual([evaluate(sequence, np.full(12, 2))])
        bad = refit.summarize_manual([evaluate(sequence, np.full(12, 1))])
        self.assertEqual(good["per_site"]["empty"]["reviewed_other_false_activity_rate"], 0.)
        self.assertEqual(bad["per_site"]["empty"]["reviewed_other_false_activity_rate"], 1.)
        self.assertGreater(refit.selection_value(good), refit.selection_value(bad))

    def test_splits_and_merges_are_separately_penalized(self):
        base = {"per_site": {"site": {"rallies": {"reference": 10, "predicted": 10,
                    "split_references": 0, "merged_predictions": 0,
                    "at_iou": {"0.5": {"f1": .8, "fp": 1}, "0.75": {"f1": .6}}},
                    "frame": {"macro_f1": .7, "active_iou": .8},
                    "reviewed_other_false_activity_rate": .1}}}
        import copy
        worse = copy.deepcopy(base)
        worse["per_site"]["site"]["rallies"].update(split_references=2, merged_predictions=2)
        self.assertAlmostEqual(refit.selection_value(base) - refit.selection_value(worse), .20)


if __name__ == "__main__":
    unittest.main()
