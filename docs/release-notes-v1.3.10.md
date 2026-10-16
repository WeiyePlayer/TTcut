# TTcut v1.3.10

**简体中文** | [English](https://github.com/WeiyePlayer/TTcut/blob/v1.3.10/docs/release-notes-v1.3.10.en.md)

面向 Windows x64 和 macOS 15+ Apple Silicon，改善视频导出保真、动态 HDR 处理和运行时可靠性。

## 双平台：视频导出与预览

- HDR10/HLG 或 HEVC 输入使用 HEVC/hvc1 导出，其他 SDR 输入使用 H.264；保留支持的 8/10 位深度、色度、色彩及静态 HDR 元数据。保真不等于无损编码。
- 改善 VFR 时间戳、帧时长和尾帧处理，避免遗漏最后一帧；保留既有批量成片尺寸、帧率及音频规则。色彩、位深或 HDR 契约不兼容时明确拒绝，不静默降为 SDR。
- Dolby Vision/HDR10+ 保真视频导出仍不支持，在导出前明确拦截，避免静默丢失动态元数据；不支持的位深也会明确报错。
- HDR/HEVC 成片可使用兼容预览副本播放和跳转，不替换原片或导出文件。
- 批量导出只探测实际参与导出的素材，空选择不决定输出规格。

## Windows

- 隔离随包 Python 的模块搜索路径，避免系统 PYTHONHOME、PYTHONPATH、用户包及外部同名模块污染组件检查、标定和分析；保留 DirectML 模型探测及 CPU 回退。
- 完整安装包的视频工具新增 x265 支持。
- 导出旧历史前重新检查原片，避免复用已经丢失 HDR 信息的旧 CFR 缓存。缓存缺失但原片路径与指纹校验通过时恢复使用原片，不改写原始分析元数据；原片缺失或变更时仍保留安全校验。

## macOS

- 修复动态 HDR 视频在导入、标定或分析前被导出限制误拦截的问题，将动态 HDR 保真限制移至导出入口。已以合成 HDR10+ 素材验证，未取得用户原片或真实 Dolby Vision 素材，不能保证所有 Dolby Vision 格式均可处理。
- 补充实际 HDR 类型、位深、传递函数与探测失败日志；日志失败不覆盖原始异常。
- 保留原生 Core ML 分析及 Swift 原生媒体处理；不调整模型、识别算法或默认采样参数。

## 安装包和限制

- **Windows x64 v1.3.10**：`TTcut-1.3.10-x64-Setup.exe`，包含模型、运行时、原生预览及视频工具。固定 `CN=weiye` 自签名 Authenticode 证书及 RFC 3161 时间戳；未信任证书的系统可能提示未知发布者或 SmartScreen。
- **macOS 15+ Apple Silicon v1.3.10**：`TTcut-1.3.10-arm64-Setup.dmg`（推荐）及 `TTcut-1.3.10-arm64-Setup.zip`；不支持 Intel Mac。
- macOS 为临时签名、未公证；首次打开受阻时可在系统设置的隐私与安全性中允许。应用内更新禁用，不提供 `latest-mac.yml`。
- Windows 草稿所列 libmpv 固定构建及链接依赖的对应源码与许可分发材料尚未核实齐备；现有安装包和更新校验文件不等于该材料已经补齐。
- Windows 本轮记录的 103 项相关回归、签名/更新清单及 7 项实际应用验收通过，详见 [Windows 验收记录](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-runtime-fidelity-validation-2026-10-16.md)。本次 macOS 发布不重复或扩大 Windows 验证结论。
- 未验证 Windows 系统播放器、NSIS 安装/升级交互、用户问题原片或真实 Dolby Vision；合成 HDR 素材及分析链路验收不代表算法准确率评估。
