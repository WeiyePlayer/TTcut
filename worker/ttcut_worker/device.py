from __future__ import annotations

from typing import Any

from .errors import DeviceError, WeightError


def import_torch() -> Any:
    try:
        import torch
    except ImportError as exc:
        raise WeightError("PyTorch is not installed.") from exc
    return torch


def resolve_device(requested: str) -> Any:
    torch = import_torch()
    if requested not in {"auto", "cuda", "cpu"}:
        raise DeviceError("Device must be auto, cuda, or cpu.")
    if requested == "cuda" and not torch.cuda.is_available():
        raise DeviceError("CUDA was requested but is unavailable.")
    if requested == "auto":
        requested = "cuda" if torch.cuda.is_available() else "cpu"
    return torch.device(requested)
