#!/usr/bin/env python3
"""Convert an isolated BlurBall precision candidate; never replace runtime assets."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import convert_models as reference


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--precision', choices=['fp16', 'mixed'], default='fp16')
    args = parser.parse_args()
    ct, torch, np = reference.ct, reference.torch, reference.np
    weights = reference.ROOT / 'resources/models/blurball_best.pt'
    model = reference.create_blurball()
    model.load_state_dict(torch.load(weights, map_location='cpu', weights_only=True)['model_state_dict'], strict=True)
    model = reference.BallOutput(model).eval()
    with torch.inference_mode():
        traced = torch.jit.trace(model, torch.rand((1, 9, 160, 280)), check_trace=False)
    precision = ct.precision.FLOAT16 if args.precision == 'fp16' else ct.transform.FP16ComputePrecision(
        op_selector=lambda op: op.op_type != 'sigmoid')
    started = time.monotonic()
    converted = ct.convert(
        traced,
        inputs=[ct.TensorType(name='frames', shape=(1, 9, ct.RangeDim(8, 360, 160), ct.RangeDim(8, 640, 280)), dtype=np.float32)],
        outputs=[ct.TensorType(name='heatmaps', dtype=np.float32)],
        convert_to='mlprogram', minimum_deployment_target=ct.target.macOS15,
        compute_precision=precision, compute_units=ct.ComputeUnit.CPU_AND_GPU,
    )
    converted.user_defined_metadata['checkpoint_sha256'] = hashlib.sha256(weights.read_bytes()).hexdigest()
    converted.user_defined_metadata['experiment_precision'] = args.precision
    args.output.mkdir(parents=True, exist_ok=True)
    converted.save(str(args.output / 'BlurBall.mlpackage'))
    (args.output / 'conversion.json').write_text(json.dumps({
        'precision': args.precision, 'seconds': time.monotonic() - started,
        'checkpoint_sha256': converted.user_defined_metadata['checkpoint_sha256'],
        'torch': torch.__version__, 'coremltools': ct.__version__,
        'input_output_dtype': 'float32', 'shape_policy': 'unchanged bounded ranges',
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
