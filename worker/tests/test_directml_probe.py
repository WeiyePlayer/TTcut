from types import SimpleNamespace
import json

import numpy as np
import pytest

from ttcut_worker import directml_probe as probe, onnx_models, worker
from ttcut_worker.errors import DirectMLFallbackRequired


@pytest.fixture
def setup_probe(monkeypatch, tmp_path):
    model = tmp_path / "blurball.onnx"
    model.write_bytes(b"model-v1")
    monkeypatch.setenv("TTCUT_DIRECTML_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(probe, "device_identity", lambda: ["GPU", "driver1"])
    monkeypatch.setattr(probe, "_ort", lambda: SimpleNamespace(__version__="1.24.3"))
    monkeypatch.delenv("TTCUT_FORCE_ONNX_CPU", raising=False)
    calls = []

    def session(_model, provider):
        def run(_outputs, feeds):
            inputs = feeds["input"]
            calls.append(inputs.shape)
            assert inputs.dtype == np.float32 and np.ptp(inputs) > 0
            if inputs.shape[0] > 2:
                raise RuntimeError("Resize allocation failure")
            return [np.zeros((inputs.shape[0], 3, *inputs.shape[2:]), np.float32)]
        return SimpleNamespace(run=run)

    monkeypatch.setattr(probe, "create_session", session)
    return model, calls


def test_probe_finds_batch_before_analysis_and_reuses_across_tasks(setup_probe):
    model, calls = setup_probe
    assert probe.select_configuration(model, 32, 16)["batch_size"] == 2
    assert [shape[0] for shape in calls] == [16, 8, 4, 2]
    calls.clear()
    assert probe.select_configuration(model, 32, 16)["batch_size"] == 2
    assert calls == []
    assert probe.select_configuration(model, 64, 32)["batch_size"] == 2
    assert all(shape[2:] == (32, 64) for shape in calls)


def test_late_failure_caches_cpu_and_skips_probe_next_task(setup_probe, monkeypatch):
    model, calls = setup_probe
    probe.select_configuration(model, 32, 16)
    monkeypatch.setenv("TTCUT_BLURBALL_WEIGHTS", str(model))
    attempts = []
    def analyze(request, *, directml_batch_size=None):
        attempts.append(directml_batch_size)
        if directml_batch_size is not None:
            raise DirectMLFallbackRequired("device lost at frame 100000")
        return {"provider": "cpu"}
    monkeypatch.setattr(worker, "analyze", analyze)
    assert worker.analyze_with_provider_fallback({"device": "auto", "task_id": "test"}) == {"provider": "cpu"}
    assert attempts == [16, None]
    calls.clear()
    assert probe.select_configuration(model, 32, 16)["provider"] == "cpu"
    assert probe.select_configuration(model, 128, 64)["provider"] == "cpu"
    assert calls == []


@pytest.mark.parametrize("change", ["model", "runtime", "driver", "expired", "corrupt"])
def test_cache_invalidated_when_identity_or_validity_changes(setup_probe, monkeypatch, change):
    model, calls = setup_probe
    probe.remember_failure(model, "old failure")
    path = probe.cache_path(model)
    if change == "model":
        model.write_bytes(b"model-v2")
    elif change == "runtime":
        monkeypatch.setattr(probe, "_ort", lambda: SimpleNamespace(__version__="new"))
    elif change == "driver":
        monkeypatch.setattr(probe, "device_identity", lambda: ["GPU", "driver2"])
    elif change == "expired":
        path.write_text(json.dumps({"provider": "cpu", "time": 1}))
    else:
        path.write_text("broken")
    assert probe.select_configuration(model, 32, 16)["provider"] == "directml"
    assert calls


def test_session_initialization_failure_skips_remaining_batches(setup_probe, monkeypatch):
    model, _ = setup_probe
    calls = []
    def fail(*args):
        calls.append(1)
        raise DirectMLFallbackRequired("unsupported driver", retry_smaller_batch=False)
    monkeypatch.setattr(probe, "create_session", fail)
    assert probe.select_configuration(model)["provider"] == "cpu"
    assert probe.select_configuration(model)["provider"] == "cpu"
    assert len(calls) == 1


def test_invalid_output_uses_cpu(setup_probe, monkeypatch):
    model, _ = setup_probe
    monkeypatch.setattr(probe, "create_session", lambda *args: SimpleNamespace(run=lambda *args: [np.full((16, 3, 16, 32), np.nan)]))
    assert probe.select_configuration(model, 32, 16)["provider"] == "cpu"


def test_interrupted_probe_leaves_cpu_marker(setup_probe, monkeypatch):
    model, _ = setup_probe
    def interrupted(*args):
        raise KeyboardInterrupt()
    monkeypatch.setattr(probe, "create_session", interrupted)
    with pytest.raises(KeyboardInterrupt):
        probe.select_configuration(model, 32, 16)
    assert probe.select_configuration(model, 32, 16)["provider"] == "cpu"


def test_loader_and_predictor_use_verified_batch_and_cached_cpu(setup_probe, monkeypatch):
    from ttcut_worker.blurball_predictor import BlurBallPredictor
    model, calls = setup_probe
    providers = []
    monkeypatch.setattr(onnx_models, "_ort", lambda: SimpleNamespace(__version__="1.24.3"))
    monkeypatch.setattr(onnx_models, "create_session", lambda path, provider: providers.append(provider) or object())
    monkeypatch.delenv("TTCUT_DIRECTML_FALLBACK_REASON", raising=False)
    loaded = onnx_models.load_blurball(model, "auto", (32, 16))
    assert BlurBallPredictor(loaded).batch_size == 2
    assert providers == ["directml"]
    assert calls[0] == (16, 9, 16, 32)
    probe.remember_failure(model, "late device failure")
    loaded = onnx_models.load_blurball(model, "auto", (32, 16))
    assert loaded.provider == "cpu"
    assert providers == ["directml", "cpu"]
