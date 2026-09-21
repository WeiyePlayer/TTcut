from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn


ROOT = Path(__file__).resolve().parents[1]
WORKER_ROOT = ROOT / "worker"
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from ttcut_worker.blurball_model import create_blurball  # noqa: E402
from ttcut_worker.table_model import FixedTableModel  # noqa: E402


OPSET = 20
RTOL = 1e-4
ATOL = 1e-5
TABLE_MAX_ABS = 1.1e-4
BLURBALL_SHAPES = ((1, 9, 160, 280), (4, 9, 176, 312), (16, 9, 160, 280))
TABLE_SHAPE = (1, 3, 896, 1600)


class BlurBallScaleZero(nn.Module):
    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model

    def forward(self, tensor: torch.Tensor) -> torch.Tensor:
        return self.model(tensor)[0]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint_state(path: Path) -> tuple[dict[str, torch.Tensor], str]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    state = checkpoint.get("model_state_dict") if isinstance(checkpoint, dict) else None
    if not isinstance(state, dict):
        raise RuntimeError(f"Checkpoint has no model_state_dict: {path}")
    return state, str(checkpoint.get("identifier") or path.stem)


def export_model(
    model: nn.Module,
    sample: torch.Tensor,
    destination: Path,
    dynamic_axes: dict[str, dict[int, str]] | None,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".partial.onnx")
    for stale in (temporary, Path(f"{temporary}.data")):
        stale.unlink(missing_ok=True)
    torch.onnx.export(
        model,
        sample,
        temporary,
        export_params=True,
        opset_version=OPSET,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes=dynamic_axes,
        external_data=False,
    )
    value = onnx.load(temporary)
    # Torch emits allowzero=1 for view/reshape nodes even when their shape
    # tensors contain no zero. DirectML rejects this otherwise equivalent
    # spelling for dynamic shapes, so normalize it to the ONNX default.
    for node in value.graph.node:
        if node.op_type != "Reshape":
            continue
        for attribute in node.attribute:
            if attribute.name == "allowzero":
                attribute.i = 0
    onnx.checker.check_model(value, full_check=True)
    onnx.save(value, destination, save_as_external_data=False)
    temporary.unlink(missing_ok=True)


def inference_session(onnx_path: Path) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = False
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    return ort.InferenceSession(
        str(onnx_path),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )


def compare_blurball(model: nn.Module, onnx_path: Path) -> None:
    session = inference_session(onnx_path)
    generator = torch.Generator(device="cpu").manual_seed(20260920)
    for shape in BLURBALL_SHAPES:
        sample = torch.rand(shape, generator=generator, dtype=torch.float32)
        with torch.inference_mode():
            expected = model(sample).detach().cpu().numpy()
        actual = session.run(["logits"], {"input": sample.numpy()})[0]
        np.testing.assert_allclose(actual, expected, rtol=RTOL, atol=ATOL)
        expected_visible = 1.0 / (1.0 + np.exp(-expected)) >= 0.7
        actual_visible = 1.0 / (1.0 + np.exp(-actual)) >= 0.7
        if not np.array_equal(actual_visible, expected_visible):
            raise AssertionError(f"Visibility threshold mismatch for {onnx_path.name} with shape {shape}")


def compare_table(model: nn.Module, onnx_path: Path) -> None:
    session = inference_session(onnx_path)
    generator = torch.Generator(device="cpu").manual_seed(20260920)
    shapes = (TABLE_SHAPE,)
    for shape in shapes:
        sample = torch.rand(shape, generator=generator, dtype=torch.float32)
        with torch.inference_mode():
            expected = model(sample).detach().cpu().numpy()
        actual = session.run(["logits"], {"input": sample.numpy()})[0]
        maximum_absolute_error = float(np.max(np.abs(actual - expected)))
        if maximum_absolute_error > TABLE_MAX_ABS:
            raise AssertionError(
                f"Table logits exceed max-abs gate: {maximum_absolute_error} > {TABLE_MAX_ABS}",
            )
        actual_flat = actual.reshape(actual.shape[0], actual.shape[1], -1)
        expected_flat = expected.reshape(expected.shape[0], expected.shape[1], -1)
        if not np.array_equal(np.argmax(actual_flat, axis=2), np.argmax(expected_flat, axis=2)):
            raise AssertionError(f"Argmax mismatch for {onnx_path.name} with shape {shape}")
        if not np.array_equal(actual_flat.max(axis=2) >= 0.1, expected_flat.max(axis=2) >= 0.1):
            raise AssertionError(f"Keypoint threshold mismatch for {onnx_path.name} with shape {shape}")
        actual_peaks = np.argpartition(actual_flat, -12, axis=2)[:, :, -12:]
        expected_peaks = np.argpartition(expected_flat, -12, axis=2)[:, :, -12:]
        if not np.array_equal(np.sort(actual_peaks, axis=2), np.sort(expected_peaks, axis=2)):
            raise AssertionError(f"Peak candidate mismatch for {onnx_path.name} with shape {shape}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export TTcut production models to verified ONNX files.")
    parser.add_argument("--models", type=Path, default=ROOT / "resources" / "models")
    parser.add_argument("--manifest", type=Path, default=ROOT / "resources" / "model-manifest.json")
    args = parser.parse_args()
    models = args.models.resolve()

    blurball_source = models / "blurball_best.pt"
    table_source = models / "table_analyze.pt"
    blurball_state, blurball_identifier = checkpoint_state(blurball_source)
    table_state, table_identifier = checkpoint_state(table_source)

    blurball = create_blurball().cpu().eval()
    blurball.load_state_dict(blurball_state, strict=True)
    blurball_wrapper = BlurBallScaleZero(blurball).cpu().eval()
    blurball_output = models / "blurball_best.onnx"
    export_model(
        blurball_wrapper,
        torch.zeros(BLURBALL_SHAPES[0], dtype=torch.float32),
        blurball_output,
        {"input": {0: "batch", 2: "height", 3: "width"}, "logits": {0: "batch", 2: "height", 3: "width"}},
    )
    compare_blurball(blurball_wrapper, blurball_output)

    table = FixedTableModel().cpu().eval()
    table.load_state_dict(table_state, strict=True)
    table_output = models / "table_analyze.onnx"
    export_model(table, torch.zeros(TABLE_SHAPE, dtype=torch.float32), table_output, None)
    compare_table(table, table_output)

    manifest = {
        "schema_version": 2,
        "opset": OPSET,
        "exporter": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "onnx": onnx.__version__,
        },
        "models": [
            {
                "model_id": "table_analysis",
                "identifier": table_identifier,
                "filename": table_output.name,
                "size_bytes": table_output.stat().st_size,
                "sha256": sha256(table_output),
                "source_filename": table_source.name,
                "source_sha256": sha256(table_source),
                "input": {"name": "input", "shape": list(TABLE_SHAPE), "dtype": "float32"},
                "output": {"name": "logits", "shape": [1, 13, 224, 400], "dtype": "float32"},
            },
            {
                "model_id": "blurball_analysis",
                "identifier": blurball_identifier,
                "filename": blurball_output.name,
                "size_bytes": blurball_output.stat().st_size,
                "sha256": sha256(blurball_output),
                "source_filename": blurball_source.name,
                "source_sha256": sha256(blurball_source),
                "input": {"name": "input", "shape": ["batch", 9, "height", "width"], "dtype": "float32"},
                "output": {"name": "logits", "shape": ["batch", 3, "height", "width"], "dtype": "float32"},
            },
        ],
    }
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
