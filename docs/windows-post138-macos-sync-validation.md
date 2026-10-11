# Windows 同步 macOS 编辑器更新验收

验收日期：2026-10-11（Asia/Shanghai）。

分支：`codex/windows-sync-macos-post-v1.3.8`。Windows 基线为 `develop` 的 `bd5cc9c3c263009e0dd3c0c97cff62b7e26221d3`，执行前已 fetch，确认本地与 `origin/develop` 一致且工作区干净。macOS 对照为 `533018878dcaba8ee0ce9359a602def5dee5b6f6`。

## 同步范围

| 来源 | Windows 中的结果 |
| --- | --- |
| [PR #123](https://github.com/WeiyePlayer/TTcut/pull/123)，`e20a320` 及样式更新所需的显示尺寸适配 | 补齐视频开头、回合间隙和结束后的比分编辑；开始编辑时暂停；间隙不可点击胜方；统一旋转后的显示尺寸计算。该 PR 的其余编辑器功能已包含在 Windows v1.3.8。 |
| [PR #124](https://github.com/WeiyePlayer/TTcut/pull/124)，`a632784` | 经典蓝、橙、绿横条及红蓝双牌；设置中的可视化选择；保存设置；预览、PNG 与 FFmpeg 导出的样式和尺寸一致。旧数据保留经典蓝色样式。 |
| [PR #125](https://github.com/WeiyePlayer/TTcut/pull/125)，`bf6e135` | 剃刀分割、播放头吸附、一帧边界限制、板数重算、100 步撤销重做、比分红点、操作指南和草稿恢复；允许同一识别回合关联多个导出片段。 |

Windows 保留 libmpv 原片预览、DirectML 分析和现有 FFmpeg 导出链路。新样式同时适配原生 ASS 绘制、原生编辑框、双牌命中区域和拖放边界。原生视频窗口支持 Ctrl+Z、Ctrl+Y、Ctrl+Shift+Z；打开指南时暂停并隐藏原生子窗口，关闭后恢复显示。截图复核发现并消除了渐变条带间的细横纹。

没有合入 macOS Swift 实现、macOS 运行时/验收脚本、版本更新或发布配置。应用版本保持 `1.3.8`，此次分支仅本地提交，未推送、合并或发布。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过；最后一次检查覆盖新增 Windows 回归测试。 |
| 全量 Vitest | 76 个文件通过、6 个文件跳过；577 项通过、25 项跳过。 |
| 最终 Windows 原生/样式专项 | 4 个文件、22 项通过；包含子窗口避让指南、原生快捷键、双牌编辑和旧样式兼容。 |
| 操作指南真实 Electron | 7 项通过：首次打开、暂停、焦点、快捷键隔离、中英文截图、840×520 最小窗口及应用弹窗切换。 |
| 剃刀真实 Electron/解码视频 | 9 项通过：吸附、红点、撤销重做、缩放/滚动、连续和循环播放、播放中分割。 |
| Windows 原生预览与真实导出 | 12 项通过；四种样式逐一验证原生像素、Canvas PNG、实际视频和源音轨；检查姓名/数字编辑、滚轮、胜方、拖动、缩放、间隙及指南。渐变修复后重跑相关 7 项，全部通过。 |
| 最终随包 Windows 程序 | 10 项通过：实际设置保存、原片首帧/播放/暂停、重开、定位和拖动、剃刀、草稿、真实 HWND 焦点下的撤销重做、指南偏好及 Main IPC 导出。 |
| 分割导出 | 同一检测回合拆成两个片段；随包程序合并导出成功，视频和音轨可读取，画面可解码。目标时长 5.200000 秒、实际 5.223307 秒，漂移 0.023307 秒，小于允许的 0.117100 秒。 |
| 构建与静态检查 | 原生 C++ 构建、`npm.cmd run package`、最终原生修复后的 Electron Forge 重建、差异检查通过；随包原生 manifest/buildHash 和实际 EXE SHA-256 与暂存内容一致。 |

验收使用 `张要举.MOV` 原片，以及历史分析对应的 `Maharu Yoshimura vs Andrej Gacina - MS Final - WTT Feeder Istanbul 2026.mp4`。随包导出使用验收目录内的原片副本和独立用户配置，未修改原始分析或用户历史。

## 本地证据与交付

- 指南：`output/custom-guide/verify-gmpCnG/report.json`。
- 剃刀：`C:/WINDOWS/Temp/ttcut-playback-kDgU8i/report.json`。
- 完整原生验收：`output/playwright/scoreboard-overlay-rWCCd1/report.json`。
- 最终渐变/样式复核：`output/playwright/scoreboard-overlay-IHFU1K/report.json`，含 `red-blue-native.png` 和四种导出画面。
- 最终随包验收：`output/playwright/packaged-native-Vi84pK/report.json`，含设置、导出完成页、`packaged-export-frame.png` 和实际导出视频。
- 本地测试应用：`out/TTcut-win32-x64/TTcut.exe`，需保留整个同级应用目录。EXE SHA-256：`f6730c2cbe385548e0bd3a3e7e6dcb90099a4213e98d90ae8172c12fca6f0d28`，Authenticode 状态为 `NotSigned`。

上述输出目录由 `.gitignore` 排除。构建与验收中遇到的 FFmpeg 文件占用、测试脚本时间格式/微秒精度及物理输入焦点问题均已处理，并以最终成功记录为准。

## 验收边界

本次验证编辑器、原片预览、持久化与导出功能。没有重新评估球检测/回合识别算法效果，没有运行 Python Worker 全量测试，没有制作或安装 NSIS 安装器，没有执行升级、正式签名、公证或远端发布，也没有在 macOS 上重新运行原生验收。
