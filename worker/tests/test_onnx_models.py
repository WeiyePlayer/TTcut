from __future__ import annotations

from pathlib import Path
import io
import sys

import numpy as np
import pytest

from ttcut_worker.blurball_predictor import BLURBALL_BATCH_SIZE, BlurBallPredictor
from ttcut_worker.errors import DirectMLFallbackRequired, InferenceError
from ttcut_worker.onnx_models import LoadedBlurBall, requested_onnx_provider
from ttcut_worker import worker


class _Session:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.inputs = None

    def run(self, outputs, values):
        assert outputs == ["logits"]
        self.inputs = values["input"]
        if self.error:
            raise self.error
        return [self.result]


def test_provider_selection_respects_auto_directml_and_forced_cpu(monkeypatch):
    monkeypatch.delenv("TTCUT_FORCE_ONNX_CPU", raising=False)
    assert requested_onnx_provider("auto") == "directml"
    assert requested_onnx_provider("directml") == "directml"
    assert requested_onnx_provider("cpu") == "cpu"
    assert requested_onnx_provider("cuda") == "cpu"
    monkeypatch.setenv("TTCUT_FORCE_ONNX_CPU", "1")
    assert requested_onnx_provider("auto") == "cpu"


def test_directml_failure_requests_full_cpu_fallback():
    loaded = LoadedBlurBall(_Session(error=RuntimeError("device lost")), "directml", Path("model.onnx"))
    with pytest.raises(DirectMLFallbackRequired, match="DirectML inference failed"):
        loaded.run(np.zeros((16, 9, 8, 8), dtype=np.float32))


def test_cpu_failure_stays_an_inference_error():
    loaded = LoadedBlurBall(_Session(error=RuntimeError("bad graph")), "cpu", Path("model.onnx"))
    with pytest.raises(InferenceError, match="BlurBall ONNX inference failed"):
        loaded.run(np.zeros((4, 9, 8, 8), dtype=np.float32))


def test_directml_tail_batch_is_padded_to_sixteen_and_trimmed():
    session = _Session(result=np.zeros((BLURBALL_BATCH_SIZE, 1, 8, 8), dtype=np.float32))
    predictor = BlurBallPredictor(LoadedBlurBall(session, "directml", Path("model.onnx")))
    output = predictor._infer_heatmaps(np.ones((3, 9, 8, 8), dtype=np.float32))
    assert session.inputs.shape[0] == BLURBALL_BATCH_SIZE
    assert np.count_nonzero(session.inputs[3:]) == 0
    assert output.shape == (3, 1, 8, 8)


def test_cpu_tail_batch_is_not_padded():
    session = _Session(result=np.zeros((3, 1, 8, 8), dtype=np.float32))
    predictor = BlurBallPredictor(LoadedBlurBall(session, "cpu", Path("model.onnx")))
    output = predictor._infer_heatmaps(np.ones((3, 9, 8, 8), dtype=np.float32))
    assert session.inputs.shape[0] == 3
    assert output.shape == (3, 1, 8, 8)


def test_worker_discards_directml_attempt_and_reruns_from_entrypoint(monkeypatch):
    request = {
        "task_id": "00000000-0000-0000-0000-000000000001",
        "device": "auto",
        "ball_model_profile": "blurball_v1",
    }
    attempts = []
    events = []

    monkeypatch.setattr(sys, "stdin", io.StringIO("{}\n"))
    monkeypatch.setattr(worker, "validate_request", lambda _value: request)
    monkeypatch.setattr(worker, "emit", events.append)

    def fake_analyze(value):
        attempts.append((value, worker.os.environ.get("TTCUT_FORCE_ONNX_CPU")))
        if len(attempts) == 1:
            raise DirectMLFallbackRequired("device removed")
        return {"provider": "cpu"}

    monkeypatch.setattr(worker, "analyze", fake_analyze)
    assert worker.main() == 0
    assert attempts == [(request, None), (request, "1")]
    assert [event["stage"] for event in events if event["type"] == "progress"] == [
        "provider_fallback", "provider_fallback",
    ]
    assert events[-1]["data"] == {"provider": "cpu"}
    assert "TTCUT_FORCE_ONNX_CPU" not in worker.os.environ
    assert "TTCUT_DIRECTML_FALLBACK_REASON" not in worker.os.environ
