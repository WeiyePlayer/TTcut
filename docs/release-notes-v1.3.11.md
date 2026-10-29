# TTcut v1.3.11

**简体中文** | [English](https://github.com/WeiyePlayer/TTcut/blob/v1.3.11/docs/release-notes-v1.3.11.en.md)

适用于 Windows x64 和 macOS 15+ Apple Silicon。

## 更新内容

- 单源 HDR10+、具有兼容 HDR10/HLG 基础层的 Dolby Vision 8.1/8.4 视频导出自动转换为 BT.709、8 位 4:2:0 H.264 SDR。先实际色调映射再叠加比分牌，并清理 HDR 元数据，不是仅修改色彩标签。未知或不兼容 Dolby Vision 仍明确报错；原有 SDR、HDR10/HLG 保真与多源批量规则保持不变。
- 修复动态 HDR 跳转时缺少 HEVC 参数集的恢复问题。
- Premiere XML 独立于视频编码、CFR 重建和比分牌准备；可信 CFR 不可用时引用原片。视频失败不会丢弃成功 XML，按实际请求产物分别报告错误。
- 加强旧历史原片恢复、源文件变化校验和 CFR 视频/音频完整性检查，拒绝损坏缓存；完善探测、准备、编码及发布阶段的取消和清理。
- Windows hybrid v4 自定义剪辑初稿遵守已确认排除区间，短片段不会默认越界；空间不足时提示调整或取消选择，仍允许手动编辑。旧版历史不启用该限制。
- macOS 保留原生 Core ML、源时间分析、已观察停顿排除区间及兼容预览，不改模型或默认识别参数。

## 安装包

- **Windows x64 v1.3.11**：`TTcut-1.3.11-x64-Setup.exe`。包含模型、运行时、原生预览与视频工具；沿用固定 `CN=weiye` 自签名 Authenticode 证书及 RFC 3161 时间戳，未信任证书时仍可能出现未知发布者或 SmartScreen 提示。
- **macOS 15+ Apple Silicon v1.3.11**：`TTcut-1.3.11-arm64-Setup.dmg`（推荐）及 `TTcut-1.3.11-arm64-Setup.zip`，不支持 Intel Mac。
- macOS 为临时签名、未公证；首次打开受阻时可在系统设置的隐私与安全性中允许。应用内更新禁用，不提供 `latest-mac.yml`。

## 验证与限制

- Windows 发布准备记录：类型检查及 104 项相关回归通过；更广的真实媒体/界面验证见 [Windows 验收记录](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-hdr-export-xml-validation-2026-10-29.md)。本次 macOS 发布不重复或扩大 Windows 实机结论。
- 未验证实际 Premiere 导入、NSIS 安装/升级交互或其他 Windows 设备；未知 Dolby Vision profile、混合 HDR 多源批量转换和跨机器历史导入不属于本次功能。
- 完整缓存解码校验可能增加耗时，开销尚未量化；源身份校验不能排除刻意保持大小和修改时间的内容替换。
- Windows 草稿所列 libmpv 固定构建及链接依赖的对应源码与许可分发材料尚未核实齐备，安装包及更新校验文件不代表该材料已补齐。
