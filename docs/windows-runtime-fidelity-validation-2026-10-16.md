# Windows 同步 macOS 运行时与导出修复验收

验收日期：2026-10-16（Asia/Shanghai）。本地分支：`codex/windows-sync-runtime-fidelity`。

## 来源与同步范围

执行前已 fetch；本地 `develop`、`origin/develop` 均为 `7a0204a43157e28aeda56f23eb6f9fb9404093c8`，工作区干净。

- macOS 的 PR #123/#124/#125 所涉 Windows 编辑器功能已经通过 PR #126 合入，无需重复移植。此前的范围见 [编辑器验收](windows-post138-macos-sync-validation.md)。
- `origin/macos` 最新为 `126a8dd`；上次编辑器同步后的两个提交属于 macOS v1.3.9 打包和交付记录。
- 尚未创建 PR 的 `origin/fix/python-runtime-isolation` 包含 `d4f5147`、`d4d688f`，已分别移植为本地 `d82c55a`、`e062548`。包含 Python 隔离、HDR 类型探测与导出限制、HEVC/hvc1 输出、VFR 时间戳和结果预览。
- 未纳入面向 `main` 的 Linux Cloud Agent 文档 PR #127，与本次 Windows 修复无关。

应用版本保持 1.3.9，模型、依赖锁文件、正式发布配置未修改。保留上游两次提交的跨平台实现；本次没有运行 macOS 原生编译或 Swift 测试。

## Windows 适配与发现的回归

1. 合并运行时隔离时，保留 Windows 已有的 DirectML 真实模型探测、批次选择和 CPU 回退。组件导入检查及模型探测均通过 `pythonRuntimeLaunch` 启动，不能仅凭 Provider 名称声称 GPU 可用。
2. 上游批量导出会在筛选片段前重探测所有旧历史，导致空选择也可能因源文件不可用而中断。改为只探测实际参与导出的素材，输入预检使用参与片段的源文件；不修改读入的历史元数据。保留原有输出位置规则。
3. Python 污染测试改用 Windows 暂存流程对应的基础解释器，避免虚拟环境禁用用户包、无法复现污染；发现解释器时显式启用 UTF-8，支持中文用户名路径。
4. 新编码策略保留 packet duration 后，旧的 DTS 警告复现不再必然成立。时间戳回归直接验证生产拼接清单无警告及 DTS 严格递增。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript | `npm.cmd run typecheck` 通过。 |
| 全量 Vitest | 81 个文件实际通过、7 个环境相关文件跳过；616 项通过、39 项跳过、0 失败。Python 污染复现及两个 Worker 启动测试均实际执行。 |
| 真实随包分析运行时 | 3 项通过：错误 PYTHONHOME/PYTHONPATH/PYTHONUSERBASE 下的依赖导入及模型探测、版本检查、模型与媒体组件检查。模块路径均位于指定运行时的 site-packages。 |
| Windows FFmpeg 保真导出 | 12 项通过：SDR AVC/HEVC、HDR10/HLG、切片拼接、CFR/批量输出、VFR 逐帧 PTS、4K60 Level 5.2、帧内 HDR10+ 拦截、静态 HDR 元数据丢失检测及旧历史 CFR/XML 重建。 |
| 真实比赛导出与批量导出 | 5 项通过，包含真实比赛切片质量检查，以及批量尺寸、帧率、旋转、音频/无声片段。 |
| x264 时间戳回归 | 9 项通过、5 项 OpenH264 环境用例跳过；覆盖 AAC 拼接、DTS、73 段 VFR、异常尾帧、B 帧和 44.1 kHz 音轨。 |
| Windows 运行时暂存单测 | `py -3.12 -X utf8 -m pytest worker/tests/test_windows_runtime_staging.py -q --basetemp=output/playwright/pytest-runtime-20261016`：4 项通过。默认系统临时目录权限异常，改用独立验收目录后通过。 |
| 实际打包程序 | `npm.cmd run package` 通过；批量导出修复后再次用 Electron Forge 重建，最终程序完成下述 6 项验收。 |

最终随包程序在独立用户配置、错误 Python 环境变量及外部伪造 numpy/cv2/onnxruntime 模块下：

1. 分析和媒体组件可用，依赖来自随包目录。
2. 从 `1-193-e2e.mp4` 的第 8 秒提取 4 秒比赛片段，实际自动标定成功。
3. 实际 BlurBall 分析完成 120 帧；provenance 记录 ONNX Runtime 1.24.3、DirectML、batch=4、原有模型哈希，回合方法保持 `hybrid_motion_bounce`。这只证明链路有效，不是新的算法准确率评估。
4. Main IPC 正确识别 HLG 与真实帧内 HDR10+ SEI。
5. 从旧历史触发 HDR10+ 视频导出，Main 返回 `DYNAMIC_HDR_UNSUPPORTED`，源文件哈希不变。
6. 经实际界面导出 HLG：结果为 HEVC/hvc1、yuv420p10le、HLG；完整解码通过，结果页兼容副本能够播放和跳转，源文件与原始导出文件的哈希均不变。无页面异常，程序正常退出，退出码 0。

## 证据和本地程序

本节程序哈希为首次验收快照；后续修复的当前构建与证据见文末补充记录。

- 全量测试：`output/playwright/windows-fidelity-20261016/full-tests.json`。
- 运行时专项：`output/playwright/windows-fidelity-20261016/runtime-tests.json`；该单次记录的污染夹具有 5 项跳过，最终全量测试已实际执行并全部通过。
- 时间戳专项：`output/playwright/windows-fidelity-20261016/timestamp-tests.json`。
- 保真素材与输出：`output/playwright/windows-fidelity-20261016/ttcut-fidelity-N4vLV7/`；批量结果位于同级 `ttcut-merged-media-3S9VXA/`。
- 最终应用验收：`output/playwright/windows-runtime-fidelity-kI5OQq/report.json`，6 项通过；同目录保留日志、比赛分析、实际 HLG 输出及 `hlg-export-preview.png`。
- 可复用验收脚本：`scripts/verify-windows-runtime-fidelity.mjs`，参数依次为随包 EXE、保真素材目录、比赛源文件、只读历史模板；脚本生成独立配置和素材副本。
- 本地测试程序：`out/TTcut-win32-x64/TTcut.exe`，使用时须保留整个同级目录。状态 `NotSigned`。
- EXE SHA-256：`c235246a224bd75bc18548e11d7d44835b4a606ac29622b246d71e3644b8c5b5`。
- `resources/app.asar` SHA-256：`2ce9627537da15e7dfab393c3090f396e1fa136e1a236401a1481d4b3d0cdd29`。

验收不修改用户历史或比赛原片；输出目录由 Git 忽略。本次仅完成本地同步、修复和测试，没有远端推送/合并、版本升级、NSIS 安装/升级、签名或发布。HDR 素材为合成片；未验证 Windows 系统播放器、真实 Dolby Vision 原片或反馈用户的特定问题文件。

## 独立审计 P2：旧 CFR 缓存丢失的补充修复

2026-10-16 后续修复关闭“缓存缺失、原片仍在时无法导出”的缺陷：

- 普通视频导出先解析原片，再校验文件和媒体格式；仅给本次导出使用记录副本，避免改写历史分析元数据或重复探测。
- 真实打包补验发现 `HistoryStore.open` 还会在更早阶段拒绝缺失的缓存。现在仅允许旧 Windows 历史恢复：未记录新保真元数据、原片路径与历史源文件一致，并且源文件指纹校验通过。原片缺失/变更、其他历史的缓存校验及 macOS 校验保持。
- 打开该类历史时预览使用原片；导出完成后的历史更新也可正常执行。动态 HDR 的限制仍生效，并在预检阶段返回错误。

验证：类型检查通过；53 项相关单测通过、3 项 macOS 环境测试跳过；13 项 Windows 实际 FFmpeg 保真测试通过，新增用例明确不创建 CFR 缓存，完成普通视频导出并全解码，保留 HDR、VFR 帧数、原片字节和历史元数据。最初新增回归在修复前实际复现 `INPUT_MOVED`。

重新构建后的实际 Electron 验收 7 项全部通过，包括真实 `openHistory`、缺失缓存的普通 `startExport`、导出后历史更新、HEVC/hvc1/10 位 HLG 格式验证及完整解码；恢复样本目标和输出均为 2.000000 秒，漂移为 0，程序正常退出。该夹具的缓存始终不存在，源文件及历史原有缓存路径保持。

- 编码证据：`output/playwright/missing-cfr-fix-20261016/media-tests.json`。
- 最终应用证据：`output/playwright/windows-runtime-fidelity-LSEZUQ/report.json`。
- 当前本地程序：`out/TTcut-win32-x64/TTcut.exe`，`NotSigned`，保留整个同级目录使用。
- 当前 EXE SHA-256：`888f1190848c33b627057b63b0bbc0d59543033be86bd73133ef2a0fbc7df392`。
- 当前 `resources/app.asar` SHA-256：`28a94a291a45ddf732f1cbf54c451d947f1a17c82a94203032a8eea879a01596`。

此前审计中的动态 HDR Worker 分析、多任务/批量 HDR 预览覆盖缺口不属于本次 P2 修复，未扩大通过结论。本次仍未推送、合并或发布。
