from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn

from .blurball_model import create_blurball
from .errors import DeviceError, ModelResourceError
from .device import resolve_device


@dataclass(frozen=True)
class LoadedBlurBall:
    model: nn.Module
    device: torch.device
    component_version: str = "1.0.0"


def configure_stable_visibility_inference() -> None:
    # A new worker process performs every analysis. Do not let timing-based
    # cuDNN algorithm selection change threshold-adjacent detections between runs.
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True


def load_blurball(weight_value: str | Path, requested_device: str) -> LoadedBlurBall:
    path = Path(weight_value)
    if not path.is_file():
        raise ModelResourceError(f"BlurBall model is missing: {path}")
    try:
        device = resolve_device(requested_device)
        checkpoint = torch.load(str(path), map_location="cpu", weights_only=False)
        state = checkpoint.get("model_state_dict") if isinstance(checkpoint, dict) else None
        if not isinstance(state, dict):
            raise ModelResourceError(f"BlurBall checkpoint is invalid: {path}")
        model = create_blurball()
        model.load_state_dict(state, strict=True)
        if device.type == "cuda":
            torch.backends.cudnn.benchmark = True
        model.to(device).eval()
        return LoadedBlurBall(model, device)
    except (DeviceError, ModelResourceError):
        raise
    except Exception as exc:
        raise ModelResourceError(
            "BlurBall weights do not strictly match the bundled inference architecture.",
        ) from exc
