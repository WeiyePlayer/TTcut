# ADR 0001: Bundle Fixed Analysis Models

## Status

Accepted

## Context

Automatic table calibration and rally analysis require three fixed model
checkpoints. A download-only model path leaves the application unable to
analyse video until network setup succeeds.

## Decision

Bundle `analyze.pt`, `blurball_best.pt`, and `table_analyze.pt` with the application resources.
Keep the Python and PyTorch analysis runtime as a separately managed,
on-demand component. Store model metadata in `resources/model-manifest.json`
and require exact size and SHA-256 verification before packaging.

## Consequences

The installer package grows by approximately 241 MB and analysis models are
available offline after installation. Build machines must provide the three
controlled local checkpoint paths through `TTCUT_TRACKNET_SOURCE`,
`TTCUT_BLURBALL_SOURCE`, and `TTCUT_TABLE_ANALYZE_SOURCE`.
