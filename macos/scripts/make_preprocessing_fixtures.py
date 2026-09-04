#!/usr/bin/env python3
"""Reference preprocessing/postprocessing using the original Python functions."""
import json, sys
from pathlib import Path
import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))
from ttcut_worker.blurball_predictor import _affine_transforms, _prepare_frame, _decode_heatmap
from ttcut_worker.table_analyze import _preprocess

width, height = 64, 48
image = np.fromfunction(lambda y, x, c: (x * 17 + y * 29 + c * 71) % 256,
                        (height, width, 3), dtype=int).astype(np.uint8)
forward, inverse = _affine_transforms(57, 40, 40, 24)
blur = _prepare_frame(image[4:44, 3:60], forward, 40, 24).reshape(-1)
table = _preprocess(image, torch.device("cpu")).numpy().reshape(-1)
indices = sorted(set([0, 1599, 1600, 1600*896-1, len(table)-1] +
                     np.random.default_rng(481).integers(0, len(table), 1024).tolist()))
heat = np.zeros((24, 40), dtype=np.float32)
for y, x, value in [(1, 1, .5), (2, 2, .7), (2, 3, .9), (12, 20, .8), (13, 20, .6),
                    (20, 38, .51), (21, 39, .99), (9, 8, .3)]:
    heat[y, x] = value
doc = dict(blur=blur.tolist(), tableIndices=indices, tableValues=table[indices].tolist(),
           heatmap=heat.reshape(-1).tolist(), detections=_decode_heatmap(heat, inverse, 3, 4, .5))
destination = ROOT / "macos/Tests/Media/Fixtures/preprocessing.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
print(f"Wrote {len(blur)} BlurBall floats, {len(indices)} table samples, {len(doc['detections'])} detections")
