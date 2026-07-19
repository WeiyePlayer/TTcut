from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import DeviceError, WeightError


def import_torch():
    try:
        import torch
    except ImportError as exc:
        raise WeightError("PyTorch is not installed.") from exc
    return torch


def create_tracknet(seq_len: int, bg_mode: str):
    torch = import_torch()
    nn = torch.nn

    class Conv2DBlock(nn.Module):
        def __init__(self, in_dim: int, out_dim: int):
            super().__init__()
            self.conv = nn.Conv2d(in_dim, out_dim, 3, padding="same", bias=False)
            self.bn = nn.BatchNorm2d(out_dim)
            self.relu = nn.ReLU()

        def forward(self, x):
            return self.relu(self.bn(self.conv(x)))

    class Double2DConv(nn.Module):
        def __init__(self, in_dim: int, out_dim: int):
            super().__init__()
            self.conv_1 = Conv2DBlock(in_dim, out_dim)
            self.conv_2 = Conv2DBlock(out_dim, out_dim)

        def forward(self, x):
            return self.conv_2(self.conv_1(x))

    class Triple2DConv(nn.Module):
        def __init__(self, in_dim: int, out_dim: int):
            super().__init__()
            self.conv_1 = Conv2DBlock(in_dim, out_dim)
            self.conv_2 = Conv2DBlock(out_dim, out_dim)
            self.conv_3 = Conv2DBlock(out_dim, out_dim)

        def forward(self, x):
            return self.conv_3(self.conv_2(self.conv_1(x)))

    if bg_mode == "subtract":
        in_dim = seq_len
    elif bg_mode == "subtract_concat":
        in_dim = seq_len * 4
    elif bg_mode == "concat":
        in_dim = (seq_len + 1) * 3
    elif bg_mode in ("", None):
        in_dim = seq_len * 3
    else:
        raise WeightError(f"Unsupported TrackNet background mode: {bg_mode}")

    class TrackNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.down_block_1 = Double2DConv(in_dim, 64)
            self.down_block_2 = Double2DConv(64, 128)
            self.down_block_3 = Triple2DConv(128, 256)
            self.bottleneck = Triple2DConv(256, 512)
            self.up_block_1 = Triple2DConv(768, 256)
            self.up_block_2 = Double2DConv(384, 128)
            self.up_block_3 = Double2DConv(192, 64)
            self.predictor = nn.Conv2d(64, seq_len, 1)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            x1 = self.down_block_1(x)
            x = nn.MaxPool2d(2, 2)(x1)
            x2 = self.down_block_2(x)
            x = nn.MaxPool2d(2, 2)(x2)
            x3 = self.down_block_3(x)
            x = nn.MaxPool2d(2, 2)(x3)
            x = self.bottleneck(x)
            x = self.up_block_1(torch.cat([nn.Upsample(scale_factor=2)(x), x3], dim=1))
            x = self.up_block_2(torch.cat([nn.Upsample(scale_factor=2)(x), x2], dim=1))
            x = self.up_block_3(torch.cat([nn.Upsample(scale_factor=2)(x), x1], dim=1))
            return self.sigmoid(self.predictor(x))

    return TrackNet()


def resolve_device(requested: str):
    torch = import_torch()
    if requested not in {"auto", "cuda", "cpu"}:
        raise DeviceError("Device must be auto, cuda, or cpu.")
    if requested == "cuda" and not torch.cuda.is_available():
        raise DeviceError("CUDA was requested but is unavailable.")
    if requested == "auto":
        requested = "cuda" if torch.cuda.is_available() else "cpu"
    return torch.device(requested)


@dataclass(frozen=True)
class LoadedTrackNet:
    model: Any
    seq_len: int
    bg_mode: str
    device: Any


def load_tracknet(weight_value: str | Path, requested_device: str) -> LoadedTrackNet:
    torch = import_torch()
    path = Path(weight_value).expanduser()
    if not path.is_file():
        raise WeightError(f"TrackNet weight is missing: {path}")
    try:
        checkpoint = torch.load(str(path), map_location="cpu", weights_only=False)
        params = checkpoint.get("param_dict")
        state = checkpoint.get("model") or checkpoint.get("state_dict")
        if not isinstance(params, dict) or not isinstance(state, dict):
            raise ValueError("checkpoint fields are missing")
        seq_len = int(params["seq_len"])
        bg_mode = str(params.get("bg_mode", "") or "")
        device = resolve_device(requested_device)
        model = create_tracknet(seq_len, bg_mode)
        model.load_state_dict(state, strict=True)
        model.to(device).eval()
        return LoadedTrackNet(model, seq_len, bg_mode, device)
    except WorkerError:
        raise
    except Exception as exc:
        raise WeightError(f"TrackNet checkpoint is invalid: {path}") from exc


from .errors import WorkerError  # noqa: E402

