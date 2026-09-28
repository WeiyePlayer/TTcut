# v1.3.7 后 macOS 同步与验收

日期：2026-09-28；验证主机：macOS arm64。

- 基线：`macos` / `origin/macos` / `v1.3.7`，`c4adef94d2ab5cb737a2d78de74e257c316fbb53`。GitHub 上次正式发布为 2026-09-26，包含 macOS DMG/ZIP。
- 新分支：`auto/macos-sync-post-v1.3.7`。
- 已 fetch 所有远端分支和标签；本次审计到 `origin/develop` 的 `140922522444b97ff7808ab3a3ada17817fe9283`，交付前再次核对远端引用未变化。上次发布后的新功能分支均已合入该 develop。
- 使用选择性补丁移植，未整分支合并 develop；下次同步应以本表判断功能是否已经移植，不能只凭 Git 祖先关系。

## 更新分类与取舍

| 来源 | 分类 | macOS 处理 |
| --- | --- | --- |
| [PR #117](https://github.com/WeiyePlayer/TTcut/pull/117)，`52fd062` | 草稿丢失、批量历史竞争、失败任务覆盖旧结果、损坏输入等共享修复；同时包含 DirectML 修复 | 同步草稿持久化、重置确认、退出前写入排空、历史串行变更、成功/待完成记录分离、损坏视频错误行。DirectML 部分不移植。macOS 原生分析本来就在清理并释放任务后发终态，保留并实际验证。 |
| [PR #118](https://github.com/WeiyePlayer/TTcut/pull/118)，`86f28af` | 新功能：逐回合记分牌及成片叠加 | 同步前端、共享契约、Main 校验、Swift 原生媒体协议与导出；完成 Mac 实测。 |
| [PR #119](https://github.com/WeiyePlayer/TTcut/pull/119)，`cefcffc`、`d29d2fc` | Windows 专属：libmpv 即时预览及 Windows 探测优化 | 不引入 C++/libmpv、原生预览 IPC、资源和打包步骤。保留 macOS CompatibleVideo 与现有原生代理；共享播放控制类型作为后续功能的小型依赖保留。 |
| [PR #120](https://github.com/WeiyePlayer/TTcut/pull/120)，`f22e808` | Windows DirectML 会话复用、批量回退及内存优化 | 不移植；macOS 使用 Core ML，不运行此 Python/DirectML 链路。 |
| [PR #121](https://github.com/WeiyePlayer/TTcut/pull/121)，`c56c481`、`ce21230` | 新功能：单回合循环、三态图标、循环目标高亮 | 同步并验证实际解码、目标切换、未选回合、源视频末尾循环及草稿模式保存。 |
| [PR #122](https://github.com/WeiyePlayer/TTcut/pull/122)，`b81f847`、`425d37b`、`d11b693` | 记分牌交互改进、胜者与比分延续、拖动游标修复；Windows 原生输入层修复 | 同步共享 DOM 编辑、拖动缩放、滚轮、自动跳转、游标不被解码时间拉回及时间轴溢出修复。Windows HWND、DPI manifest 和物理输入脚本不移植。 |

保留 macOS 的 `continuous_visibility`、源时间排除区间、Core ML 模型、无自动关机及禁用自动更新。版本仍为 1.3.7；未更改 npm 依赖、发布渠道或安装器配置。

## 移植中发现并修复的 Mac 问题

1. `MediaProbe` 已将旋转视频转换为显示宽高；上游记分牌再次交换宽高。现在前端、Main 图片尺寸及 Swift 叠加均按同一显示坐标计算，避免竖屏记分牌位置、比例错误。
2. 现有随包 FFmpeg 使用 `--disable-autodetect`，没有 PNG 解码器，无法读取记分牌。原生依赖构建显式启用系统 zlib，检测并重建缺 PNG 的旧运行时；暂存脚本在覆盖资源前检查 PNG 能力。未改变 FFmpeg 版本或引入外部 Python/图像库。

## 验证结果

| 验证 | 结果与范围 |
| --- | --- |
| TypeScript | `npm run typecheck` 通过。 |
| 共享专项 | 12 文件、219 项通过；覆盖历史并发、草稿、主界面、比分继承、循环决策、播放控制、游标、导出请求、批量错误行和旋转尺寸。 |
| macOS 专项 | `npm run test:mac`：5 文件、17 项通过。 |
| Swift 原生导出 | `ScoreboardExportTests` 的 4 项均实际执行通过：两个导出策略的不同逐段覆盖层及音轨；旋转坐标；非法记分牌拒绝；旋转、HDR10、HLG 的真实叠加、尺寸、编码和位深保留。 |
| 本地应用包 | `npm run package:mac` 通过，原生 helper 重编译，PNG 能力随包，`codesign --verify --deep --strict` 通过（ad-hoc）。 |
| 实际打包应用 | `scripts/verify-macos-post137.mjs`：10 项通过，真实生产 Main/preload/renderer/Swift，独立用户目录；中英文姓名、四种比分、Escape/滚轮、胜者自动跳转、拖动缩放、循环帧、稳定游标、导航与进程重启恢复、重置确认、合并/分段视频和 XML。 |
| 成片像素 | UI 实际导出两个 2 秒片段，合并总长 4 秒且保留 AAC。逐帧截图可见小比分 4:3 → 5:3，大比分 1:2，中英文姓名正确；两段独立视频与合并视频对应帧逐像素比较一致。 |
| 真实比赛素材播放 | `scripts/verify-custom-playback.mjs`：23 项通过。macOS 平台桥接、真实媒体协议及解码帧计数；使用仓库比赛素材，独立 Electron 测试入口、软件解码。 |
| 批量真实 UI | `scripts/verify-electron-macos-ui.mjs`：4 项通过，包含损坏视频可见且可移除、有效任务保留、标定恢复、取消后剩余队列/重试、连续原生分析历史记录、隐藏窗口继续执行和退出清理。 |

完整 Vitest 初次执行为 493 通过、11 失败、28 跳过。其中 9 个失败来自未改动的 Windows 假设：`installation-layout` 6 项、`components` 1 项、`premiere-xml` 1 项、`update-manifest-signature` 1 项（本机没有 Windows 路径/注册表、随包组件或 PowerShell）。另 2 项是上游新引入、只模拟 Python 路径的 cleanup 测试，在 Darwin 上被原生入口绕过；该 Windows 专属测试和实现未保留在最终移植。随后受影响的共享专项与 Mac 专项全部通过。未将完整跨平台套件描述为全绿。

应用验收脚本期间修正过测试驱动自身的定位问题（标尺点击并非游标拖动、隐藏 checkbox 应点击可见 label）和 FFmpeg 截图时间字符串。只对未完成检查续跑，应用包未改变；最终报告含全部 10 个成功检查。这些不是产品修复。

## 本地证据

- `output/macos-post137/typecheck.log`、`targeted.log`、`mac-tests.log`、`vitest.log`。
- `output/macos-post137/swift-scoreboard.log`、`swift-formats.log`、`native-dependencies.log`、`package.log`。
- `output/macos-post137/app-YCao8r/report.json`，同目录有输入视频、两种成片、XML、输入与恢复截图、`export-first.png` / `export-second.png`、`separate-pixel-verification.json`。
- `output/electron-macos/ui-MNSZpN/report.json`：批量验收。
- `output/macos-post137/playback-evidence/report.json`：比赛素材播放检查（原始临时目录已复制到这里）。
- 应用：`out/TTcut-darwin-arm64/TTcut.app`。这是本次本地验证包，旧 `out/make` 下的 DMG/ZIP 不属于本次构建。

本任务未合并 `macos`、未发布新 Release、未生成新安装归档。未执行 Windows 机器/安装器、正式 Developer ID 签名、公证、跨机升级或分发验收；不把本次结果作为这些项目的通过证据。
