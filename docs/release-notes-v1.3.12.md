# TTcut v1.3.12

**简体中文** | [English](https://github.com/WeiyePlayer/TTcut/blob/v1.3.12/docs/release-notes-v1.3.12.en.md)

## 更新内容

- **Windows**：浏览器无法解码标定预览时，自动用 FFmpeg 提取所选时间的画面，继续选帧和标注球桌。提取遵循显示旋转，HDR 采用预览色调映射并限制尺寸，不替换原视频。
- 快速拖动优先处理最新帧请求，过期结果不覆盖当前画面；画面未就绪时禁止误标定，提取失败有明确提示。帧提取 IPC 与图片通道沿用源文件访问控制及退出清理。
- **macOS**：同步共享标定界面、媒体通道及预览状态处理；继续使用兼容视频预览，不启用 Windows 专用逐帧回退。保留原生 Core ML、源时间分析、动态 HDR 转 SDR 及独立 XML 导出。
- 不改变 BlurBall 模型、默认采样、回合识别或导出规则。

## 安装包

- **Windows x64 v1.3.12**：`TTcut-1.3.12-x64-Setup.exe`，包含模型、运行时、原生预览与视频工具。沿用固定 `CN=weiye` 自签名证书和时间戳，系统仍可能提示 SmartScreen 或未知发布者。
- **macOS 15+ Apple Silicon v1.3.12**：`TTcut-1.3.12-arm64-Setup.dmg`（推荐）和 `TTcut-1.3.12-arm64-Setup.zip`；不支持 Intel Mac。
- macOS 为临时签名、未公证；首次打开受阻时可在系统设置的隐私与安全性中允许。应用内更新禁用，不提供 `latest-mac.yml`。

## 验证边界

- Windows 草稿记录本轮按要求未运行单元测试、类型检查或真实媒体/界面验收，仅保留正式打包流程内置检查；不据此声称 Windows 功能已验收。
- Windows 原生预览/libmpv 固定构建及链接依赖的对应源码与许可分发材料仍待核实齐备，安装包及校验文件不代表该材料已补齐。
- 本次不重复算法准确率评估、实际 Premiere 导入或 Windows 安装/升级验证；macOS 临时签名检查不等于 Apple 公证。

## macOS 发布验收

- 类型检查和 46 项相关回归通过；旋转 ProRes 选帧的真实 FFmpeg 测试 1 项通过（macOS 主机模拟 Windows 探测路径，不代表 Windows 实机）。
- 开发态真实 Electron 配合原生 Worker 的 4 项界面检查通过，覆盖标定四点输入、自动标定失败恢复、批处理取消重试及退出清理。
- 实际 1.3.12 打包应用 21 项验收通过，覆盖离线启动、中英文界面、Core ML、120 fps、实际解码帧推进、HDR/VFR、历史及导出。
- DMG 挂载、29 个 arm64 原生文件、签名完整性和归档 SHA-256 校验通过。macOS 构建源码为 `29f2bad38dca13c7177b5088456d2488518c13e5`，构建清单记录干净工作树；Windows 草稿源码为 `ca4f47c7ac2ba95e175d02190f79b7ea0cc2df0a`。
- Windows 校验清单与 GitHub 摘要一致，更新清单版本、安装包名称和大小匹配；本机未重验 Windows 签名或安装器。
- macOS DMG SHA-256：`5395e9f75b7b6832a87584069358758811f102bd627206826787423dd17e1572`。
- macOS ZIP SHA-256：`6f11dd6ae51d5c39726f44c38f425bba9673ee37975dd80ddc0905dcf9f0bbdf`。
