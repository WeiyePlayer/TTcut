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
