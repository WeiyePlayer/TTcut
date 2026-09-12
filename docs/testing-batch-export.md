# macOS 多任务合并导出验证

从 PR #96 移植“合并为一个视频”，以 macOS 分支为基础。多任务页面不提供
“完成本任务后关机”，完成、取消、失败及重试均不触发系统关机。

合并按视频添加顺序及各视频内片段时间顺序输出；“只分析”不参与，全部只分析时
禁用合并。未勾选时仍逐视频导出。输出为 H.264 / SDR BT.709 MP4，采用首个参与
视频的尺寸及帧率，保留宽高比并补黑边；需要音轨时统一为双声道 AAC，无声素材补静音。
文件保存在首个参与视频旁，重名自动编号，各视频仍保留独立分析记录。

```sh
npm run typecheck
npm test
mkdir -p output/batch-export-validation
TTCUT_FFMPEG_INTEGRATION="$PWD/.runtime/macos/bin/ffmpeg" \
TTCUT_FFPROBE_INTEGRATION="$PWD/.runtime/macos/bin/ffprobe" \
TTCUT_BATCH_ENCODER=libx264 \
TTCUT_BATCH_TEST_ROOT="$PWD/output/batch-export-validation" \
npm test -- tests/batch-export.integration.test.ts
node scripts/make-macos.mjs --app-only --skip-native
node scripts/verify-batch-ui.cjs
```

`--skip-native` 仅适用于已有有效 `.runtime/macos` 且原生代码未修改的情况。
真实媒体测试生成混合尺寸、横竖屏、旋转、分数帧率、VFR 和有无音轨的素材，检查
顺序、尺寸、黑边、时长、音画同步及逐帧时间间隔。原生探测器使用分段采样，其窗口
间隙可能将 CFR 标记为 VFR，因此 CFR 验证直接读取成片所有帧的时间戳。
素材、成片与 `validation.json` 保存在 `output/batch-export-validation/ttcut-merged-media-*`。

界面脚本从 `out/TTcut-darwin-arm64/TTcut.app` 提取未修改的 `app.asar`，使用
开发版 Electron 驱动相同生产资源及包内运行时，并设置独立用户目录。正式包禁用
Node inspect 和 E2E 环境覆盖，不能直接使用 Playwright Electron 驱动。文件选择
及标定/分析结果使用测试替身；真实执行合并 IPC、历史读取、FFmpeg 和媒体预览。
文件夹入口记录调用路径，系统关机调用被拦截并断言为零，同时检查没有关机选项。
截图、成片与 `evidence.json` 保存在 `output/playwright/batch-merge-*`。

预置分析结果仅用于界面及导出回归，不构成球检测模型效果或 HDR 素材合并验证。

## 本次验证（2026-09-06）

- 类型检查通过；完整 Vitest 为 307 通过、24 跳过、17 失败。
- 17 个失败均在未修改的基线 `63399a2` 隔离工作树复现，失败名称完全一致，
  涉及 Windows 安装/更新、组件状态及 README 文案检查。本次未修复这些既有问题。
- 真实随包 x264 媒体测试 4/4 通过；应用打包及 ad-hoc 签名校验通过。
- 生产资源界面验证通过：唯一合并选项、全只分析禁用、导出、播放及文件夹入口，
  无页面错误，关机调用为零。截图已人工检查。
- 界面证据：`output/playwright/batch-merge-1788706279316/evidence.json`。
  全量与基线日志：`output/batch-export-validation/vitest-full.log`、`vitest-baseline.log`。
