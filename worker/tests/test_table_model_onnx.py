from __future__ import annotations

import torch

from ttcut_worker.table_model import scatter_mean_include_self


def test_scatter_mean_include_self_matches_pytorch_scatter_reduce() -> None:
    generator = torch.Generator().manual_seed(20260920)
    target = torch.randn((2, 5, 3), generator=generator)
    values = torch.randn((2, 7, 3), generator=generator)
    destinations = torch.randint(0, 5, (2, 7, 1), generator=generator)

    expected = target.scatter_reduce(
        -2,
        destinations.expand(-1, -1, target.shape[-1]),
        values,
        reduce="mean",
    )
    actual = scatter_mean_include_self(target, destinations, values)

    torch.testing.assert_close(actual, expected, rtol=0, atol=0)
