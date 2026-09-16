from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from ttcut_worker.tracknet_model import LoadedTrackNet
from ttcut_worker.tracknet_predictor import TrackNetPredictor
from ttcut_worker.video import FramePacket, VideoInfo


def test_shared_heatmaps_preserve_independent_threshold_histories():
    torch = pytest.importorskip("torch")
    pytest.importorskip("cv2")
    script = Path(__file__).resolve().parents[2] / "scripts/benchmark-tracknet-thresholds.py"
    spec = importlib.util.spec_from_file_location("threshold_benchmark", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class Model:
        def __init__(self):
            self.calls = 0

        def __call__(self, tensor):
            self.calls += 1
            heatmap = torch.zeros((1, 1, 16, 16))
            heatmap[0, 0, 8, 8] = tensor[0, 0, 0, 0]
            return heatmap

    model = Model()
    loaded = LoadedTrackNet(model, 1, "", torch.device("cpu"))
    joint = module.ThresholdPredictor(loaded)
    separate = {
        threshold: TrackNetPredictor(LoadedTrackNet(Model(), 1, "", torch.device("cpu")),
                                     confidence_threshold=threshold)
        for threshold in module.THRESHOLDS
    }
    expected = {threshold: [] for threshold in module.THRESHOLDS}
    info = VideoInfo(Path("synthetic.mp4"), 16, 16, 30.0, 3, 3, .1)
    for index, confidence in enumerate((.32, .37, .42)):
        frame = np.full((16, 16, 3), confidence * 255, dtype=np.float32)
        packet = FramePacket(index, index / 30, "fps_estimation", frame)
        joint._predict_window([frame], [packet], None, info, None)
        for threshold, predictor in separate.items():
            expected[threshold].extend(predictor._predict_window([frame], [packet], None, info, None))

    assert model.calls == 3
    assert joint.trajectories == expected
    assert {key: [p.visibility for p in value] for key, value in expected.items()} == {
        .3: [1, 1, 1], .35: [0, 1, 1], .4: [0, 0, 1],
    }
    assert len({id(peer._model_history) for peer in joint.peers.values()}) == 3
