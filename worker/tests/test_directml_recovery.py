from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from ttcut_worker import blurball_predictor as predictor_module, directml_probe, onnx_models
from ttcut_worker.blurball_predictor import BlurBallPredictor
from ttcut_worker.errors import DirectMLFallbackRequired
from ttcut_worker.onnx_models import LoadedBlurBall


def test_native_inference_error_preserves_hidden_hresult():
    def fail(*args):
        b"HRESULT 0x8007000E: test native failure \xb2".decode("utf-8")
    loaded = LoadedBlurBall(SimpleNamespace(run=fail), "directml", Path("missing.onnx"))
    with pytest.raises(DirectMLFallbackRequired, match="HRESULT 0x8007000E") as error:
        loaded.run(np.zeros((4, 9, 8, 8), np.float32))
    assert isinstance(error.value.__cause__, UnicodeDecodeError)


def test_fixed_shape_overrides_only_apply_to_directml(monkeypatch):
    dimensions = {}
    options = SimpleNamespace(add_free_dimension_override_by_name=dimensions.__setitem__)
    monkeypatch.setattr(onnx_models, "_ort", lambda: SimpleNamespace(
        SessionOptions=lambda: options,
        ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL="sequential"),
        GraphOptimizationLevel=SimpleNamespace(ORT_DISABLE_ALL="disabled"),
    ))
    onnx_models.session_options("directml", (4, 9, 264, 704))
    assert dimensions == {"batch": 4, "height": 264, "width": 704}
    assert options.execution_mode == "sequential"
    assert options.enable_mem_pattern is False
    assert options.graph_optimization_level == "disabled"
    dimensions.clear()
    onnx_models.session_options("cpu", (4, 9, 264, 704))
    assert dimensions == {}


@pytest.mark.parametrize("fail_after", [0, 1])
def test_retry_preserves_pending_windows_and_order_without_duplicate_outputs(monkeypatch, fail_after):
    calls = []
    created = []
    saved = []
    successes = 0

    def run(_outputs, feeds):
        nonlocal successes
        inputs = feeds["input"]
        calls.append(inputs.shape[0])
        if len(inputs) > 1 and successes >= fail_after:
            raise RuntimeError("allocation failure")
        successes += 1
        return [inputs[:, :3].copy()]

    def create(path, provider, *, input_shape):
        created.append(input_shape)
        assert provider == "directml"
        return SimpleNamespace(run=run)

    monkeypatch.setattr(predictor_module, "create_session", create)
    monkeypatch.setattr(directml_probe, "remember_configuration", lambda *args: saved.append(args))
    predictor = BlurBallPredictor(LoadedBlurBall(SimpleNamespace(run=run), "directml", Path("model.onnx")), batch_size=4)
    inputs = np.linspace(-2, 2, 7 * 9 * 8 * 8, dtype=np.float32).reshape(7, 9, 8, 8)
    result = predictor._infer_heatmaps(inputs)
    np.testing.assert_array_equal(result, 1 / (1 + np.exp(-inputs[:, :3])))
    assert predictor.batch_size == predictor.loaded.batch_size == 1
    assert created == [(2, 9, 8, 8), (1, 9, 8, 8)]
    assert saved == [(Path("model.onnx"), 8, 8, 1)]
    assert calls.count(4) == fail_after + 1
    # The reduced batch persists for the next full/tail batch.
    predictor._infer_heatmaps(inputs[:1])
    assert calls[-1] == 1


def test_retry_initialization_failure_can_reduce_fixed_shape_again(monkeypatch):
    shapes = []
    def fail(*args):
        raise RuntimeError("allocation failure")
    def create(path, provider, *, input_shape):
        shapes.append(input_shape)
        if input_shape[0] == 2:
            raise DirectMLFallbackRequired("fixed shape still too large")
        return SimpleNamespace(run=lambda outputs, feeds: [feeds["input"][:, :3]])
    monkeypatch.setattr(predictor_module, "create_session", create)
    loaded = LoadedBlurBall(SimpleNamespace(run=fail), "directml", Path("missing.onnx"))
    predictor = BlurBallPredictor(loaded, batch_size=4)
    assert predictor._infer_heatmaps(np.zeros((3, 9, 8, 8), np.float32)).shape == (3, 3, 8, 8)
    assert [shape[0] for shape in shapes] == [2, 1]


@pytest.mark.parametrize("retryable,expected", [(True, [4, 2, 1]), (False, [4])])
def test_gpu_retries_are_bounded_before_outer_cpu_restart(monkeypatch, retryable, expected):
    attempted = []
    def session(batch):
        def run(*args):
            attempted.append(batch)
            raise DirectMLFallbackRequired("persistent failure", retry_smaller_batch=retryable)
        # Use a loaded stub so the existing retryability flag is preserved.
        return SimpleNamespace(run=run)
    loaded = SimpleNamespace(provider="directml", batch_size=4, model_path=Path("missing.onnx"), session=object())
    loaded.run = lambda inputs: session(len(inputs)).run()
    monkeypatch.setattr(predictor_module, "create_session", lambda *args, **kwargs: object())
    with pytest.raises(DirectMLFallbackRequired):
        BlurBallPredictor(loaded)._infer_heatmaps(np.zeros((4, 9, 8, 8), np.float32))
    assert attempted == expected


def test_probe_rejects_batch_that_only_passes_first_run(monkeypatch, tmp_path):
    model = tmp_path / "model.onnx"
    model.touch()
    monkeypatch.setattr(directml_probe, "cache_path", lambda path: tmp_path / "cache.json")
    attempts = []
    def create(path, provider, *, input_shape):
        count = 0
        def run(outputs, feeds):
            nonlocal count
            count += 1
            attempts.append((input_shape[0], count))
            if input_shape[0] == 4 and count == 2:
                raise RuntimeError("second run allocation failure")
            return [np.zeros((input_shape[0], 3, *input_shape[2:]), np.float32)]
        return SimpleNamespace(run=run)
    monkeypatch.setattr(directml_probe, "create_session", create)
    configuration = directml_probe.select_configuration(model, 32, 16, retain_session=True)
    assert configuration["batch_size"] == 2
    assert attempts == [(4, 1), (4, 2), (2, 1), (2, 2), (2, 3)]
