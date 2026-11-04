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

## macOS 发布验收

- 类型检查、195 项相关回归通过，3 项按环境跳过。原生测试首轮 51 项通过、3 项素材用例跳过，提供真实 HDR10+ 和 Dolby Vision 8.1/8.4 后这 3 项补验全部通过。
- 实际 1.3.11 打包应用 21 项验收通过；另有 Dolby Vision 合并视频播放、分段与 XML 共 4 项，以及真实界面 XML 故障隔离 2 项通过。原片哈希保持不变；该检查不代表比赛分析准确率或实际 Premiere 导入验证。
- 缓存完整性真实媒体测试 40 项通过、2 项跳过；1 项模拟 Windows 的 MP3 夹具因 macOS 随包 FFmpeg 不含 libmp3lame 编码器失败，未记为通过。应用验收曾因截图超时中断，完整复查 21 项通过。
- DMG 挂载、29 个 arm64 原生文件、签名完整性及归档 SHA-256 校验通过。临时签名完整性不等于 Apple 公证。
- macOS 构建源码：`b1d2ab0e1b2d8e7bfd700bf6606ba7f4da712903`，构建清单记录干净工作树；Windows 草稿源码：`018bb5a84fbe60f8fa1a04f1dd566541d05f7686`。Windows 校验清单与 GitHub 摘要、更新清单版本/名称/大小一致；本机未重验 Windows 签名或安装器。
- macOS DMG SHA-256：`155451a0431ace0b388671ea8e12a11234f0c722be87ac73fbc91bb7fa48db98`。
- macOS ZIP SHA-256：`2f87dc68800f9556cc5ff83f36b1dc5471a1c96dd2059fcccec7b7338cdd43bb`。
