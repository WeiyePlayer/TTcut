# Windows 与 macOS 统一开发

日期：2026-11-04。

`develop` 是两端共用的长期开发分支。功能分支从最新 `origin/develop` 建立，并通过普通 merge PR 合回；不再通过长期平台分支选择性移植共享修复。平台发布仍分别构建、验证和交付。

## 整合基线

- Windows：`ca4f47c7ac2ba95e175d02190f79b7ea0cc2df0a`（原 `origin/develop`）。
- macOS：`b568a0036912d7506769da856b1c4bdf47386640`（原 `origin/macos`）。
- 整合分支：`auto/unify-develop-platforms`。使用有两个父提交的普通 merge 保留双方历史。
- 原 macOS 提交在删除分支前保留为恢复标签；最终标签和双端验收结果在完成后补充。

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
