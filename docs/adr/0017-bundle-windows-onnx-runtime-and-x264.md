# ADR 0017: Bundle the Windows ONNX Runtime and x264 Media Tools

## Status

Accepted; supersedes ADR 0001 for Windows production packages.

## Context

Downloading Python/PyTorch, CUDA, models, and an optional encoder after install
made first analysis network-dependent and created several mutable component
states. Python is not covered by the self-contained Windows ML deployment mode
documented for C#, C++, and C, so the application still needs a Python runtime.

## Decision

Windows x64 packages contain two FP32 opset-20 graphs,
`blurball_best.onnx` and `table_analyze.onnx`, plus Python 3.12.13, NumPy
2.5.1, OpenCV 4.13.0.92, and `onnxruntime-directml` 1.24.3. PyTorch, CUDA,
source `.pt` files, conversion tools, and TrackNet files are excluded.

The table model has fixed input `[1,3,896,1600]` and always uses the CPU
provider. BlurBall has dynamic spatial axes. CPU uses batches of four.
DirectML starts at batch sixteen and, after a failed inference, discards that
attempt and restarts the analysis entrypoint at batches eight, four, and two.
If batch two fails, it restarts on CPU. Every DirectML tail is padded to the
active attempt's batch size before its output is trimmed.
DirectML sessions use sequential execution, disable memory patterns, and
disable graph optimization to avoid the ORT 1.24.3 invalid bias-free Gemm
fusion. DirectML initialization failures skip batch retries and restart on CPU.
Every retry discards partial output and starts from the analysis entrypoint.
Provenance records the successful provider and batch size, runtime, model hash,
and any fallback reason.

The package also contains one FFmpeg/ffprobe build with `libx264`. Windows
preprocessing, clipping, preview, and export resolve that same pair and encode
with `libx264`; there is no production OpenH264 fallback.

Settings exposes read-only built-in component status and a recheck action.
There are no model/runtime/media download, import, or install APIs. A successful
built-in self-check permits exact-whitelist cleanup of legacy component data;
a failed check preserves it but never uses it for production analysis.

The conversion gate checks the ONNX graph, CPU inference, numerical and
decision parity, and DirectML compatibility. The build gate verifies hashes,
rejects `.pt`, Torch, CUDA, TrackNet, OpenH264, and download resources, and
performs an x264 capability smoke test. Package size is recorded but has no
hard upper bound.

## Consequences

First analysis and export work offline on a clean supported Windows x64
installation. The installer is larger, but runtime identity is deterministic
and users no longer manage GPU or clipping components. DirectML remains an
optimization rather than a correctness dependency because CPU restarts the
complete failed stage. The explicit external-Python TrackNet route remains a
development-only source-tree feature. macOS Core ML is unchanged.
