from __future__ import annotations

import os
import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .errors import DirectMLFallbackRequired, InferenceError, ModelResourceError


def model_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _ort():
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise ModelResourceError("The bundled ONNX Runtime is missing.") from exc
    return ort


def session_options(provider: str):
    ort = _ort()
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = False
    if provider == "directml":
        # ORT 1.24.3's DML fusion can produce an invalid two-input
        # DmlFusedGemm for the model's bias-free squeeze/excitation layers.
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    return options


def create_session(path: str | Path, provider: str):
    model = Path(path)
    if not model.is_file():
        raise ModelResourceError(f"Bundled ONNX model is missing: {model}")
    ort = _ort()
    if provider == "directml" and "DmlExecutionProvider" not in ort.get_available_providers():
        raise DirectMLFallbackRequired("DirectML execution provider is unavailable.")
    providers = ["DmlExecutionProvider"] if provider == "directml" else ["CPUExecutionProvider"]
    try:
        return ort.InferenceSession(
            str(model),
            sess_options=session_options(provider),
            providers=providers,
        )
    except Exception as exc:
        if provider == "directml":
            raise DirectMLFallbackRequired("DirectML session initialization failed.") from exc
        raise ModelResourceError(f"Bundled ONNX model is invalid: {model}") from exc


@dataclass
class LoadedBlurBall:
    session: object
    provider: str
    model_path: Path
    model_sha256: str = "0" * 64
    runtime_version: str = "test"
    component_version: str = "onnx-1.0.0"

    def run(self, inputs: np.ndarray) -> np.ndarray:
        try:
            logits = self.session.run(["logits"], {"input": inputs})[0]
        except Exception as exc:
            if self.provider == "directml":
                raise DirectMLFallbackRequired("DirectML inference failed.") from exc
            raise InferenceError("BlurBall ONNX inference failed.") from exc
        if not np.isfinite(logits).all():
            if self.provider == "directml":
                raise DirectMLFallbackRequired("DirectML inference produced non-finite values.")
            raise InferenceError("BlurBall ONNX inference produced non-finite values.")
        return np.asarray(logits, dtype=np.float32)


def requested_onnx_provider(requested_device: str) -> str:
    if os.environ.get("TTCUT_FORCE_ONNX_CPU") == "1" or requested_device == "cpu":
        return "cpu"
    if requested_device in {"auto", "directml"}:
        return "directml"
    # CUDA is retained only for the explicit local TrackNet development path.
    return "cpu"


def load_blurball(weight_value: str | Path, requested_device: str) -> LoadedBlurBall:
    path = Path(weight_value)
    provider = requested_onnx_provider(requested_device)
    return LoadedBlurBall(create_session(path, provider), provider, path, model_sha256(path), _ort().__version__)


def load_table_session(weight_value: str | Path):
    path = Path(weight_value)
    return create_session(path, "cpu"), path
