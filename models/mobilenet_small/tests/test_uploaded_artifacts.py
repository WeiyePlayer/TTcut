"""Verify downloaded assets match the model identities used by TTcut."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import unittest

from rally_detection.calibration import features
from rally_detection.scores import Scores
from rally_detection.pipeline import recognize
import numpy as np


ROOT = Path(__file__).resolve().parents[1]


class UploadedArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        self.model = json.loads((ROOT / self.manifest["temporal"]["path"]).read_text(encoding="utf-8"))

    def test_full_checkpoint_and_config_match_ttcut_pins(self):
        bridge = ROOT.parents[1] / "worker/ttcut_worker/mobilenet_small.py"
        pins = {node.targets[0].id: ast.literal_eval(node.value)
                for node in ast.parse(bridge.read_text(encoding="utf-8")).body
                if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id in {"CHECKPOINT_SHA256", "CONFIG_SHA256"}}
        for name, pin in (("checkpoint", "CHECKPOINT_SHA256"), ("temporal", "CONFIG_SHA256")):
            artifact = self.manifest[name]
            payload = (ROOT / artifact["path"]).read_bytes()
            self.assertEqual(len(payload), artifact["size_bytes"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), artifact["sha256"])
            self.assertEqual(artifact["sha256"], pins[pin])
            self.assertFalse(payload.startswith(b"version https://git-lfs.github.com/spec/"))

    def test_calibration_coefficients_bind_to_candidate_and_native_six_fps(self):
        self.assertEqual(self.model["checkpoint_sha256"], self.manifest["checkpoint"]["sha256"])
        self.assertEqual(self.model["fit_sampling_fps"], 6)
        self.assertEqual(self.model["analysis_fps"], 6)
        self.assertEqual(self.model["model_id"], self.manifest["temporal"]["model_id"])
        width = features(np.full((12, 3), 1 / 3), 6).shape[1]
        self.assertEqual(np.asarray(self.model["calibration"]["coefficients"]).shape, (width, 3))
        sequence = Scores(np.full((12, 3), 1 / 3), 6,
                          {"checkpoint_sha256": "0" * 64, "preprocessing": self.model["preprocessing"]})
        with self.assertRaisesRegex(ValueError, "different image checkpoints"):
            recognize(sequence, self.model)


if __name__ == "__main__":
    unittest.main()
