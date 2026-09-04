#!/usr/bin/env python3
"""Convert the exact TTcut networks to FP32 Core ML and compare fixed inputs."""
from __future__ import annotations
import argparse
import hashlib
import json
import sys
from pathlib import Path
import time
import numpy as np
import torch
import coremltools as ct

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))
from ttcut_worker.blurball_model import create_blurball
from ttcut_worker.table_model import FixedTableModel
import ttcut_worker.table_model as table_module
from coreml_table_adapter import matching

torch.set_num_threads(4)
torch.manual_seed(42)
np.random.seed(42)

class BallOutput(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
    def forward(self, tensor):
        return self.model(tensor)[0].sigmoid()

def convert(name: str, verify_only: bool):
    is_ball = name == "BlurBall"
    filename = "blurball_best.pt" if is_ball else "table_analyze.pt"
    weights = ROOT / "resources/models" / filename
    model = create_blurball() if is_ball else FixedTableModel()
    checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
    model.load_state_dict(checkpoint["model_state_dict"], strict=True)
    model = (BallOutput(model) if is_ball else model).eval()
    shape = (1, 9, 160, 280) if is_ball else (1, 3, 896, 1600)
    example = torch.rand(shape, dtype=torch.float32)
    destination = ROOT / "macos/Resources/Models"
    destination.mkdir(parents=True, exist_ok=True)
    package = destination / f"{name}.mlpackage"
    # Table token-matching order is sensitive to tiny GPU accumulation changes.
    # Core ML CPU preserves the fixed FP32 reference tolerance on this model.
    units = ct.ComputeUnit.CPU_AND_GPU if is_ball else ct.ComputeUnit.CPU_ONLY
    if not verify_only:
        print(f"Tracing {name} {shape}", flush=True)
        original_matching = table_module.bipartite_soft_matching_random2d
        if not is_ball:
            with torch.inference_mode():
                original_output = model(example)
                table_module.bipartite_soft_matching_random2d = matching
                adapted_output = model(example)  # also warms the static layout cache
                torch.testing.assert_close(adapted_output, original_output, rtol=1e-3, atol=1e-4)
        with torch.inference_mode():
            traced = torch.jit.trace(model, example, check_trace=False)
        input_shape = (1, 9, ct.RangeDim(8, 360, 160), ct.RangeDim(8, 640, 280)) if is_ball else shape
        print(f"Converting {name}", flush=True)
        converted = ct.convert(
            traced,
            inputs=[ct.TensorType(name="frames", shape=input_shape, dtype=np.float32)],
            outputs=[ct.TensorType(name="heatmaps", dtype=np.float32)],
            convert_to="mlprogram", minimum_deployment_target=ct.target.macOS15,
            compute_precision=ct.precision.FLOAT32, compute_units=units,
        )
        converted.short_description = f"TTcut {name}, immutable Windows-reference weights, FP32"
        converted.user_defined_metadata["checkpoint_sha256"] = hashlib.sha256(weights.read_bytes()).hexdigest()
        converted.save(str(package))
        table_module.bipartite_soft_matching_random2d = original_matching
    else:
        converted = ct.models.MLModel(str(package), compute_units=units)
    shapes = [(1, 9, 160, 280), (1, 9, 192, 336), (1, 9, 288, 512)] if is_ball else [shape]
    report = {"model": name, "checkpoint_sha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
              "torch": torch.__version__, "coremltools": ct.__version__, "precision": "float32", "compute_units": str(units), "comparisons": []}
    for case_shape in shapes:
        inputs = np.random.default_rng(42).uniform(-1, 1, case_shape).astype(np.float32)
        started = time.monotonic()
        with torch.inference_mode():
            expected = model(torch.from_numpy(inputs)).numpy()
        result = converted.predict({"frames": inputs})["heatmaps"]
        difference = np.abs(expected - result)
        allowed = 1e-4 + 1e-3 * np.abs(expected)
        case = {"shape": case_shape, "max_abs_error": float(difference.max()),
                "mean_abs_error": float(difference.mean()), "violations": int(np.sum(difference > allowed)),
                "seconds": time.monotonic() - started}
        report["comparisons"].append(case)
        print(json.dumps(case), flush=True)
        if not np.isfinite(result).all() or case["violations"]:
            report["passed"] = False
            break
    else:
        report["passed"] = True
    report_path = ROOT / "macos/output/verification"
    report_path.mkdir(parents=True, exist_ok=True)
    (report_path / f"{name}-conversion.json").write_text(json.dumps(report, indent=2) + "\n")
    if not report["passed"]:
        raise RuntimeError(f"{name} numerical comparison failed; inspect report")
    print(f"Verified {name}", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=["BlurBall", "Table", "all"])
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    for name in (["BlurBall", "Table"] if args.model == "all" else [args.model]):
        convert(name, args.verify_only)
