# Windows HEVC 自定义预览

## 已确认的问题与边界

- 提供的两份文件实际位于 `D:\DOCUMENTS\TrackNetV3_TableTennis\testvideoes`。`尼浩杰.MOV` 和 `张要举.MOV` 都是 1920×1080、约 59.94 fps 的 HEVC Main / yuv420p 视频，音频为 AAC，还带有多条数据流。时长分别为 1120.086667 秒和 567.525011 秒。
- 旧实现先让 Chromium 直接加载原片，仅在媒体错误、缺少画面尺寸或事件启动的超时检查后准备兼容预览。`readyState < 1` 时的回合播放请求只排队，不会主动启动恢复；重复的 waiting/seeking 等事件还会重新计时。这不足以保证每台 Windows 设备在 HEVC 跳转失败后恢复。
- 本机未复现反馈设备上的原生解码故障，不能确认具体显卡、驱动或系统解码组件是故障来源。确认的是兼容策略依赖原生解码结果，存在事件覆盖盲区。
- 原 `verify-custom-playback.mjs` 会先把任意输入转成 30 秒 H.264，所以把 MOV 传给旧脚本不等于验证了原始 HEVC 路径。

## 修复

- Windows 自定义页面遇到已探测为 HEVC 的播放文件时，直接调用已有兼容预览服务，生成 H.264 / yuv420p / AAC 副本，不再等待原生 HEVC 解码报错。
- 按实际选择的播放文件区分 `source_video` 与分析用的 `video` 元数据，避免将固定帧率 H.264 副本的编码信息用于原始 HEVC。
- 复用已有的请求合并、缓存、完整时长校验和播放意图保存。准备期间最后选择的回合与暂停操作继续生效。分析及导出仍使用原来的媒体。
- 普通 H.264 播放与 macOS 原生预览流程不变。首次打开 HEVC 需要等待完整兼容预览生成，耗时取决于视频长度和设备性能。

## 验证方式

相关回归覆盖 Windows HEVC 无媒体事件时主动准备、恢复最后一次回合选择、播放文件编码匹配、H.264 与 macOS 路径，以及已有的代理加载与播放/暂停控制。

新增的实际媒体入口：

```text
node scripts/verify-custom-playback.mjs "D:\DOCUMENTS\TrackNetV3_TableTennis\testvideoes\张要举.MOV" --original-media
node scripts/verify-custom-playback.mjs "D:\DOCUMENTS\TrackNetV3_TableTennis\testvideoes\尼浩杰.MOV" --original-media
```

此入口使用完整原文件、真实 Windows Electron、自定义页面、`ttcut-media` 协议和生产预览服务。测试只将媒体组件发现替换为测试机 FFmpeg / ffprobe / libx264；探测、转码参数、进程执行、输出校验及缓存发布使用生产实现。硬件加速关闭，回合由测试构造，逐项检查播放位置与解码帧增加，不运行视频分析、完整应用工作流或安装器。

## 本次结果

- 受影响的四组单元/组件测试合计 57 项通过；类型检查通过。
- 两份完整原片的生产预览服务转码及输出校验均通过。首次实际 UI 检查均通过列表播放、空格恢复和片尾跳转，随后在长时间轴上沿用短片坐标点击导致测试失败；没有将该轮记录为整组通过。
- 调整完整视频用例为列表向前/向后跳转，使用 `--reuse-preview=<本轮生成的完整预览>` 重试，并再次核对输出编码和完整时长。两份视频各 17 项检查全部通过，无页面异常；普通 H.264 短片的原 16 项检查也全部通过，包含实际时间轴点击和结果预览。
- `张要举.MOV` 在约 555.56 秒、`尼浩杰.MOV` 在约 1108.23 秒跳转后，播放时间和解码帧计数继续增加。截图确认监视窗口显示了视频画面。
- 本机报告、截图与完整转码日志保存在 `output/playwright/mov-preview-20260915/`，分别为 `zhang-report.json`、`ni-report.json`、`h264-report.json` 及对应截图、转码日志。

未构建安装器、未发布，尚无反馈用户设备复测结果。
