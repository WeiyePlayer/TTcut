# 杜比视界视频剪辑：不可写源目录自动改存到「影片/TTcut」

## Context

用户已有一条杜比视界分析记录（`杜比视界.mp4`，HEVC 10-bit 1080p，DV Profile 8.4／HLG 基础层，8 分钟，20 个回合，`original_vfr`）。这条记录目前无法剪辑。

核查结果：

- **杜比视界转换不是阻塞点。** develop 已包含 DV 8.1／8.4 → SDR BT.709 H.264 的自动色调映射，Windows 由 `src/domain/export-color-plan.ts` 负责，macOS 由 `macos/Sources/Media/ExportColorPlan.swift` 负责。`.scratch/hdr-export-xml/validation.md` 记录了它已用官方 DV 素材在真实 Electron 上验证过。
- **实际失败原因是输出目录不可写。** 该视频唯一一次导出的任务日志 `~/Library/Application Support/TTcut-Electron/logs/ce6ff403-….log` 记录的是 `OUTPUT_DIRECTORY_UNWRITABLE`。源文件位于微信沙盒 `~/Library/Containers/com.tencent.xinWeChat/...`，目录不可写。而所有导出都固定写到源视频旁边：
  - `App.tsx`／`MultiTaskPage.tsx` 固定传 `destination: 'source'`；
  - `chooseOutput` → `uniqueOutput` 写到 `path.dirname(input)`；
  - 自定义页的分段视频／XML 由 `createCustomArtifactDirectory` 在源目录旁建目录；
  - `batch-export.ts` 的预检和临时目录都用源目录。

用户决定：源目录不可写时，不弹窗，自动改存到 `~/Movies/TTcut`（`app.getPath('videos')/TTcut`）。结果页照常显示实际路径，并可打开所在文件夹（`App.tsx` 结果卡片已支持）。

## 方案

### 1. 共享输出目录解析（Main）

在 `src/main/export.ts`（或新建一个小模块 `src/main/output-location.ts`）新增 `resolveWritableOutputDirectory(sourcePath)`：

- 先在源目录做写探测，复用 `assertExportPreconditions` 现有的 `.ttcut-<id>.write-test` 方式（`open(..., 'wx')` 后删除）。
- 探测失败且错误码为 `EACCES`／`EPERM`／`EROFS` 时，`mkdir -p` 出 `app.getPath('videos')/TTcut` 并返回这个目录；回退目录也不可写时，仍抛 `OUTPUT_DIRECTORY_UNWRITABLE`。
- 其他错误（如 `ENOENT`、源已移动）保持现有行为。
- 写日志：`Export output directory fallback: <source dir> -> <fallback>`。

### 2. 接入各导出入口

| 入口 | 改法 |
| --- | --- |
| `uniqueOutput(input, label)` | 增加可选的 `directory` 参数，默认仍为 `path.dirname(input)`。`chooseOutput` 的 `destination === 'source'` 分支传入解析出的目录；`prompt` 分支只是把对话框默认位置换成解析出的目录。 |
| `createCustomArtifactDirectory(input)` | 在解析出的目录下建 `<base>_TTcut_自定义[_n]`。 |
| `assertExportPreconditions` | 不改，它已经按 `path.dirname(output)` 探测，输出改到回退目录后自然通过。 |
| `src/main/batch-export.ts` | 预检和 `mkdtemp` 改用解析出的目录，最终产物也写到那里。 |

- 文件名规则、唯一后缀、partial／临时文件、发布和恢复逻辑都不变，只换目录。
- 跨进程契约不变：请求不新增字段，结果里的 `outputPath`／`outputDirectory` 已是实际路径。
- 可写目录的行为完全不变，Windows 同样适用（`videos` 即「视频」文件夹）。

### 3. 用真实杜比视界记录验收

仿照 `.scratch/hdr-export-xml/verify-electron.mjs`，在独立测试 profile 下运行开发构建：

- 只复制这条历史记录到测试 profile，源视频只读引用，不复制、不修改。
- 用 Playwright 驱动自定义页，按用户选定的两项验收：
  1. **合并视频**：选 3～4 个回合导出；
  2. **带记分牌导出**：同样的回合，开启记分牌。
- 对每个输出检查：
  - 文件位于 `~/Movies/TTcut`，结果页显示该路径；
  - `ffprobe`：h264、yuv420p、bt709 primaries／transfer／matrix、limited range；
  - 逐帧 side data 中没有 DOVI／HDR 元数据；
  - 完整解码无错误；时长与所选回合一致（容差沿用现有导出时长预算）；音频存在且同步；
  - 截取回合中段非黑画面，与源帧的色调映射参考对比，颜色和高光正常、没有偏灰或过曝；记分牌叠加在转换后的画面上；
  - 源文件 SHA-256 导出前后一致。
- 证据（report.json、截图、命令输出、主机、提交号）记入 `.scratch/dolby-vision-export/validation.md`。Windows 实机未执行，明确标为未验证。
- 验收中若暴露真实 DV 素材的新缺陷（如 VFR 下长片段的参数集重试、时长漂移），在同一张验收票内复现、补回归测试并修复。

## 票据（批准后由 /to-tickets 写到 `.scratch/dolby-vision-export/issues/`）

1. **源目录不可写时导出自动改存到「影片/TTcut」**（单视频页、自定义页合并／分段／XML）。前置：无。
2. **批量导出同样改存**。前置：1（复用解析函数）。
3. **用 `杜比视界.mp4` 真实验收自定义页合并视频与带记分牌导出**，并修复暴露的缺陷。前置：1。

之后用 /implement-spec 在集成分支 `auto/dolby-vision-export` 上实现：每张票在独立 worktree 里按 TDD 实现，合并后做代码审查并修复，最后清理 worktree。不推送、不开 PR，除非用户另行要求。

## 关键文件

- `src/main/export.ts`：`uniqueOutput`、`chooseOutput`、`createCustomArtifactDirectory`、`assertExportPreconditions`、导出错误分类（约第 1131 行）
- `src/main/batch-export.ts`（第 68–70 行）
- 测试：`tests/` 下现有 export／batch-export 测试，用临时只读目录（`chmod 0555`）模拟不可写源目录，并 mock `app.getPath('videos')`
- 参考：`.scratch/hdr-export-xml/verify-electron.mjs`、`.scratch/hdr-export-xml/validation.md`

## 验证

- 单元测试：
  - 源目录可写时输出路径不变；
  - 不可写时三种自定义产物、`destination: 'source'` 和批量导出都落到回退目录，并处理同名后缀；
  - 回退目录也不可写时报 `OUTPUT_DIRECTORY_UNWRITABLE`；
  - `ENOENT` 等其他错误不触发回退。
- `npm test`、`npm run typecheck`。
- 真实 Electron + 真实 DV 视频：按第 3 节逐项记录证据；未执行的项目写明未验证。
