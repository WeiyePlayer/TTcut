from __future__ import annotations

import io
import json
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from ttcut_worker import directml_probe, onnx_models, worker


@pytest.mark.parametrize(
    ("failure", "expected_batches", "exit_code"),
    [
        ("initialization", [4, None], 0),
        ("inference", [4, None], 0),
        ("cpu_initialization", [None], 2),
    ],
)
def test_ort_failures_preserve_worker_jsonl_and_explicit_fallback(
    monkeypatch, tmp_path, capsys, failure, expected_batches, exit_code,
):
    # Keep the real ORT Python constructor/run fallback logic. Only replace the
    # native session so driver failures are reproducible without a specific GPU.
    ort = pytest.importorskip("onnxruntime")
    from onnxruntime.capi import onnxruntime_pybind11_state as ort_native

    model = tmp_path / "model.onnx"
    model.touch()
    batches = []
    providers = []
    detail = f"injected native {failure} failure"

    def create_native_session(session, requested_providers, provider_options, disabled_optimizers=None):
        provider = requested_providers[0]
        providers.append(provider)
        session._providers = requested_providers
        session._fallback_providers = ["CPUExecutionProvider"]
        if (
            failure == "cpu_initialization"
            or (provider == "DmlExecutionProvider" and (
                failure == "initialization"
                or (failure == "retry_initialization" and batches[-1] == 8)
            ))
        ):
            raise RuntimeError(detail)

        def run(output_names, inputs, run_options):
            if provider == "DmlExecutionProvider":
                if failure == "retry_initialization":
                    # Match the report: batch 16 raises an ordinary run error,
                    # then initializing the batch 8 session raises an EP error.
                    raise RuntimeError(detail)
                raise ort_native.EPFail(detail)
            return [np.zeros((1, 1, 8, 8), dtype=np.float32)]

        session._inputs_meta = [SimpleNamespace(name="input", type="tensor(float)")]
        session._sess = SimpleNamespace(run=run)

    monkeypatch.setattr(ort.InferenceSession, "_create_inference_session", create_native_session)
    monkeypatch.setattr(ort, "get_available_providers", lambda: ["DmlExecutionProvider", "CPUExecutionProvider"])
    monkeypatch.setattr(onnx_models, "_ort", lambda: ort)
    monkeypatch.setattr(directml_probe, "select_configuration", lambda *args, **kwargs: {"provider": "directml", "batch_size": 4, "reason": ""})
    monkeypatch.delenv("TTCUT_FORCE_ONNX_CPU", raising=False)
    monkeypatch.delenv("TTCUT_DIRECTML_FALLBACK_REASON", raising=False)
    request = {
        "task_id": "00000000-0000-0000-0000-000000000001",
        "device": "cpu" if failure == "cpu_initialization" else "auto",
        "ball_model_profile": "blurball_v1",
    }

    def analyze(value, *, directml_batch_size=None):
        batches.append(directml_batch_size)
        loaded = onnx_models.load_blurball(model, value["device"])
        loaded.run(np.zeros((1, 9, 8, 8), dtype=np.float32))
        return {"provider": loaded.provider}

    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request) + "\n"))
    monkeypatch.setattr(worker, "validate_request", lambda value: value)
    monkeypatch.setattr(worker, "analyze", analyze)

    assert worker.main() == exit_code
    captured = capsys.readouterr()
    events = [json.loads(line) for line in captured.out.splitlines()]
    assert batches == expected_batches
    assert providers == [
        "CPUExecutionProvider" if batch is None else "DmlExecutionProvider"
        for batch in expected_batches
    ]
    assert all(event["task_id"] == request["task_id"] for event in events)
    assert [event["stage"] for event in events[:-1]] == ["provider_fallback"] * (len(batches) - 1)
    assert all(event["type"] == "progress" for event in events[:-1])
    if exit_code == 0:
        assert events[-1] == {"type": "result", "task_id": request["task_id"], "data": {"provider": "cpu"}}
    else:
        assert events[-1]["type"] == "error"
        assert events[-1]["code"] == "MODEL_RESOURCE_ERROR"
    assert detail in captured.err
    assert "TTCUT_FORCE_ONNX_CPU" not in worker.os.environ
    assert "TTCUT_DIRECTML_FALLBACK_REASON" not in worker.os.environ
