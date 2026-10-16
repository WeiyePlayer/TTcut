# Windows/macOS 导出策略统一

用户提供的 MediaInfo HTML 描述了一个 3840×2160、约 59.94 fps 的 H.264
High 10 / Level 6.2 / 10 位 HLG 导出视频。Windows 播放器截图提示编码设置
不受支持。HTML 本身是参数报告，TTcut 不生成这类视频旁车文件。

## 实现

- 两端使用相同的编码选择：HDR10/HLG 或 HEVC 输入输出 HEVC / `hvc1`，其他
  SDR 输入输出 H.264。保留支持的 8/10 位、色度、色彩、HDR 静态元数据；单片
  保留显示尺寸、像素宽高比、声道数和音频采样率。这里的保真不表示无损编码。
- Windows 探测流和五个位置的有界解码帧，从帧侧数据识别 HDR10+ 和静态 HDR。
  Dolby Vision / HDR10+ 可分析、可预览，但视频导出在复制或重新编码前拒绝，
  避免丢失动态元数据。旧 Windows 历史重新探测原片，不继续输出旧 CFR 副本
  可能已经丢失的 HDR 元数据。Premiere XML 如需携带旧历史的 CFR 文件，也从
  原片按已记录的目标帧率重新生成并验证，不复制旧副本或把 VFR 原片误标为 CFR。
- CFR 处理选择目标标称帧率，两端的滤镜、编码器和容器使用一致的参考帧率。
  缓存策略升级，避免复用旧编码策略生成的中间文件。
- VFR 保留 PTS、精确时间基和正常的帧持续时间。去除 `strip_fps=1` 对尾帧
  持续时间的清除；显式设置编码器参考帧率，避免 H.264 Level 被推高；限制
  超出裁剪结束时间的异常 packet duration，同时明确保留 PTS/DTS，兼容 B 帧。
- 合并集锦保留首个实际参与视频的尺寸/帧率及原有 AAC 48 kHz 双声道规则，
  不再强制把 HDR/10 位转成 8 位 SDR。色彩、位深、色度或 HDR 规格不一致时
  明确报错；任一参与片段需要 HEVC 时，共同输出选 HEVC。
- Windows 结果预览复用现有兼容预览服务，HDR 使用与 macOS 相同的 Hable
  tone mapping。等待副本就绪后再启用播放控件，并保留自动播放行为。原始
  导出文件不参与转换或覆盖。
- Windows 暂存/发行门禁要求 x264+x265、8/10 位格式和 HDR 预览滤镜；继续
  使用随包 FFmpeg，不依赖用户安装的编码器。未更改模型、应用版本或发布流程。

决策见 [ADR 0018](../adr/0018-cross-platform-export-fidelity.md)。TS 和 Swift
共同读取 `tests/fixtures/export-fidelity-policy.json`，防止编码选择再次分叉。

## 验证及边界

后续 Windows 随包 Python、FFmpeg 和实际 Electron 验收见 [2026-10-16 Windows 验收记录](../windows-runtime-fidelity-validation-2026-10-16.md)。

验证主机是 macOS arm64。Windows TypeScript 路径使用本机 FFmpeg 执行真实
编码，不能替代 Windows 原生 FFmpeg、系统播放器或安装包验证。

- 本机套件 598 项通过，40 项按环境配置跳过；类型检查和差异检查通过。
- 真实 Windows 参数路径共 12 个视频用例通过：SDR AVC/HEVC、HDR10/HLG、
  切片/拼接/CFR/合并参数、逐帧 VFR、4K60 Level 5.2、真实帧内 HDR10+ 拦截，
  删除静态 HDR 元数据后拒绝发布，以及旧 Windows 历史的 HDR CFR/XML 旁车
  重建。全部输出执行完整解码检查。
- 原有异常持续时间、73 段 VFR、44.1 kHz AAC 等时间戳回归 6 项通过；跨视频
  合并任务的尺寸、帧率、旋转、无声片段和音频回归 4 项通过。
- Swift 原生 7 项通过，覆盖共同策略、两种剪辑策略、HDR 静态元数据、VFR
  逐帧/尾帧、CFR、10 位 SDR/多声道/旋转 SAR 和 HDR 记分牌。
- 真实 Electron 在 macOS 上走 Windows 生产预览路径，HLG 文件的起播及片尾
  跳转均持续增加解码帧，无页面错误；视频 SHA-256 前后相同。素材是合成
  测试片，未验证用户原片的色彩观感。
- 全量初查另外有 7 个环境相关失败：6 项 Windows 路径/注册表假设，以及
  1 项依赖 `powershell.exe` 的签名命令。这两个测试文件未修改，后续本机
  套件明确排除；没有将它们记为通过。

可保留的本机记录位于 `output/unified-export-20261015/`。未构建 Windows
安装包、未签名发布，也未在反馈用户的 Windows 系统播放器上复测。
