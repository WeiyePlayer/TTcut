from __future__ import annotations

from pathlib import Path
import io
import sys

import numpy as np
import pytest

from ttcut_worker.blurball_predictor import (
    BLURBALL_DIRECTML_BATCH_SIZES,
    BlurBallPredictor,
)
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


@pytest.mark.parametrize("batch_size", BLURBALL_DIRECTML_BATCH_SIZES)
def test_directml_tail_batch_is_padded_to_active_attempt_and_trimmed(batch_size):
    session = _Session(result=np.zeros((batch_size, 1, 8, 8), dtype=np.float32))
    predictor = BlurBallPredictor(
        LoadedBlurBall(session, "directml", Path("model.onnx")),
        batch_size=batch_size,
    )
    output = predictor._infer_heatmaps(np.ones((1, 9, 8, 8), dtype=np.float32))
    assert session.inputs.shape[0] == batch_size
    assert np.count_nonzero(session.inputs[1:]) == 0
    assert output.shape == (1, 1, 8, 8)


def test_cpu_tail_batch_is_not_padded():
    session = _Session(result=np.zeros((3, 1, 8, 8), dtype=np.float32))
    predictor = BlurBallPredictor(LoadedBlurBall(session, "cpu", Path("model.onnx")))
    output = predictor._infer_heatmaps(np.ones((3, 9, 8, 8), dtype=np.float32))
    assert session.inputs.shape[0] == 3
    assert output.shape == (3, 1, 8, 8)


def worker_request(device="auto"):
    return {
        "task_id": "00000000-0000-0000-0000-000000000001",
        "device": device,
        "ball_model_profile": "blurball_v1",
    }


def run_worker_with(monkeypatch, request, fake_analyze):
    events = []
    monkeypatch.delenv("TTCUT_FORCE_ONNX_CPU", raising=False)
    monkeypatch.delenv("TTCUT_DIRECTML_FALLBACK_REASON", raising=False)
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}\n"))
    monkeypatch.setattr(worker, "validate_request", lambda _value: request)
    monkeypatch.setattr(worker, "emit", events.append)
    monkeypatch.setattr(worker, "analyze", fake_analyze)
    assert worker.main() == 0
    return events


def test_worker_discards_failed_directml_attempt_and_retries_smaller_batch(monkeypatch):
    request = worker_request()
    attempts = []

    def fake_analyze(value, *, directml_batch_size=None):
        attempts.append((
            value,
            directml_batch_size,
            worker.os.environ.get("TTCUT_FORCE_ONNX_CPU"),
            worker.os.environ.get("TTCUT_DIRECTML_FALLBACK_REASON"),
        ))
        if directml_batch_size == 16:
            raise DirectMLFallbackRequired("injected allocation failure")
        return {"provider": "directml", "batch_size": directml_batch_size}

    events = run_worker_with(monkeypatch, request, fake_analyze)
    assert [(item[1], item[2]) for item in attempts] == [(16, None), (8, None)]
    assert attempts[1][3] == "DirectML batch 16 failed: injected allocation failure"
    assert [event["stage"] for event in events if event["type"] == "progress"] == [
        "provider_fallback",
    ]
    assert events[-1]["data"] == {"provider": "directml", "batch_size": 8}
    assert "TTCUT_FORCE_ONNX_CPU" not in worker.os.environ
    assert "TTCUT_DIRECTML_FALLBACK_REASON" not in worker.os.environ


def test_worker_tries_16_8_4_2_then_discards_all_attempts_and_reruns_on_cpu(monkeypatch):
    request = worker_request()
    attempts = []

    def fake_analyze(value, *, directml_batch_size=None):
        attempts.append((directml_batch_size, worker.os.environ.get("TTCUT_FORCE_ONNX_CPU")))
        if directml_batch_size is not None:
            raise DirectMLFallbackRequired(f"batch {directml_batch_size} failed")
        return {
            "provider": "cpu",
            "reason": worker.os.environ.get("TTCUT_DIRECTML_FALLBACK_REASON"),
        }

    events = run_worker_with(monkeypatch, request, fake_analyze)
    assert attempts == [(16, None), (8, None), (4, None), (2, None), (None, "1")]
    assert [event["stage"] for event in events if event["type"] == "progress"] == [
        "provider_fallback",
        "provider_fallback",
        "provider_fallback",
        "provider_fallback",
    ]
    assert "DirectML batch 2 failed: batch 2 failed" in events[-1]["data"]["reason"]


def test_worker_skips_smaller_batches_when_directml_cannot_initialize(monkeypatch):
    request = worker_request()
    attempts = []

    def fake_analyze(value, *, directml_batch_size=None):
        attempts.append((directml_batch_size, worker.os.environ.get("TTCUT_FORCE_ONNX_CPU")))
        if directml_batch_size is not None:
            raise DirectMLFallbackRequired(
                "session initialization failed",
                retry_smaller_batch=False,
            )
        return {"provider": "cpu"}

    events = run_worker_with(monkeypatch, request, fake_analyze)
    assert attempts == [(16, None), (None, "1")]
    assert [event["stage"] for event in events if event["type"] == "progress"] == [
        "provider_fallback",
    ]


def test_worker_cpu_request_does_not_enter_directml_retry_loop(monkeypatch):
    request = worker_request("cpu")
    attempts = []

    def fake_analyze(value, *, directml_batch_size=None):
        attempts.append(directml_batch_size)
        return {"provider": "cpu"}

    events = run_worker_with(monkeypatch, request, fake_analyze)
    assert attempts == [None]
    assert not [event for event in events if event["type"] == "progress"]


def test_worker_restores_preexisting_fallback_environment(monkeypatch):
    request = {
        "task_id": "00000000-0000-0000-0000-000000000001",
        "device": "auto",
        "ball_model_profile": "blurball_v1",
    }
    monkeypatch.setenv("TTCUT_FORCE_ONNX_CPU", "1")
    monkeypatch.setenv("TTCUT_DIRECTML_FALLBACK_REASON", "preexisting")
    monkeypatch.setattr(worker, "analyze", lambda value: {"provider": "cpu"})
    assert worker.analyze_with_provider_fallback(request) == {"provider": "cpu"}
    assert worker.os.environ["TTCUT_FORCE_ONNX_CPU"] == "1"
    assert worker.os.environ["TTCUT_DIRECTML_FALLBACK_REASON"] == "preexisting"
