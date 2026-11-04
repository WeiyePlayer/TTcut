# Windows 与 macOS 统一开发

日期：2026-11-04。

`develop` 是两端共用的长期开发分支。功能分支从最新 `origin/develop` 建立，并通过普通 merge PR 合回；不再通过长期平台分支选择性移植共享修复。平台发布仍分别构建、验证和交付。

## 整合基线

- Windows：`ca4f47c7ac2ba95e175d02190f79b7ea0cc2df0a`（原 `origin/develop`）。
- macOS：`b568a0036912d7506769da856b1c4bdf47386640`（原 `origin/macos`）。
- 整合分支：`auto/unify-develop-platforms`。使用有两个父提交的普通 merge 保留双方历史。
- 原 macOS 提交在删除分支前保留为恢复标签 `archive/macos-before-develop-unification-2026-11-04`。

## 保留的行为

| 边界 | Windows | macOS |
| --- | --- | --- |
| 随包分析 | Python / ONNX Runtime DirectML，保留模型探测、会话复用及 CPU 恢复 | Swift / Core ML，保留 FP16、源时间判定及停顿排除 |
| 回合识别 | `hybrid_motion_bounce` | `continuous_visibility` 与板数元数据 |
| 剪辑预览 | C++ / libmpv 原生窗口及输入处理 | CompatibleVideo 与原生兼容代理 |
| 记分牌 | 原生预览交互、共享编辑与 FFmpeg 导出 | DOM 编辑、Swift 原生导出；显示尺寸不重复应用旋转 |
| 打包 | Windows Python、Worker、FFmpeg、libmpv 与 NSIS | Swift helpers、Core ML 模型、FFmpeg 与 DMG / ZIP |

共享剪辑逻辑同时识别两端的源时间排除标记，保留 develop 对短片段、相邻范围和最小帧长度的保护。模型、依赖版本、采样默认值及发布配置没有因统一分支而调整。

## 验证约定

共享契约、剪辑、预览和记分牌修改需检查两端回归。模拟某个平台后端的单元测试明确选择该后端；依赖真实系统工具的集成检查只在对应主机执行。单元测试、真实视频、实际 Electron、安装器与正式签名分别记录，不互相替代。

本次验收覆盖整合提交的类型检查、TypeScript、Python、Swift，以及两端实际应用的分析、剪辑预览、记分牌和导出。验收使用隔离的测试数据；不发布新的安装包或修改现有 Release。

## macOS 验收

主机：macOS 27.0.1 arm64；被验产品源码：`0e753a9955cdbe33e5f2970086558f884822f544`。本地应用构建清单记录该提交与干净源码树。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| 完整 Vitest | 713 通过、0 失败、104 跳过；Windows 签名集成在本机跳过 |
| `macos/.venv/bin/python -m pytest worker/tests -q` | 259 通过、3 跳过 |
| `TTCUT_NATIVE_TESTS=1 swift test --package-path macos` | 51 通过、3 跳过；包括源时间判定、原生导出、HDR、旋转和记分牌 |
| `npm run package:mac` | 本地应用构建与严格深度 ad-hoc 签名检查通过 |
| `scripts/verify-electron-macos.mjs` | 21 项通过；实际 Core ML、120 fps、解码帧推进、停顿排除、HDR/VFR、取消与失败恢复、合并/分段/XML |
| `scripts/verify-macos-post137.mjs` | 11 项通过；比分编辑、循环与拖动、草稿恢复、记分牌叠加及分段/XML |
| `scripts/verify-custom-playback.mjs` | 仓库真实素材的 23 项播放检查通过；实际媒体协议与解码帧 |

本地证据：`output/develop-unification/report.json`、`vitest-final.json`、`swift-native.log`、`python.log`、`package-macos.log`、`electron-macos/run-ROdBKD/report.json`、`playback-evidence/report.json`，以及 `output/macos-post137/app-NqAdeM/report.json` 和截图。

初次 TypeScript 检查发现 Windows 单元测试隐含宿主平台与盘符，已改为明确选择 Windows 后端并使用宿主路径夹具。首次记分牌驱动被操作指南遮挡，验收脚本补充实际关闭指南后续跑未完成检查；未为此修改产品。Swift 的 3 个跳过项需要外部真实动态 HDR 素材，不计作通过。未做新的准确率评估、最低系统版本实机、正式签名、公证、安装/升级或新归档发布。

## Windows 验收

指定会话“拉取最新进度并验证”，主机 `D:\DOCUMENTS\TTcut`，验证同一提交 `0e753a9955cdbe33e5f2970086558f884822f544`。隔离测试包内的 119 个构建文件已与此次本地构建逐一比较一致。

| 检查 | 结果 |
| --- | --- |
| 类型检查与完整 Vitest | 通过；719 通过、0 失败、98 跳过，含安装布局 7 项 |
| Python worker | 259 通过、3 跳过 |
| 实际随包运行时 | 8 项通过；外部 Python 环境污染下的标定与分析、真实 DirectML batch 4 的 120 帧推理、HDR10+ 转 SDR、缺失 CFR 缓存回源、输出播放及 seek、默认剪辑排除区间 |
| 三种导出 | 合并视频、分段视频加 XML、独立 XML 通过；全解码、音频、时长、XML 边界与源文件哈希检查通过 |
| libmpv 剪辑交互 | 首帧、播放、暂停、重开、精确 seek、剃刀、撤销/重做、原生焦点快捷键与双片段记分牌导出通过 |
| 原生记分牌 | 12 项通过；中文名称、比分、滚轮、胜方、拖动缩放、四种样式的原生画面和导出、指南遮罩 |

原剃刀验收驱动在缩放后沿用失效坐标，并在 libmpv 确认实际帧时间前读取游标，分别导致命中错误和 `3.4398685s` / `3.45s` 的断言差异。续测稳定缩放与坐标、验证实际命中、等待 seek 确认后通过；原失败和续测报告均保留，没有为验收修改产品代码。

Windows 证据目录：`D:\DOCUMENTS\TTcut\output\playwright\unify-develop-windows-20261104\0e753a9`；运行时的 8 项原始报告位于 `output/playwright/windows-runtime-fidelity-jZzThJ/report.json`。报告由上述 Windows 会话执行并提供，Mac 主机不冒充直接执行 Windows 验收。

本次不以 Windows / macOS 中任一端的测试替代另一端，也不将这些结果当作新安装器、更新安装或正式发布的证明。
