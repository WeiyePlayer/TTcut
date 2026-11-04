# PR #115 macOS 适配与验收

验证日期：2026-09-26，macOS arm64。

分支：`auto/macos-sync-pr115`，基线 `macos` / `origin/macos`：
`2d568e20866b2ebeaec4c5a34aa255587bf6b151`。

来源：[PR #115](https://github.com/WeiyePlayer/TTcut/pull/115)，主要参考
`c7d220b4e0d820eb08ddb9855cff3b05ff11f7f0` 的预览修复和
`7526dcd3b87de7cd440f1ccb1dadea60030ba222` 的源时间回合判定。

## 范围

- 原生预览：Swift FFmpeg 滤镜实际转换到 limited range，并写入 `tv` 标记；校验接受 8-bit 4:2:0 H.264（包含合法 `yuvj420p`），比较视频轨道覆盖长度，而非音轨拖长的容器时长。视频轨道时长缺失时使用帧数 / fps，不从容器猜测。容许短差与上游一致：`max(1, min(5, duration * 0.005))` 秒。
- 预览缓存升级到 v3，缓存命中也执行相同校验；原生预览生成失败可以重试，代理解码失败显示错误且不无限自动重试。分析和导出仍使用原媒体，不使用预览代理。
- 回合判定：全帧推理不变，Swift 判定最高采用 30 Hz 的真实观测，保留源时间戳与原帧号，不对缺失球点插值；窗口算法和板数检测使用同一判定时钟。
- 持球停顿：有足够慢速观测支持才排除，真实横向 / 纵向飞行否决停顿；保留边界上下文和端视角豁免。新结果记录 `timebase.version=1` 与 `observed_pause` 排除区间。
- 自动 / 批量导出与自定义剪辑初始范围避让排除区间，不因短间隔合并或前后补偿重新接回停顿。用户后续手动编辑范围仍由用户决定。
- 保留 macOS `continuous_visibility`、无落台事件的有效回合和原有模型。旧历史不加新标记、不改变原有合并行为。

未同步 Windows VC++ / DLL / 组件安装修复，也未同步独立 Beta 打包、版本号、依赖、安装器或发布配置。

## 验证

- `npm run typecheck`：通过。
- 相关预览、契约、剪辑和 IPC 回归：76 通过；修改完成后的 macOS 专项：17 通过；新增 / 受影响前端和领域专项：50 通过（与前述测试有重叠，不相加）。
- `swift test --package-path macos --filter TTcutCoreTests`：19 通过，包括旧跨语言基线和新增源时间判定。
- `swift test --package-path macos --filter 'SourceTimeRalliesTests|MediaPreviewTests'`：7 通过。
- `TTCUT_NATIVE_TESTS=1 swift test --package-path macos --filter testPreviewConvertsActualFullRangeAndIgnoresLongerAudioTail`：1 通过。真实 full-range 输入、3 秒视频 / 5 秒音频，输出 90 帧、3 秒视频、`h264/yuv420p/tv`。
- PR #115 的 120 秒缓存轨迹经 Swift 回放：保留 4 段人工复核的运动核心，排除 47.1、62.7、66.8 秒三个持球时刻。30 / 60 / 120 fps 合成轨迹边界差不超过一个 30 Hz 采样间隔；12 / 15 / 24 / 30 fps 原观测保持不变。
- `npm run package:mac`：本地 arm64 应用打包与 ad-hoc 签名校验通过。不是正式签名 / 公证发布，未生成或上传本次发布资产。
- `npm run verify:mac`：21 项打包 Electron 检查全部通过。包含原生 Core ML、真实 120 fps 合成视频、源时间标记跨 IPC / 历史保存、full-range + 长音轨预览、跳转后至少 8 帧持续解码、缓存文件复用、HDR10 / HLG、VFR 缓存恢复、取消 / 子进程失败恢复、自定义界面和原生导出。
- 导出防误合并：使用受控回合 `[0.5, 2]`、`[4.5, 7.5]` 与排除区间 `[2.2, 4.3)`，在前补 2.5 秒 / 后补 2 秒时，实际原生导出时长约 7.4 秒，未恢复 2.1 秒的持球停顿。
- 本地完整报告：`output/electron-macos/run-zK9MSd/report.json`；同目录保留 Electron 日志、截图与生成素材。验收脚本明确按缓存文件而非一次性媒体 URL 判断复用，并在页面刷新后重新订阅测试事件。

### 全量 TypeScript 测试的环境限制

`npm test`：443 通过、8 失败、26 跳过。失败来自以下本次未修改的 Windows 假设或依赖，不计作通过，也未为本任务修改安装逻辑：

- `installation-layout.test.ts`：5 项，Windows 路径及注册表安装目录。
- `components.test.ts`：1 项，本机不存在 Windows 随包 FFmpeg 组件。
- `premiere-xml.test.ts`：1 项，测试期望 `file:///D:/` 的 Windows 路径转换。
- `update-manifest-signature.test.ts`：1 项，本机没有 `powershell.exe`。

### 证据边界

PR #115 的缓存轨迹来自 Windows DirectML 对 30 fps 转换视频的检测，Swift 回放验证的是判定算法，不是 macOS Core ML 对该比赛原片重新推理的准确率。120 fps 实际解码 / 推理验收使用合成视频；原始 120 fps 比赛视频和完整 33 分钟比赛尚未做 macOS 对照验收。没有 Windows 机器 / 安装器验收，也没有正式签名、公证、自动更新或发布验收。
