# Windows 1.3.3 零回合调查与修复

## 结论与证据边界

用户补充的实际提示是“没有识别到有效回合，可以重新标定球桌，或选择另一个视频”，运行模式为 GPU，显卡 GTX 1660 Super。该提示来自分析完成后的空结果页，不是 HDR 导入拦截。

已确认的代码缺陷：Windows BlurBall 对所有 CUDA 设备启用 FP16，且 `_decode_heatmap` 遇到 NaN/Inf 时返回空检测。数值异常因此可以被保存成分析成功、零回合。故障注入已复现旧代码的静默空结果，并验证修复后报告 `INFERENCE_FAILED`。

最有依据的用户故障原因是 GTX 1660 Super 的 FP16 兼容性异常。Ultralytics 的[当前兼容性检查](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/utils/checks.py)明确对 GTX 1660/1650/1630 等型号禁用 AMP，以规避 NaN 或零检测结果；PyTorch 官方论坛也有[GTX 1660 Ti 半精度卷积产生 NaN 的实际报告](https://discuss.pytorch.org/t/half-precision-convolution-cause-nan-in-forward-pass/117358)。这是外部兼容性依据，不是这台电脑的实测证明。旧 TTcut 日志没有模型数值、实际精度和检出帧数，当前机器没有 NVIDIA GPU，因此尚不能声称已在该用户的 1660 Super 上闭环复现。

## 用户材料

- `logs(2).zip` 的自动标定任务 `0223a910-54a8-4528-965d-cedd75b0bc42` 明确失败于跨帧球桌几何一致性；本机对两份视频的自动标定也复现此失败。
- 原视频随后以手动标定完成任务 `9c5c6215-2a34-4aaf-821f-33c8b9f3d8fd`，完整解码 31220 帧，回合数 0，模型输入 640×360，分析区域为整个 1920×1080 画面。
- 另一视频任务 `11dbcf1d-79af-4218-b55d-cdb0ecd85c96` 完整解码 18478 帧，回合数 0，模型输入 392×144。未收到这份原视频，无法验证它的 HDR 状态或实际回合。
- `无法识别有效回合.mp4` 是 960×544、20 fps、H.264、8 bit BT.709 SDR 版本。
- 用户更正的 `无法识别原画.mp4` 是 1920×1080、约 29.996 fps、HEVC Main10、HLG/BT.2020，并有帧级 Dolby Vision RPU/Metadata。它并非 HDR10。原画与日志 MOV 的帧数、分辨率和帧率相符，但没有收到原 MOV，不能证明容器/元数据完全相同。

当前 Windows probe 不拦截 HDR。macOS 的动态 HDR 拦截是另一条原生媒体路径，未据本次零回合反馈修改该策略。

## 修复

1. 已知风险型号在 BlurBall 中直接使用 CUDA FP32，默认批次 4；按实际显卡完整型号匹配，不按同属 7.5 的计算能力误伤 RTX，也不把 T4/RTX 4000 当成 T400。CPU 和普通 RTX 的既有精度策略保留。完整型号范围见下节。
2. 在 sigmoid 前验证 logits 的有限性，避免 Inf 被 sigmoid 变成貌似正常的 0/1。其他显卡若 FP16 产生异常，重算当前批次并在该 predictor 后续批次保持 FP32。FP32 按最多 4 个窗口分批，保持顺序；仍无效则明确失败。完整与两阶段分析均使用同一路径。
3. 零结果页增加“重新标定球桌”，保留当前原视频和角点，强制进入手动标定。零结果不再把当前视频切换为 CFR 缓存，避免重试分析缓存文件。
4. 日志补充实际 GPU、设备、Torch 版本、精度、批次、精度回退，以及输入颜色信息。worker 输出增加可选 `model_provenance.trajectory` 检出/缺失帧统计，同步严格 TypeScript 契约，旧历史仍可读取。

没有修改模型权重、检测阈值、回合过滤规则、导出源视频或发布配置。

## 扩展显卡范围

用户要求一并处理其他受影响显卡。2026-09-12 核对 [Ultralytics 官方 `check_amp` 文档与实现](https://docs.ultralytics.com/reference/utils/checks/#ultralytics.utils.checks.check_amp)后，加入以下精度策略：

| 显卡系列 | 型号 | 策略 |
| --- | --- | --- |
| GeForce GTX 16 | GTX 1630、1650、1660，含适用的 Ti/Super/移动版本 | CUDA 可用时直接 FP32，每批最多 4 个窗口 |
| NVIDIA/Quadro T | T400、T550、T600、T1000、T1200、T2000，含 Laptop/Max-Q 名称 | CUDA 可用时直接 FP32，每批最多 4 个窗口 |
| Tesla | K40m | 纳入历史风险型号匹配；不扩展当前 CUDA 的硬件支持 |
| 其他 CUDA 设备 | 包括 RTX、T4、A100、H100 等 | 保留 FP16；每批检查 NaN/Inf，异常则重算并保持 FP32 |

该列表是有公开兼容性记录的风险型号，不代表这些型号在每种驱动/模型组合下一定失败，也不是所有数值错误显卡的穷尽名单。通用逐批检查不依赖名单。持续无效的 FP32 结果明确失败，不再保存为成功的空结果。

K40m 需要特别区分：仓库当前分析组件是 Torch 2.12.1/CUDA 12.6，而 [NVIDIA 从 CUDA 12.0 起已移除 Kepler 支持](https://docs.nvidia.com/cuda/archive/12.0.0/cuda-toolkit-release-notes/index.html#deprecated-features)。本补丁不承诺让 K40m 在当前 CUDA 包运行，也没有放宽原有组件自检或架构兼容性判断。

本次核查 `worker/ttcut_worker/` 中只有 BlurBall 使用 `torch.autocast`；桌角和 TrackNet 路径未被改成半精度，也不修改它们的识别算法。

## 验证

- TypeScript/React：`tests/app-workflow.test.tsx`、`tests/analysis-contracts.test.ts` 共 41 项通过；包含普通空结果与 CFR 空结果保留原视频重新标定。
- Python：`worker/tests/test_blurball.py`、`worker/tests/test_analysis.py` 共 69 个相关用例已通过（按新增内容分批执行）；覆盖正常检测、完整/两阶段 NaN/Inf、全部风险型号与相似名称排除、精度回退成功/失败，以及 60 帧真实流式控制中从 16 窗口切到 4 窗口仍无遗漏。
- NaN 对照：HEAD 旧 predictor 返回成功、3 帧全部 missing；修复后返回 `INFERENCE_FAILED`。证据：`/tmp/ttcut-zero-rallies-20260912/nonfinite-regression.json`。
- 真实 Electron 加真实视频验证零结果页 → 重新标定 → 再次请求分析；保持同一源路径，提交 manual 标定。宿主 macOS、Windows renderer bridge，分析完成事件为模拟，不能当作 Windows 安装器验证。证据：`/tmp/ttcut-zero-rallies-20260912/ui/report.json` 及相邻截图。
- 真实 Python/CPU、现有权重和 0.3 阈值：SDR 前 90 秒、按实际角点，检出 986/1800 帧，7 个回合；原画前 90 秒，检出 1424/2702 帧，6 个回合。原画本身可以被现有分析链路识别。
- 使用日志标定的原画前 45 秒，在 CPU 上检出 1093/1352 帧、3 个回合；补充 Apple MPS 实验得到相同计数。MPS 仅用于本机实验，未加入产品支持。日志里的异常标定在本机也能检出回合，不能独自解释用户零回合。
- 修复后按实际角点重跑原画前 45 秒，仍有 3 个回合。与修复前 90 秒结果的同一段对照，前 1344 帧完整批次的检测逐项一致；末尾短批次/补帧不同，不能声称整个 1352 帧逐位相同。证据：`/tmp/ttcut-zero-rallies-20260912/real-regression.json`。

媒体样本、轨迹和实验脚本位于 `/tmp/ttcut-zero-rallies-20260912/`。没有 Windows/GTX 1660 Super 实机验证、安装器构建或远端发布；最终硬件确认需要在该机器运行修复构建，并核查 `precision=float32`、GPU 名称和检出帧统计。
