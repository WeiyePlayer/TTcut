# 杜比视界真实素材验收（票 03）

2026-11-09，macOS 27.0.1（26A434）、Apple M5、arm64。分支 `auto/dv-acceptance`，验收运行时 HEAD 为 `94e959a7`（票 01），加上本票未提交的色调映射修复（见下）；验收用的 TTcutMediaWorker 由本工作树 Swift 源码 release 构建，SHA-256 `fac16d76d803ab85ea59cedc6a191383d1d1b70566fc74c45d167a55e4c09307`。开发构建（`.vite/`，未打包）+ 真实 Electron + Playwright，独立测试 profile（`TTCUT_E2E_USER_DATA`）。

## 源素材与访问方式

- 历史记录 `5cbadae4-5106-4a94-87e5-654bce201e75`：DV Profile 8.4／HLG 基础层，HEVC 10-bit 1080p，481.8 秒，20 个回合，`original_vfr`。只复制这一条记录、对应 index 条目和封面到测试 profile，未写入用户真实 profile。
- 开始前核对：微信沙盒中的原文件 `stat` 为 424656024 字节、mtimeMs 1794141656312.3345，与记录一致。
- **直接读取微信目录未验证。** macOS App Data（TCC）保护拒绝本会话读取该文件：`head`、`ls`，以及开发版 Electron（直接子进程和 `open -n -a` 两种方式）均返回 `EPERM`。
- 因此验收使用**用户自行制作的副本** `/Users/weiye/Documents/杜比视界.mp4`。在专用目录 `/Users/weiye/Documents/ttcut-dv-acceptance/` 中用 `ln` 建硬链接（大小、mtime 与原记录一致），测试 profile 中记录的 `source.path` 及其他路径字段指向该硬链接。导出期间该目录 `chmod 0555`，用来模拟不可写的源目录（脚本确认 `access(W_OK)` 失败）。运行结束后已恢复 0755，删除硬链接和目录；用户副本保持原样。
- 源 SHA-256：导出前后均为 `526b18f689794502fb748e17e3579e608c2e2605f89f5e341788df3e7bfe784e`，大小和 mtime 不变；导出前后源目录内都只有该视频，没有遗留探测或临时文件。

## 命令

```sh
node scripts/make-macos.mjs --app-only --skip-native   # 只用于生成 .vite/；打包阶段因下载中断失败，见 package-macos.log
swift build --package-path macos -c release --product TTcutMediaWorker   # 修复后的 worker 放入工作树本地 .runtime/macos（manifest 已更新哈希）
TTCUT_DV_SOURCE=/Users/weiye/Documents/ttcut-dv-acceptance/杜比视界.mp4 node .scratch/dolby-vision-export/verify-electron.mjs   # 当时的调用；记录 ID 与 profile 写死在脚本中
```

脚本现已不再写死记录 ID、profile 路径和源路径，三者都必须显式传入（命令行参数或环境变量），缺任何一项都会打印用法并以退出码 2 结束：

```sh
node .scratch/dolby-vision-export/verify-electron.mjs \
  --record <历史记录 UUID> \
  --profile <含该记录的 TTcut userData 目录，只读取 history/records/<UUID>.json、封面和 settings.json> \
  --source <源视频的可读副本，运行期间其所在目录设为 0555>
# 等价环境变量：TTCUT_DV_RECORD_ID、TTCUT_DV_PROFILE、TTCUT_DV_SOURCE；可选 TTCUT_DV_RALLIES（默认 2,3,5,6）
```

本次验收对应的取值：`--record 5cbadae4-5106-4a94-87e5-654bce201e75 --profile "$HOME/Library/Application Support/TTcut-Electron" --source /Users/weiye/Documents/ttcut-dv-acceptance/杜比视界.mp4`。脚本只读取 `--profile`，写入的都是 `output/dolby-vision-export/electron-*/profile` 下的独立测试 profile。

选择回合 2、3、5、6，共 4 段，草稿边界合计 33.254 秒。脚本操作自定义页：取消全选，勾选这 4 个回合；第一次关闭记分牌导出合并视频，第二次重新打开历史并开启记分牌导出。

## 结果（修复后运行 `/Users/weiye/DOS/TTcut-windows/TTcut/output/dolby-vision-export/electron-lupqJv/`，全部通过）

| 验收项 | 合并视频 `杜比视界_TTcut_custom_3.mp4` | 带记分牌 `杜比视界_TTcut_custom_4.mp4` |
| --- | --- | --- |
| 输出位置 | `/Users/weiye/Movies/TTcut/`，结果页「Output path」显示完整路径 | 同左 |
| 回退日志 | `Export output directory fallback: /Users/weiye/Documents/ttcut-dv-acceptance -> /Users/weiye/Movies/TTcut`（两次导出各一条） | 同左 |
| ffprobe | h264／yuv420p／bt709 primaries・transfer・matrix／`tv`（limited） | 同左 |
| 逐帧 side data | 1002 帧，无 DOVI／Mastering／CLL／HDR10+；唯一类型为 x264 的 User Data Unregistered SEI | 同左 |
| 完整解码 | `ffmpeg -xerror … -fps_mode passthrough -enc_time_base:v demux -f null -` 退出 0，stderr 为空 | 同左 |
| 时长 | 33.275 秒（视频 33.254），目标 33.254，偏差 +0.021，允许 ±0.301 | 同左 |
| 音频 | AAC 2 声道 48 kHz，33.275 秒；4 段与源音频互相关，滞后均为 +21～22.5 ms（约 1 个 AAC 帧，阈值 45 ms），相关系数 0.77～0.95 | 同左 |
| 结果页播放 | 3 个拼接点前 0.5 秒 seek 后播放越过拼接点，每次解码 32～33 帧，无 media error | 每次 33 帧，无 media error |
| 记分牌 | — | 右上角记分牌区域与合并视频同帧差 85（阈值 15）；截图中可见叠加在转换后的画面上 |
| 运行时页面错误 | 无 | 无 |

## 发现并修复的缺陷：DV 8.4／HLG 导出发灰

第一次完整运行（`electron-uGlKaL/`，修复前 worker）中，除颜色外的项目都通过。但画面明显偏灰、偏亮：红色地胶和球衣呈浅粉色。

- 原因：两端导出色调映射都用 `tonemap=hable:desat=2`。HLG 经 `zscale … npl=100` 线性化后，参考白（约 203 nit）约等于 2.0，打光良好的地面正好超过去饱和阈值，被大幅去色。输出与 app 自身滤镜链的平均差只有 2.7，说明管线按设计执行，是参数问题。原生分析帧桥（`TTNative.cpp`）早已使用 `desat=0`。
- 修复：只对 HLG 传输（`arib-std-b67`，即 DV 8.4）使用 `desat=0`；PQ（DV 8.1、HDR10+）保持 `desat=2` 不变。改动文件为 `src/domain/export-color-plan.ts` 和 `macos/Sources/Media/ExportColorPlan.swift`。
- 回归：共享夹具 `tests/fixtures/export-color-policy.json` 为 HDR10+、DV 8.1、DV 8.4 写明期望的 tonemap 滤镜。TS（`tests/export-color-policy.test.ts`）和 Swift（`MediaFidelityPolicyTests`）先红后绿：修复前 DV 8.4 收到 `desat=2`，期望 `desat=0`。

同一方法（480×270 帧，回合中点，`colour-before.jsonl`／`colour-after.jsonl`）的修复前后对比：

| 回合 | 修复前 亮度／饱和度／溢出% | 修复后 亮度／饱和度／溢出% | 未转换 HLG 像素 亮度／饱和度 | 独立参考（npl=203，desat=0）亮度／饱和度 |
| --- | --- | --- | --- | --- |
| 2 | 170.6 / 0.118 / 3.88 | 118.8 / 0.391 / 0.41 | 141.8 / 0.202 | 100.4 / 0.389 |
| 3 | 169.5 / 0.124 / 3.77 | 117.5 / 0.400 / 0.45 | 140.6 / 0.210 | 99.3 / 0.397 |
| 5 | 171.2 / 0.116 / 4.30 | 118.9 / 0.392 / 0.39 | 142.2 / 0.201 | 100.5 / 0.390 |
| 6 | 169.7 / 0.120 / 3.07 | 117.8 / 0.395 / 0.37 | 140.9 / 0.204 | 99.4 / 0.393 |

修复后饱和度与独立参考一致，不再低于未转换的信号；顶灯高光未溢出（约 0.4%），画面不偏灰、不过曝。截图已逐张目视检查。

## 观察（未修改）：拼接点的极短帧

每个拼接点（第 301、502、751 帧）前一帧只显示 2.33 ms：片段按精确的剪辑终点截断，VFR 源最后一帧被截短。默认 `-f null` 解码会把时间戳舍入到 1/fps，因而对每个拼接点各报一次 `non monotonically increasing dts`。保留原时间戳解码时没有任何错误。实际结果页在三个拼接点处 seek、播放都正常（见上表和 `*-result-join*.png`）。此行为属于既有的精确时长策略，本票不修改。

## 测试

- `npm test`（vitest 全量）：**733 passed，104 skipped**（101 个文件，91 通过、10 跳过），见主检出的 `/Users/weiye/DOS/TTcut-windows/TTcut/output/dolby-vision-export/vitest-full.log`。
- `npm run typecheck`：通过。
- `TTCUT_NATIVE_TESTS=1 swift test --package-path macos --filter TTcutMediaTests`：**34 executed，3 skipped，0 failures**，见 `swift-media-tests.log`。另有 `swift-red.log`／`swift-green.log` 记录先红后绿；第一次全量运行因工作树缺少 `macos/Resources/Models` 有 2 项 `MODEL_MISSING`，链接模型后通过。

## 证据（主检出 `/Users/weiye/DOS/TTcut-windows/TTcut/output/dolby-vision-export/`，不提交）

验收时证据写在临时工作树内；工作树清理前已按相同相对布局复制到主检出的上述目录。下文相对路径均相对于该目录。

- 修复后：`electron-lupqJv/report.json`；结果页 `combined-result.png`、`scoreboard-result.png`、`*-result-join{1,2,3}.png`；中点帧 `frames/{combined,scoreboard}-rally{2,3,5,6}-mid.png`；对比图 `frames/*-compare.png`（输出｜独立 HLG→709 参考｜未转换像素）。
- 修复前：`electron-uGlKaL/report.json` 和同名截图。
- 修复前／后／参考三联图：`rally5-before-after-reference.png`。
- 首次因选择器问题中断的运行：`electron-EhFrKO/`；运行日志 `verify-run{1,2,3}.log`。
- 输出视频位于 `~/Movies/TTcut/`：`杜比视界_TTcut_custom.mp4`、`_2` 为修复前，`_3`、`_4` 为修复后。

## 未验证

- **Windows 实机：未验证。** TS 色调映射改动只经过单元测试，没有在 Windows 上做真实导出。
- 直接从微信沙盒目录读取源文件：未验证（App Data／TCC，见上）。
- 打包安装版、签名：未验证；本次只用开发构建。
- PQ（DV 8.1／HDR10+）参数未改，本次没有新的真实素材证据。
