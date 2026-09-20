# Windows 分析与媒体运行时资产

## 随包版本

Windows x64 生产包固定携带：

- Python 3.12.13
- NumPy 2.5.1
- OpenCV 4.13.0.92
- `onnxruntime-directml` 1.24.3
- 支持 `libx264` 的同一套 FFmpeg/ffprobe
- `blurball_best.onnx` 与 `table_analyze.onnx`

构建目录为 `.runtime/windows`，安装后的目录为
`<resources>/windows`。Worker 分别位于 `.runtime/worker` 和
`<resources>/worker`，模型分别位于 `.runtime/resources/models` 和
`<resources>/resources/models`。安装包不包含 PyTorch、CUDA、`.pt`、
TrackNet、OpenH264或模型转换工具。

## 模型转换与清单

在包含受控源权重、Torch、ONNX 和 ONNX Runtime 的离线构建环境执行：

```powershell
python scripts/export-onnx-models.py
node scripts/verify-model-assets.mjs
node scripts/stage-windows-resources.mjs
```

`resources/model-manifest.json` 记录 opset、转换工具版本、ONNX 文件名、
大小、SHA-256、源 `.pt` 哈希及输入输出契约。源 `.pt` 只用于转换和
回归，不进入暂存目录或安装包。转换脚本执行 ONNX checker、CPU 数值
回归、阈值判定、Argmax 和峰值候选门禁。

BlurBall 图使用动态批次与宽高，输出 scale-0 logits。CPU 批次为 4；
DirectML 批次固定为 16，尾批补零并裁剪输出。球桌图输入固定为
`[1,3,896,1600]`，输出为 `[1,4,224,400]`，且只在 CPU provider 上运行。

## 运行时暂存

`scripts/stage-windows-runtime.py` 从受控 Python 3.12.13 基座复制标准库，
明确排除 Torch/TorchGen/Functorch/Triton，再安装固定版本的 NumPy、
OpenCV 和 ONNX Runtime DirectML，并复制 x264 FFmpeg/ffprobe。脚本在
`.runtime/windows/runtime-manifest.json` 写入版本和关键文件哈希，并执行
导入、provider、编码器和 8K 单帧编码检查。

```powershell
python scripts/stage-windows-runtime.py
npm.cmd run stage:release
```

DirectML Session 使用顺序执行、关闭 memory pattern 和图优化。初始化、
运行或非有限输出触发当前模型阶段整体 CPU 重跑，不允许在同一分析结果
中混合 provider。球桌模型不会尝试 DirectML。

## 产品行为

设置页只显示内置分析运行时和 x264 媒体工具的状态，并提供“重新检查”。
缺失或自检失败显示安装损坏提示；应用不会下载、导入或安装组件，也不会
把旧组件目录作为生产回退。全部内置自检成功后，应用只按固定白名单清理
旧运行时、FFmpeg、下载缓存、暂存、回滚和组件清单；任一自检失败则保留
旧数据。

macOS Core ML 和应用版本更新流程不受此文档影响。显式本地 TrackNet 仅在
未打包开发环境通过外部 Python 与外部权重启用。
