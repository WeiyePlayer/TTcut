# TTcut v1.3.7

**简体中文** | [English](https://github.com/WeiyePlayer/TTcut/blob/v1.3.7/docs/release-notes-v1.3.7.en.md)

`v1.3.7` 是面向 Windows x64 与 macOS 15+ Apple Silicon 的正式版本更新，重点改善自定义剪辑预览和原视频时间边界；Windows 另外改善 DirectML 分析恢复及随包运行库。

## 分析稳定性

- DirectML 球检测遇到显存或批处理限制时，会依次尝试较小的批量；仍无法完成时，丢弃未完成的加速结果并从头使用 CPU 分析。进度与结果会记录实际使用的运行方式。
- 混合运动与落点回合识别使用原视频时间戳判断回合及排除区间。变帧率或帧率转换后的分析不再把转换后帧号直接当作原视频时间。
- 运行资源检查会明确指出缺失或损坏的文件，减少启动后才发现运行库不可用的情况。

## 预览与安装

- 自定义剪辑的兼容预览改善跳转后的播放位置、暂停状态与时间线同步，尤其针对需要转换预览的媒体。
- Windows 完整安装包增加分析运行时所需的 Visual C++ 库文件；安装后无需另外安装运行库。
- 独立 Beta 构建使用自己的应用标识和数据目录。此正式版使用正式渠道配置。

## macOS 平台说明

- macOS 原生 Core ML 连续运动分析使用原视频时间戳及已观测暂停区间决定回合边界，变帧率转换不会改变导出时间基准。
- 原生兼容预览会保留源视频时间、播放和暂停意图，并与自定义剪辑时间线同步。
- macOS 继续使用随包原生分析与媒体运行时，不使用 Windows DirectML 或 Visual C++ 运行库；软件内更新保持禁用。

## 发布文件

- **Windows x64 完整安装包**：`TTcut-1.3.7-x64-Setup.exe`，包含分析模型、DirectML/CPU 运行时与视频工具。
- 安装包采用固定 `CN=weiye` 自签名 Authenticode 证书和 RFC 3161 时间戳。尚未信任该证书的 Windows 系统仍可能提示“未知发布者”或 SmartScreen。
- **macOS 15+ · Apple Silicon**：`TTcut-1.3.7-arm64-Setup.dmg`（推荐）与 `TTcut-1.3.7-arm64-Setup.zip`，不支持 Intel Mac。
- macOS 包使用临时签名且未经过 Apple 公证；首次打开若被拦截，请在“系统设置 > 隐私与安全性”中确认允许。由于软件内更新禁用，不提供 `latest-mac.yml`。

## 验证

- TypeScript 类型检查、项目测试（460 通过、25 跳过）、Python Worker 测试（236 通过）及网站构建与渲染测试通过。
- 正式安装包构建、模型和运行时完整性、更新清单签名、安装包 Authenticode 签名均通过自动验证。
- 本次未进行真实视频效果对照或安装器的人工安装测试。
