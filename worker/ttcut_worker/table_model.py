import math

import torch
import torch.nn as nn
import torch.nn.functional as F


TOME_CONFIGS = (
    {"q_mode": None, "kv_mode": "bsm", "kv_r": 0.6, "kv_sx": 2, "kv_sy": 2},
    {"q_mode": None, "kv_mode": "bsm", "kv_r": 0.6, "kv_sx": 2, "kv_sy": 2},
    {"q_mode": "bsm", "kv_mode": None, "q_r": 0.8, "q_sx": 4, "q_sy": 4},
    {"q_mode": "bsm", "kv_mode": None, "q_r": 0.8, "q_sx": 4, "q_sy": 4},
)


def nlc_to_nchw(tensor, shape):
    height, width = shape
    batch, tokens, channels = tensor.shape
    if tokens != height * width:
        raise ValueError("Token count does not match the feature-map shape")
    return tensor.transpose(1, 2).reshape(batch, channels, height, width)


def nchw_to_nlc(tensor):
    return tensor.flatten(2).transpose(1, 2).contiguous()


def bipartite_soft_matching_random2d(metric, width, height, stride_x, stride_y, removed):
    batch, tokens, _ = metric.shape
    if removed <= 0:
        return lambda value: value, lambda value: value

    grid_height = height // stride_y
    grid_width = width // stride_x
    destination_count = grid_height * grid_width
    index_view = torch.zeros(
        grid_height,
        grid_width,
        stride_y * stride_x,
        device=metric.device,
        dtype=torch.int64,
    )
    destination_index = torch.zeros(
        grid_height,
        grid_width,
        1,
        device=metric.device,
        dtype=torch.int64,
    )
    index_view.scatter_(2, destination_index, -torch.ones_like(destination_index))
    index_view = (
        index_view.view(grid_height, grid_width, stride_y, stride_x)
        .transpose(1, 2)
        .reshape(grid_height * stride_y, grid_width * stride_x)
    )
    if grid_height * stride_y < height or grid_width * stride_x < width:
        index_buffer = torch.zeros(height, width, device=metric.device, dtype=torch.int64)
        index_buffer[: grid_height * stride_y, : grid_width * stride_x] = index_view
    else:
        index_buffer = index_view

    ordered_indices = index_buffer.reshape(1, -1, 1).argsort(dim=1)
    source_indices = ordered_indices[:, destination_count:, :]
    target_indices = ordered_indices[:, :destination_count, :]

    def split(value):
        channels = value.shape[-1]
        source = torch.gather(
            value,
            1,
            source_indices.expand(batch, tokens - destination_count, channels),
        )
        target = torch.gather(
            value,
            1,
            target_indices.expand(batch, destination_count, channels),
        )
        return source, target

    normalized = metric / metric.norm(dim=-1, keepdim=True).clamp_min(1e-12)
    source_metric, target_metric = split(normalized)
    scores = source_metric @ target_metric.transpose(-1, -2)
    removed = min(source_metric.shape[1], removed)
    node_max, node_index = scores.max(dim=-1)
    edge_index = node_max.argsort(dim=-1, descending=True)[..., None]
    unmerged_indices = edge_index[..., removed:, :]
    merged_indices = edge_index[..., :removed, :]
    destination_indices = torch.gather(node_index[..., None], -2, merged_indices)

    def merge(value):
        source, target = split(value)
        current_batch, source_tokens, channels = source.shape
        unmerged = torch.gather(
            source,
            -2,
            unmerged_indices.expand(current_batch, source_tokens - removed, channels),
        )
        merged = torch.gather(
            source,
            -2,
            merged_indices.expand(current_batch, removed, channels),
        )
        target = target.scatter_reduce(
            -2,
            destination_indices.expand(current_batch, removed, channels),
            merged,
            reduce="mean",
        )
        return torch.cat([unmerged, target], dim=1)

    def unmerge(value):
        unmerged_count = unmerged_indices.shape[1]
        unmerged, target = value[..., :unmerged_count, :], value[..., unmerged_count:, :]
        _, _, channels = unmerged.shape
        restored_source = torch.gather(
            target,
            -2,
            destination_indices.expand(batch, removed, channels),
        )
        output = torch.zeros(batch, tokens, channels, device=value.device, dtype=value.dtype)
        output.scatter_(1, target_indices.expand(batch, destination_count, channels), target)
        output.scatter_(
            1,
            torch.gather(
                source_indices.expand(batch, source_indices.shape[1], 1),
                1,
                unmerged_indices,
            ).expand(batch, unmerged_count, channels),
            unmerged,
        )
        output.scatter_(
            1,
            torch.gather(
                source_indices.expand(batch, source_indices.shape[1], 1),
                1,
                merged_indices,
            ).expand(batch, removed, channels),
            restored_source,
        )
        return output

    return merge, unmerge


class DropPath(nn.Module):
    def __init__(self, probability=0.0):
        super().__init__()
        self.probability = float(probability)

    def forward(self, tensor):
        if self.probability == 0.0 or not self.training:
            return tensor
        keep_probability = 1.0 - self.probability
        shape = (tensor.shape[0],) + (1,) * (tensor.ndim - 1)
        random_tensor = keep_probability + torch.rand(shape, dtype=tensor.dtype, device=tensor.device)
        return tensor.div(keep_probability) * random_tensor.floor()


class PatchEmbed(nn.Module):
    def __init__(self, in_channels, embed_dims, kernel_size, stride):
        super().__init__()
        self.projection = nn.Conv2d(
            in_channels,
            embed_dims,
            kernel_size=kernel_size,
            stride=stride,
            padding=kernel_size // 2,
            bias=True,
        )
        self.norm = nn.LayerNorm(embed_dims, eps=1e-6)

    def forward(self, tensor):
        tensor = self.projection(tensor)
        shape = tensor.shape[2:]
        tensor = tensor.flatten(2).transpose(1, 2)
        return self.norm(tensor), shape


class MixFFN(nn.Module):
    def __init__(self, embed_dims, feedforward_channels, drop_probability):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(embed_dims, feedforward_channels, 1, bias=True),
            nn.Conv2d(
                feedforward_channels,
                feedforward_channels,
                3,
                padding=1,
                groups=feedforward_channels,
                bias=True,
            ),
            nn.GELU(),
            nn.Dropout(0.0),
            nn.Conv2d(feedforward_channels, embed_dims, 1, bias=True),
            nn.Dropout(0.0),
        )
        self.dropout_layer = DropPath(drop_probability)

    def forward(self, tensor, shape, identity):
        output = nlc_to_nchw(tensor, shape)
        output = nchw_to_nlc(self.layers(output))
        return identity + self.dropout_layer(output)


class EfficientMultiheadAttention(nn.Module):
    def __init__(self, embed_dims, num_heads, spatial_reduction, tome_config, drop_probability):
        super().__init__()
        self.attn = nn.MultiheadAttention(embed_dims, num_heads, dropout=0.0, bias=True)
        self.proj_drop = nn.Dropout(0.0)
        self.dropout_layer = DropPath(drop_probability)
        self.spatial_reduction = spatial_reduction
        self.tome_config = tome_config
        if spatial_reduction > 1:
            self.sr = nn.Conv2d(
                embed_dims,
                embed_dims,
                kernel_size=spatial_reduction,
                stride=spatial_reduction,
                bias=True,
            )
            self.norm = nn.LayerNorm(embed_dims, eps=1e-6)

    def forward(self, tensor, shape, identity):
        query = tensor
        if self.spatial_reduction > 1:
            key_value = self.sr(nlc_to_nchw(tensor, shape))
            key_value = self.norm(nchw_to_nlc(key_value))
        else:
            key_value = tensor

        if self.tome_config["kv_mode"] == "bsm":
            reduced_width = shape[1] // self.spatial_reduction
            reduced_height = shape[0] // self.spatial_reduction
            merge, _ = bipartite_soft_matching_random2d(
                key_value,
                reduced_width,
                reduced_height,
                self.tome_config["kv_sx"],
                self.tome_config["kv_sy"],
                int(key_value.shape[1] * self.tome_config["kv_r"]),
            )
            key_value = merge(key_value)

        unmerge = None
        if self.tome_config["q_mode"] == "bsm":
            merge, unmerge = bipartite_soft_matching_random2d(
                query,
                shape[1],
                shape[0],
                self.tome_config["q_sx"],
                self.tome_config["q_sy"],
                int(query.shape[1] * self.tome_config["q_r"]),
            )
            query = merge(query)

        output = self.attn(
            query=query.transpose(0, 1),
            key=key_value.transpose(0, 1),
            value=key_value.transpose(0, 1),
            need_weights=False,
        )[0].transpose(0, 1)
        if unmerge is not None:
            output = unmerge(output)
        return identity + self.dropout_layer(self.proj_drop(output))


class TransformerEncoderLayer(nn.Module):
    def __init__(
        self,
        embed_dims,
        num_heads,
        spatial_reduction,
        tome_config,
        drop_probability,
    ):
        super().__init__()
        self.norm1 = nn.LayerNorm(embed_dims, eps=1e-6)
        self.attn = EfficientMultiheadAttention(
            embed_dims,
            num_heads,
            spatial_reduction,
            tome_config,
            drop_probability,
        )
        self.norm2 = nn.LayerNorm(embed_dims, eps=1e-6)
        self.ffn = MixFFN(embed_dims, embed_dims * 4, drop_probability)

    def forward(self, tensor, shape):
        tensor = self.attn(self.norm1(tensor), shape, identity=tensor)
        return self.ffn(self.norm2(tensor), shape, identity=tensor)


class MixVisionTransformer(nn.Module):
    def __init__(self):
        super().__init__()
        embed_dims = (64, 128, 320, 512)
        layer_counts = (3, 4, 6, 3)
        head_counts = (1, 2, 5, 8)
        patch_sizes = (7, 3, 3, 3)
        strides = (4, 2, 2, 2)
        spatial_reductions = (8, 4, 2, 1)
        drop_probabilities = torch.linspace(0.0, 0.1, sum(layer_counts)).tolist()
        current = 0
        in_channels = 3
        stages = []
        for stage_index, layer_count in enumerate(layer_counts):
            patch_embed = PatchEmbed(
                in_channels,
                embed_dims[stage_index],
                patch_sizes[stage_index],
                strides[stage_index],
            )
            blocks = nn.ModuleList(
                TransformerEncoderLayer(
                    embed_dims[stage_index],
                    head_counts[stage_index],
                    spatial_reductions[stage_index],
                    TOME_CONFIGS[stage_index],
                    drop_probabilities[current + block_index],
                )
                for block_index in range(layer_count)
            )
            norm = nn.LayerNorm(embed_dims[stage_index], eps=1e-6)
            stages.append(nn.ModuleList([patch_embed, blocks, norm]))
            current += layer_count
            in_channels = embed_dims[stage_index]
        self.layers = nn.ModuleList(stages)

    def forward(self, tensor):
        outputs = []
        for patch_embed, blocks, norm in self.layers:
            tensor, shape = patch_embed(tensor)
            for block in blocks:
                tensor = block(tensor, shape)
            tensor = norm(tensor)
            tensor = nlc_to_nchw(tensor, shape)
            outputs.append(tensor)
        return outputs


class ConvModule(nn.Module):
    def __init__(self, in_channels, out_channels):
        super().__init__()
        self.conv = nn.Conv2d(in_channels, out_channels, 1, bias=False)
        self.bn = nn.SyncBatchNorm(out_channels)
        self.activate = nn.ReLU(inplace=True)

    def forward(self, tensor):
        return self.activate(self.bn(self.conv(tensor)))


class SegformerHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv_seg = nn.Conv2d(256, 13, 1)
        self.dropout = nn.Dropout2d(0.1)
        self.convs = nn.ModuleList(
            ConvModule(in_channels, 256) for in_channels in (64, 128, 320, 512)
        )
        self.fusion_conv = ConvModule(1024, 256)

    def forward(self, inputs):
        target_size = inputs[0].shape[2:]
        outputs = [
            F.interpolate(
                conv(tensor),
                size=target_size,
                mode="bilinear",
                align_corners=False,
            )
            for conv, tensor in zip(self.convs, inputs)
        ]
        return self.conv_seg(self.dropout(self.fusion_conv(torch.cat(outputs, dim=1))))


class SegFormer(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = MixVisionTransformer()
        self.decode_head = SegformerHead()

    def forward(self, tensor):
        return self.decode_head(self.backbone(tensor))


class FixedTableModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.model = SegFormer()

    def forward(self, tensor):
        return self.model(tensor)
