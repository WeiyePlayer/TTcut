from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("small_sweep", Path(__file__).resolve().parents[2] / "scripts/sweep-small-sampling.py")
sweep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sweep)


class ContinuousIntervalEvaluationTests(unittest.TestCase):
    def test_unknown_time_is_excluded_from_iou(self):
        rows = [{"label": "PLAY", "start_frame": 1, "end_frame": 10, "fps": 10},
                {"label": "OTHER", "start_frame": 21, "end_frame": 30, "fps": 10}]
        coverage = sweep.coverage_function(rows, 3)
        self.assertAlmostEqual(float(coverage(3)), 2.)
        self.assertAlmostEqual(float(coverage(1.5)), 1.)
        result = sweep.match([{"start_sec": 0., "end_sec": 3.}], [{"start_sec": 0., "end_sec": 1.}], coverage)
        self.assertEqual(result["tp"], 1)  # 1/2 reviewed IoU, not 1/3 wall-time IoU.

    def test_one_merged_prediction_cannot_match_two_references(self):
        coverage = sweep.coverage_function([{"label": "PLAY", "start_frame": 1, "end_frame": 30, "fps": 10}], 3)
        result = sweep.match([{"start_sec": 0., "end_sec": 2.}],
                             [{"start_sec": 0., "end_sec": 1.}, {"start_sec": 1., "end_sec": 2.}], coverage)
        self.assertEqual((result["tp"], result["fp"], result["fn"]), (1, 0, 1))

    def test_boundaries_keep_fractional_times_without_grid_rounding(self):
        coverage = sweep.coverage_function([{"label": "PLAY", "start_frame": 1, "end_frame": 30, "fps": 10}], 3)
        result = sweep.match([{"start_sec": 1/7, "end_sec": 2 + 1/11}],
                             [{"start_sec": 0., "end_sec": 2.}], coverage)
        self.assertAlmostEqual(result["start_mae_sec"], 1/7)
        self.assertAlmostEqual(result["end_mae_sec"], 1/11)


if __name__ == "__main__":
    unittest.main()
