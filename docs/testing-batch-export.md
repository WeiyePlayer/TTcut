# 多任务合并导出验证

常规回归运行 `npm.cmd run typecheck` 和 `npm.cmd test`。合并相关用例覆盖
动态修改、添加文件等待、任务取消和重试、空片段、历史记录保留及完成后关机。

真实媒体测试需要将 `TTCUT_FFMPEG_INTEGRATION` 和 `TTCUT_FFPROBE_INTEGRATION`
设为对应可执行文件的绝对路径，并设置 `TTCUT_BATCH_ENCODER` 为该组件支持的
`libopenh264` 或 `libx264`。运行：

```text
npm.cmd test -- tests/batch-export.integration.test.ts
```

该测试生成混合尺寸、横竖屏、旋转、分数帧率、VFR 和有无音轨的素材，真实执行
合并导出，检查顺序、画面尺寸、黑边、时长和音画同步。将 `TTCUT_BATCH_TEST_ROOT`
设为一个已存在的输出目录（建议 `output/batch-export-validation`）可保留素材、
成片和 `validation.json`；未设置时使用临时目录并在测试后清理。

真实 Electron 检查先按上述路径保留成功的媒体测试产物，再运行：

```text
npm.cmd run package
node scripts/verify-batch-ui.cjs
```

界面检查沿用仓库的 `.baseline/electron-dev/43.1.1` Electron 和
`.baseline/components/ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1/bin`
媒体组件，加载本次打包生成的生产页面资源。使用独立用户目录和预置分析结果，
真实执行合并 IPC、历史读取、FFmpeg 和媒体预览。操作系统关机由测试拦截。
截图、成片、调用次数与 `evidence.json` 保存在 `output/playwright/batch-merge-*`。

预置分析结果只用于界面和导出回归，不构成球检测模型或真实比赛分析效果的验证。
