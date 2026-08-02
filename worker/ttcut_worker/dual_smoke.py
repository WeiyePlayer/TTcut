from __future__ import annotations

import argparse
import json

import torch

from .dual_models import load_dual_models


def main() -> int:
    parser = argparse.ArgumentParser(description="Strict-load and shape-check TTcut dual ball models.")
    parser.add_argument("--main", required=True)
    parser.add_argument("--aux", required=True)
    args = parser.parse_args()
    loaded = load_dual_models(args.main, args.aux, "cuda")
    with torch.inference_mode():
        main_output = loaded.main(torch.zeros((1, 9, 540, 960), device=loaded.device))[0]
        aux_output = loaded.aux(torch.zeros((1, 9, 432, 768), device=loaded.device))[0]
    expected_main = (1, 1, 135, 240)
    expected_aux = (1, 1, 432, 768)
    if tuple(main_output.shape) != expected_main or tuple(aux_output.shape) != expected_aux:
        raise RuntimeError("Dual ball model output shape self-test failed.")
    print(json.dumps({"main": list(main_output.shape), "aux": list(aux_output.shape)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
