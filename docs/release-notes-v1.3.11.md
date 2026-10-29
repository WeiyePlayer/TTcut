# TTcut Windows v1.3.11

**简体中文** | [English](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/release-notes-v1.3.11.en.md)

## 更新内容

- 单源 HDR10+、具有兼容 HDR10/HLG 基础层的 Dolby Vision 8.1/8.4 视频导出自动转换为 BT.709、8 位 4:2:0 H.264 SDR，先真实色调映射再叠加记分牌，并清理 HDR 元数据；不是仅修改色彩标签。未知或不兼容 Dolby Vision 仍明确报错。原有 SDR、HDR10/HLG 保真与多源批量规则保持不变。
- 修复动态 HDR 跳转时缺少 HEVC 参数集的恢复问题。
- Premiere XML 不再依赖视频编码、CFR 重建或记分牌准备。可信 CFR 不可用时使用原片引用；视频失败不丢弃成功 XML，按实际请求产物分别报告错误。
- 加强旧历史原片恢复、源文件变化校验和 CFR 视频/音频完整性检查，拒绝损坏缓存；完善探测、准备、编码及发布阶段的取消和清理。
- hybrid v4 自定义剪辑初稿遵守已确认排除区间，短片段不会默认越界；空间不足时明确提示调整或取消选择，用户仍可手动编辑。旧版历史不启用该限制。

## 安装包与验证

- Windows x64 完整安装包：`TTcut-1.3.11-x64-Setup.exe`，包含模型、运行时、原生预览与视频工具。沿用固定 `CN=weiye` 自签名 Authenticode 证书及 RFC 3161 时间戳，未信任证书时仍可能出现 SmartScreen 提示。
- 已合入实现的全量与真实媒体/界面证据见 [Windows 验收记录](https://github.com/WeiyePlayer/TTcut/blob/develop/docs/windows-hdr-export-xml-validation-2026-10-29.md)。本轮不重复全量验收；发布构建结果另以实际检查为准。
- 本次仅准备 GitHub Release 草稿，不公开发布，不提供新的 macOS 安装包。
- 本轮 TypeScript 检查及 104 项相关回归全部通过，覆盖导出色彩策略、恢复、历史、XML、自定义片段和界面流程。

## 限制与公开发布前待办

- 未在本轮执行 NSIS 安装/升级交互、实际 Premiere 导入、其他 Windows 设备或 macOS 原生验收。未知 Dolby Vision profile 和混合 HDR 多源批量转换不属于自动转换范围；跨机器历史导入不属于本次功能。
- 公开发布前核对并补齐原生预览/libmpv 固定构建及链接依赖的对应源码与许可材料；本草稿只附安装包与更新校验文件。
