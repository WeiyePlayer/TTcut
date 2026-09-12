"""Equivalent token merge expressed with Core ML-convertible primitives.

Only used while tracing. Static destination layout is folded before tracing;
mean reduction is sum / count, including the original destination as PyTorch's
scatter_reduce(include_self=True) does. No model weights or token policy change.
"""
from functools import lru_cache
import numpy as np
import torch

@lru_cache(maxsize=32)
def layout(width, height, stride_x, stride_y):
    gh, gw = height // stride_y, width // stride_x
    index = np.zeros((gh, gw, stride_y * stride_x), dtype=np.int64)
    index[:, :, 0] = -1
    index = index.reshape(gh, gw, stride_y, stride_x).transpose(0, 2, 1, 3).reshape(gh * stride_y, gw * stride_x)
    full = np.zeros((height, width), dtype=np.int64)
    full[:index.shape[0], :index.shape[1]] = index
    order = torch.from_numpy(full.reshape(1, -1, 1)).argsort(dim=1)
    destinations = gh * gw
    return order[:, destinations:, :], order[:, :destinations, :]

def matching(metric, width, height, stride_x, stride_y, removed):
    batch, tokens, _ = metric.shape
    if removed <= 0:
        return lambda value: value, lambda value: value
    source_indices, target_indices = layout(int(width), int(height), int(stride_x), int(stride_y))
    source_indices = source_indices.to(metric.device)
    target_indices = target_indices.to(metric.device)
    destination_count = (height // stride_y) * (width // stride_x)
    def split(value):
        channels = value.shape[-1]
        return (torch.gather(value, 1, source_indices.expand(batch, tokens - destination_count, channels)),
                torch.gather(value, 1, target_indices.expand(batch, destination_count, channels)))
    normalized = metric / metric.norm(dim=-1, keepdim=True).clamp_min(1e-12)
    source_metric, target_metric = split(normalized)
    scores = source_metric @ target_metric.transpose(-1, -2)
    removed = min(source_metric.shape[1], removed)
    node_max, node_index = scores.max(dim=-1)
    edge_index = node_max.argsort(dim=-1, descending=True)[..., None]
    unmerged_indices, merged_indices = edge_index[..., removed:, :], edge_index[..., :removed, :]
    destination_indices = torch.gather(node_index[..., None], -2, merged_indices)
    def merge(value):
        source, target = split(value)
        b, source_tokens, channels = source.shape
        unmerged = torch.gather(source, -2, unmerged_indices.expand(b, source_tokens - removed, channels))
        merged = torch.gather(source, -2, merged_indices.expand(b, removed, channels))
        indices = destination_indices.expand(b, removed, channels)
        summed = target.scatter_add(-2, indices, merged)
        counts = torch.ones_like(target).scatter_add(-2, indices, torch.ones_like(merged))
        target = summed / counts
        return torch.cat([unmerged, target], dim=1)
    def unmerge(value):
        n = unmerged_indices.shape[1]
        unmerged, target = value[..., :n, :], value[..., n:, :]
        channels = unmerged.shape[-1]
        restored = torch.gather(target, -2, destination_indices.expand(batch, removed, channels))
        output = torch.zeros(batch, tokens, channels, device=value.device, dtype=value.dtype)
        output = output.scatter(1, target_indices.expand(batch, destination_count, channels), target)
        output = output.scatter(1, torch.gather(source_indices.expand(batch, source_indices.shape[1], 1), 1, unmerged_indices).expand(batch, n, channels), unmerged)
        output = output.scatter(1, torch.gather(source_indices.expand(batch, source_indices.shape[1], 1), 1, merged_indices).expand(batch, removed, channels), restored)
        return output
    return merge, unmerge
