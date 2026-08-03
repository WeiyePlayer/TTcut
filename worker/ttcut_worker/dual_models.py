from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import torch
import torch.nn as nn
import torch.nn.functional as F

from .errors import DeviceError, ModelResourceError
from .wasb import WASBNet


def _nchw_to_nlc(value: torch.Tensor) -> torch.Tensor:
    return value.flatten(2).transpose(1, 2).contiguous()


def _nlc_to_nchw(value: torch.Tensor, shape: tuple[int, int]) -> torch.Tensor:
    height, width = shape
    return value.transpose(1, 2).reshape(value.shape[0], value.shape[2], height, width)


def _do_nothing(value: torch.Tensor, mode: str | None = None) -> torch.Tensor:
    del mode
    return value


def _bipartite_soft_matching_random2d(
    metric: torch.Tensor,
    width: int,
    height: int,
    stride_x: int,
    stride_y: int,
    remove: int,
) -> tuple[Callable[[torch.Tensor, str], torch.Tensor], Callable[[torch.Tensor], torch.Tensor]]:
    batch, token_count, _ = metric.shape
    if remove <= 0:
        return _do_nothing, _do_nothing
    grid_height, grid_width = height // stride_y, width // stride_x
    with torch.no_grad():
        index_view = torch.zeros(
            grid_height, grid_width, stride_y * stride_x,
            device=metric.device, dtype=torch.int64,
        )
        index_view[..., :1] = -1
        index_view = index_view.view(grid_height, grid_width, stride_y, stride_x)
        index_view = index_view.transpose(1, 2).reshape(grid_height * stride_y, grid_width * stride_x)
        if grid_height * stride_y < height or grid_width * stride_x < width:
            index_buffer = torch.zeros(height, width, device=metric.device, dtype=torch.int64)
            index_buffer[:grid_height * stride_y, :grid_width * stride_x] = index_view
        else:
            index_buffer = index_view
        ordered = index_buffer.reshape(1, -1, 1).argsort(dim=1)
        destination_count = grid_height * grid_width
        source_index = ordered[:, destination_count:, :]
        destination_index = ordered[:, :destination_count, :]

        def split(value: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
            channels = value.shape[-1]
            source = torch.gather(value, 1, source_index.expand(batch, token_count - destination_count, channels))
            destination = torch.gather(value, 1, destination_index.expand(batch, destination_count, channels))
            return source, destination

        normalized = metric / metric.norm(dim=-1, keepdim=True)
        source_metric, destination_metric = split(normalized)
        scores = source_metric @ destination_metric.transpose(-1, -2)
        remove = min(source_metric.shape[1], remove)
        node_score, node_destination = scores.max(dim=-1)
        edge_index = node_score.argsort(dim=-1, descending=True)[..., None]
        unmerged_index = edge_index[..., remove:, :]
        merged_index = edge_index[..., :remove, :]
        merged_destination = torch.gather(node_destination[..., None], -2, merged_index)

    def merge(value: torch.Tensor, mode: str = "mean") -> torch.Tensor:
        source, destination = split(value)
        current_batch, source_count, channels = source.shape
        unmerged = torch.gather(source, -2, unmerged_index.expand(current_batch, source_count - remove, channels))
        selected = torch.gather(source, -2, merged_index.expand(current_batch, remove, channels))
        destination = destination.scatter_reduce(-2, merged_destination.expand(current_batch, remove, channels), selected, reduce=mode)
        return torch.cat([unmerged, destination], dim=1)

    def unmerge(value: torch.Tensor) -> torch.Tensor:
        unmerged_count = unmerged_index.shape[1]
        unmerged, destination = value[..., :unmerged_count, :], value[..., unmerged_count:, :]
        channels = unmerged.shape[-1]
        selected = torch.gather(destination, -2, merged_destination.expand(batch, remove, channels))
        output = torch.zeros(batch, token_count, channels, device=value.device, dtype=value.dtype)
        output.scatter_(-2, destination_index.expand(batch, destination_count, channels), destination)
        output.scatter_(-2, torch.gather(source_index.expand(batch, source_index.shape[1], 1), 1, unmerged_index).expand(batch, unmerged_count, channels), unmerged)
        output.scatter_(-2, torch.gather(source_index.expand(batch, source_index.shape[1], 1), 1, merged_index).expand(batch, remove, channels), selected)
        return output

    return merge, unmerge


class PatchEmbed(nn.Module):
    def __init__(self, input_channels: int, output_channels: int, kernel: int, stride: int):
        super().__init__()
        self.projection = nn.Conv2d(input_channels, output_channels, kernel, stride, kernel // 2, bias=True)
        self.norm = nn.LayerNorm(output_channels, eps=1e-6)

    def forward(self, value: torch.Tensor) -> tuple[torch.Tensor, tuple[int, int]]:
        value = self.projection(value)
        shape = (value.shape[2], value.shape[3])
        return self.norm(_nchw_to_nlc(value)), shape


class EfficientAttention(nn.Module):
    def __init__(self, dimensions: int, heads: int, reduction: int, tome: dict[str, Any]):
        super().__init__()
        self.attn = nn.MultiheadAttention(dimensions, heads, bias=True, batch_first=False)
        self.sr_ratio = reduction
        self.tome = tome
        if reduction > 1:
            self.sr = nn.Conv2d(dimensions, dimensions, reduction, reduction, bias=True)
            self.norm = nn.LayerNorm(dimensions, eps=1e-6)
        self.proj_drop = nn.Identity()
        self.dropout_layer = nn.Identity()

    def forward(self, value: torch.Tensor, shape: tuple[int, int], identity: torch.Tensor) -> torch.Tensor:
        query = value
        if self.sr_ratio > 1:
            keys = self.norm(_nchw_to_nlc(self.sr(_nlc_to_nchw(value, shape))))
        else:
            keys = value
        query_unmerge: Callable[[torch.Tensor], torch.Tensor] | None = None
        if self.tome.get("kv_mode") == "bsm":
            key_height = shape[0] // self.sr_ratio
            key_width = shape[1] // self.sr_ratio
            key_merge, _ = _bipartite_soft_matching_random2d(
                keys, key_width, key_height,
                int(self.tome["kv_sx"]), int(self.tome["kv_sy"]),
                int(keys.shape[1] * float(self.tome["kv_r"])),
            )
            keys = key_merge(keys, "mean")
        if self.tome.get("q_mode") == "bsm":
            query_merge, query_unmerge = _bipartite_soft_matching_random2d(
                query, shape[1], shape[0],
                int(self.tome["q_sx"]), int(self.tome["q_sy"]),
                int(query.shape[1] * float(self.tome["q_r"])),
            )
            query = query_merge(query, "mean")
        output = self.attn(query.transpose(0, 1), keys.transpose(0, 1), keys.transpose(0, 1), need_weights=False)[0].transpose(0, 1)
        if query_unmerge is not None:
            output = query_unmerge(output)
        return identity + self.dropout_layer(self.proj_drop(output))


class MixFFN(nn.Module):
    def __init__(self, dimensions: int):
        super().__init__()
        hidden = dimensions * 4
        self.layers = nn.Sequential(
            nn.Conv2d(dimensions, hidden, 1, bias=True),
            nn.Conv2d(hidden, hidden, 3, padding=1, groups=hidden, bias=True),
            nn.GELU(), nn.Dropout(0.0),
            nn.Conv2d(hidden, dimensions, 1, bias=True), nn.Dropout(0.0),
        )
        self.dropout_layer = nn.Identity()

    def forward(self, value: torch.Tensor, shape: tuple[int, int], identity: torch.Tensor) -> torch.Tensor:
        output = _nchw_to_nlc(self.layers(_nlc_to_nchw(value, shape)))
        return identity + self.dropout_layer(output)


class TransformerBlock(nn.Module):
    def __init__(self, dimensions: int, heads: int, reduction: int, tome: dict[str, Any]):
        super().__init__()
        self.norm1 = nn.LayerNorm(dimensions, eps=1e-6)
        self.attn = EfficientAttention(dimensions, heads, reduction, tome)
        self.norm2 = nn.LayerNorm(dimensions, eps=1e-6)
        self.ffn = MixFFN(dimensions)

    def forward(self, value: torch.Tensor, shape: tuple[int, int]) -> torch.Tensor:
        value = self.attn(self.norm1(value), shape, value)
        return self.ffn(self.norm2(value), shape, value)


class MixVisionTransformerB2(nn.Module):
    def __init__(self):
        super().__init__()
        dimensions = [64, 128, 320, 512]
        heads = [1, 2, 5, 8]
        depths = [3, 4, 6, 3]
        reductions = [8, 4, 2, 1]
        tome = [
            {"kv_mode": "bsm", "kv_r": 0.6, "kv_sx": 2, "kv_sy": 2},
            {"kv_mode": "bsm", "kv_r": 0.6, "kv_sx": 2, "kv_sy": 2},
            {"q_mode": "bsm", "q_r": 0.8, "q_sx": 4, "q_sy": 4},
            {"q_mode": "bsm", "q_r": 0.8, "q_sx": 4, "q_sy": 4},
        ]
        stages = []
        input_channels = 9
        for index, output_channels in enumerate(dimensions):
            patch = PatchEmbed(input_channels, output_channels, 7 if index == 0 else 3, 4 if index == 0 else 2)
            blocks = nn.ModuleList([
                TransformerBlock(output_channels, heads[index], reductions[index], tome[index])
                for _ in range(depths[index])
            ])
            stages.append(nn.ModuleList([patch, blocks, nn.LayerNorm(output_channels, eps=1e-6)]))
            input_channels = output_channels
        self.layers = nn.ModuleList(stages)

    def forward(self, value: torch.Tensor) -> list[torch.Tensor]:
        outputs = []
        for patch, blocks, norm in self.layers:
            value, shape = patch(value)
            for block in blocks:
                value = block(value, shape)
            value = norm(value)
            value = _nlc_to_nchw(value, shape)
            outputs.append(value)
        return outputs


class ConvSyncBnRelu(nn.Module):
    def __init__(self, input_channels: int, output_channels: int):
        super().__init__()
        self.conv = nn.Conv2d(input_channels, output_channels, 1, bias=False)
        self.bn = nn.SyncBatchNorm(output_channels)
        self.activate = nn.ReLU(inplace=True)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.activate(self.bn(self.conv(value)))


class SegformerHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.in_channels = [64, 128, 320, 512]
        self.conv_seg = nn.Conv2d(256, 1, 1)
        self.dropout = nn.Dropout2d(0.1)
        self.convs = nn.ModuleList([ConvSyncBnRelu(channels, 256) for channels in self.in_channels])
        self.fusion_conv = ConvSyncBnRelu(1024, 256)

    def forward(self, inputs: list[torch.Tensor]) -> torch.Tensor:
        target = inputs[0].shape[2:]
        outputs = [F.interpolate(conv(value), size=target, mode="bilinear", align_corners=False) for conv, value in zip(self.convs, inputs)]
        return self.conv_seg(self.dropout(self.fusion_conv(torch.cat(outputs, dim=1))))


class FixedSegformer(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = MixVisionTransformerB2()
        self.decode_head = SegformerHead()

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.decode_head(self.backbone(value))


class SegformerPPB2(nn.Module):
    def __init__(self):
        super().__init__()
        self.model = FixedSegformer()

    def forward(self, value: torch.Tensor) -> tuple[torch.Tensor, None]:
        return self.model(value), None


@dataclass(frozen=True)
class LoadedDualModels:
    main: nn.Module
    aux: nn.Module
    device: torch.device
    component_version: str = "1.0.0"


def _load_checkpoint(path: Path, expected_model: str) -> dict[str, torch.Tensor]:
    if not path.is_file():
        raise ModelResourceError(f"Dual ball model is missing: {path}")
    checkpoint = torch.load(str(path), map_location="cpu", weights_only=False)
    state = checkpoint.get("model_state_dict") if isinstance(checkpoint, dict) else None
    info = checkpoint.get("additional_info") if isinstance(checkpoint, dict) else None
    if not isinstance(state, dict) or not isinstance(info, dict):
        raise ModelResourceError(f"Dual ball model checkpoint is invalid: {path}")
    if info.get("model_name") != expected_model or info.get("in_frames") != 3:
        raise ModelResourceError(f"Dual ball model identity is invalid: {path}")
    return state


def load_dual_models(main_path: str | Path, aux_path: str | Path, requested_device: str) -> LoadedDualModels:
    if requested_device not in {"auto", "cuda"} or not torch.cuda.is_available():
        raise DeviceError("The Uplifting dual ball model profile requires CUDA.")
    device = torch.device("cuda")
    try:
        main = SegformerPPB2()
        aux = WASBNet(in_frames=3, resolution=(768, 432), pretraining=False, classify_invisible=False)
        main.load_state_dict(_load_checkpoint(Path(main_path), "segformerpp_b2"), strict=True)
        aux.load_state_dict(_load_checkpoint(Path(aux_path), "wasb"), strict=True)
        main.to(device).eval()
        aux.to(device).eval()
        return LoadedDualModels(main, aux, device)
    except (DeviceError, ModelResourceError):
        raise
    except Exception as exc:
        raise ModelResourceError("Dual ball model weights do not strictly match the offline inference architecture.") from exc
