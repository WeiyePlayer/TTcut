# HDR 导出与 XML 修复验收

2026-10-26，macOS arm64。分支 `fix/hdr-export-xml` 基于 Windows 1.3.10 的 `285fa450cd8f31fc79502cc0db5803ab8626033a`。3 张本地工单均已实现；未发布安装包、远端工单或 PR。

## 已验证行为

| 路径 | 证据与结果 |
| --- | --- |
| Windows TypeScript 导出路径 | macOS 主机运行真实 FFmpeg，并模拟 `win32` 路由。原有 HDR10+ 测试使用 `testsrc2` 合成画面和有效 T.35 元数据，不是真实 HDR 成片；Dolby Vision 8.1／8.4 使用原始位流。此项不代表 Windows 实机通过。 |
| macOS 原生媒体导出 | 原有新增媒体 4 项、相关回归 10 项通过。原有 HDR10+ 测试使用合成画面；非黑场 Dolby 位流为真实素材。分析 CFR 归一化仍保留原保护策略。 |
| 实际 Electron + 原生 worker | DV8.1／8.4 各完成合并视频、分段视频 + XML；结果页真实播放并推进解码帧，源文件 SHA-256 不变。截图已检查，包含实际颜色与高光画面。 |
| XML 与视频隔离 | 真实文件系统验证视频准备失败/XML 成功，以及 XML 写入失败/视频成功并完整解码；保留成功文件，只报告实际请求的产物。 |
| 实际自定义界面故障 | 缓存消失后草稿保存失败仍导出 XML，且不改写持久分析记录；XML-only 跳过已启用的记分牌字体／图像准备。同时请求视频和 XML 时，字体失败通过受限的 `SCOREBOARD_RENDER_FAILED` 交给 Main，视频明确失败而 XML 保留。 |
| 时间与历史 | 真实 HistoryStore + startExport 验证 Windows/macOS 缓存回源；原素材指纹变化仍拒绝。29.97／59.94 的 600 秒剪辑点分别为 17982／35964 帧，保持 xmeml NTSC 标记。 |

真实 Dolby 位流在非零 seek 后会出现缺失 HEVC 参数集的错误，测试先复现导出失败，再验证只对相应诊断重试从源起点解码；剪辑边界、颜色目标与算法不变。验收采用 15 秒处的非黑画面，开头黑场仅用于早期解码检查，不作为颜色证据。

## 检查结果与限制

- 2026-10-27 补充修复：真实 [FF Pictures HDR10+ 实景测试片](https://ff.de/hdr10plus-metadata-test/) 从 [Internet Archive 镜像](https://archive.org/details/hdr10test_lake_2021_02_01) 获取，522323676 字节，SHA-256 `ff0aa117f4622387d7d76a33fb6094cb576dab8b8cb59fe18047a614c0e92a5f`；其 MD5 与镜像发布记录一致，官方网页未提供哈希。16–16.5 秒非黑画面在 macOS 原生 compatible／fast 算法以及 macOS 主机模拟 Windows TypeScript 路径均已导出 SDR，完整解码、逐帧 HDR 元数据清除、与仅改标签的像素差大于 5、源文件 SHA-256 前后不变。此项仍不代表 Windows 实机验收。
- 审计修复定向检查：TypeScript 9 个文件 **113 passed，3 skipped**，类型检查通过；真实 FFmpeg 媒体集成 **26 passed**。原生真实 HDR10+、DV8.1／8.4、HDR10／HLG、后续帧静态 HDR 残留及 seek 参数集测试通过（5 项）；HDR10+ 两种原生算法的 SDR 与仅改标签对照平均 RGB 差均为 26.735。转换输出校验增加逐帧流式解码检查，性能开销尚未独立测量。
- 2026-10-27 审计发现的六项 Spec 缺口及 HEVC seek 重试风险按本地工单 04 修复；集成两轴复审、最终 Electron 验证、Windows 实机及 Premiere 导入仍待完成。
- 2026-10-28 集成复审补充：真实 HistoryStore + startExport 和生成的 H.264/AAC 文件验证缓存视频全损、后半段损坏、音频损坏、完整缓存、探测不可用、检查中取消及回源合并视频并写回历史；macOS arm64 原生 probe／worker 与 macOS 上模拟 Windows 路由均通过。使用随包 macOS FFprobe 的相关定向测试 **14 passed**，相关 TypeScript 测试 **45 passed，1 skipped**，类型检查通过。流式 HDR 校验的异常 stderr 由实际高输出子进程验证上限 16,384 字符。新增完整音视频解码带来的性能开销尚未测量；合法无报错的内容变化因旧缓存无内容哈希仍无法证明不存在。Windows 实机和 Premiere 导入仍待验收。
- 同日 macOS arm64 并行负载下，对真实 4K/60 HDR10+ 视频的同一 5 秒窗口做 ffprobe 视频帧扫描：默认线程约 4.05 秒，输入参数 `-threads 0` 约 1.67 秒；完整 CFR 检查采用自动解码线程。此为单次比较，非完整 CFR 导出耗时或其他平台的性能保证，音频扫描也会另加开销。

- 集成后的 App、export-start、export-history、history 定向检查：**78 passed，3 skipped**；类型检查、脚本语法和 `git diff --check` 通过。共享两平台自动色彩策略 10 项通过。
- 在 `bb5405d2` 执行一次全量 TypeScript 测试：**633 passed，12 failed，48 skipped**，未宣称全量全绿。对未修改基线独立执行得到 **602 passed，12 failed，45 skipped**：既有失败包含 analysis-cleanup、Windows 路径布局、Windows probe 测试桩及缺失 `powershell.exe`。本分支已修正已有的 batch 测试平台断言；全量中另一次进程组时序失败在隔离复查通过（2 passed），analysis-cleanup 两项与基线一致仍失败。本次未扩大到无关运行时修复。
- **Windows 实机／安装包、签名、Premiere 实际导入未验证。** 用户提供的是 Windows 日志，无法用 macOS 上模拟的 Windows 路由代替实机验收。原报告中的比赛源视频未提供，本次真实 Dolby 验证使用官方素材。
- 可自动转换范围为 HDR10+ PQ，以及带已确认兼容基础层的 Dolby Vision 8.1／8.4。未知／不兼容 Profile 提供具体转换指引，XML 仍单独尝试。

## 审查

### Standards

0 项发现。历史回源保留原素材指纹校验，仅返回任务内克隆；源／目标色彩策略集中于两平台模块，并由共享样本约束。

### Spec

初审 2 项 P2：草稿保存仍可能阻止导出；XML-only 仍依赖记分牌准备。均通过 red → green 回归修复，复查关闭；同时请求两类产物的字体／画布故障也已覆盖，无新增可操作发现。

## 本地证据

- Electron HDR 导出与结果播放：[report.json](../../output/hdr-export-xml/electron-XIAHvb/report.json)、[DV8.1 截图](../../output/hdr-export-xml/electron-XIAHvb/dv81-sdr-preview.png)、[DV8.4 截图](../../output/hdr-export-xml/electron-XIAHvb/dv84-sdr-preview.png)。
- 实际 XML 故障界面：[report.json](../../output/hdr-export-xml/electron-mWPcLJ/report.json)、[缓存消失后 XML 成功](../../output/hdr-export-xml/electron-mWPcLJ/xml-after-cache-disappears.png)、[记分牌失败保留 XML](../../output/hdr-export-xml/electron-mWPcLJ/xml-retained-scoreboard-failure.png)。
- 基线完整结果：`output/hdr-export-xml/baseline/tests.json`；进程复查：`output/hdr-export-xml/process-tests.json`；原生媒体输出：`output/hdr-export-xml/native/`。
- 官方素材位于 `/tmp/ttcut-hdr-export-samples/`。DV8.1 SHA-256：`5f9e9b1a6892853f95cad06a0c104bd0d857580ea0ea52bca2ef2034c1e11334`；DV8.4：`d81d4c17958946796f30ca28a57776cee187a421649058767c8496cbc1e469bf`。来源与大小见该目录 `original-manifest.json`。
- `verify-electron.mjs` 使用本地开发构建与独立测试 profile；默认验证真实 Dolby 导出，`--xml-failures-only` 只验证新补充的界面故障路径。

集成工作树保留供审阅。基线和审查修复工作树已归档；01／02／03 工作树的安全归档被应用的 `Another active task still uses this worktree` 保护拒绝，已停止子代理并尝试释放，未绕过保护强删。代码均已合入，必要媒体证据已另存。原始 `main` 检出和未跟踪的 `macos/` 保持原样。
