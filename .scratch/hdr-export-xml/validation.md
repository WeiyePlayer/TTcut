# HDR 导出与 XML 修复验收

Windows 实机后续验收见 [2026-10-29 Windows 验收记录](../../docs/windows-hdr-export-xml-validation-2026-10-29.md)。下方为此前 macOS 主机上的实现和验收记录。

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
- 2026-10-27 审计发现的六项 Spec 缺口及 HEVC seek 重试风险按本地工单 04 修复；2026-10-28 完成增量两轴复审和以下 macOS Electron 场景，Windows 实机及 Premiere 导入仍待验收。
- 2026-10-28 集成复审补充：真实 HistoryStore + startExport 和生成的 H.264/AAC 文件验证缓存视频全损、后半段损坏、音频损坏、完整缓存、探测不可用、检查中取消及回源合并视频并写回历史；macOS arm64 原生 probe／worker 与 macOS 上模拟 Windows 路由均通过。使用随包 macOS FFprobe 的相关定向测试 **14 passed**，相关 TypeScript 测试 **45 passed，1 skipped**，类型检查通过。流式 HDR 校验的异常 stderr 由实际高输出子进程验证上限 16,384 字符。新增完整音视频解码带来的性能开销尚未测量；合法无报错的内容变化因旧缓存无内容哈希仍无法证明不存在。Windows 实机和 Premiere 导入仍待验收。
- 同日 macOS arm64 并行负载下，对真实 4K/60 HDR10+ 16–21 秒湖景窗口做 ffprobe 视频帧扫描：`-threads 1` 为 20.581 秒、`-threads 0` 为 10.970 秒。此为原始动态 HDR 视频的单次比较，不是实际分析 CFR 缓存或完整导出耗时；音频扫描也会另加开销，不能外推到其他素材和平台。完整扫描可能慢于实时。整片单线程扫描运行约 98 秒仍未结束并被终止，不报告整片耗时。
- 后续复审：在真实 HistoryStore 和 startExport 边界覆盖合并导出预检期间的取消、无解码错误的 AAC 音频尾段丢失、健康 AAC/MP3/ALAC、双产物复用及文件改写／替换／复制中变更／复制失败。延迟 IPC 回复的页面回归覆盖批量页早到失败、取消，以及单视频页取消后不恢复已结束任务。相关真实媒体测试 **27 passed**，TypeScript 与页面定向测试 **123 passed，1 skipped**；额外的真实 HDR10+／DV 媒体回归 **26 passed**。这些 Windows 路由仍在 macOS 模拟运行。
- 再次复审：真实 H.264/AAC 文件通过修改 MP4 音频时间表构造样本数正常但 PTS 重叠／尾部缺失的缓存；XML 回源，并回归健康 AAC、MP3、ALAC。合并视频与 XML/分段测试覆盖源在完整扫描、XML 写入、渲染和失败恢复期间变化，已发布 XML 保留；磁盘不足／目录不可写时已有目标文件与历史保持不变。macOS 原生慢 probe 在任务注册后可取消，普通历史打开依旧严格；批量页覆盖分析任务 ID 延迟、提前失败和取消后真实错误。真实媒体边界测试 **40 passed**，相关 11 个 TypeScript／页面测试文件 **145 passed，3 skipped**，类型检查通过。源身份仍以既有路径、大小和修改时间为准，无法证明刻意保留这些属性的内容未被替换；Windows 实机与 Premiere 导入待验收。
- 取消边界补充：实际 `startAnalysis` 的模拟 Windows 路径验证错误分类后延迟日志期间收到取消仍保留 `WORKER_EXITED` 及原因，页面回归显示该错误；显式取消仍正常停止。真实 HistoryStore/FFmpeg 回归覆盖最终验证、发布 rename、失败恢复 probe/rename/日志和阻塞 CFR 流复制期间取消，检查唯一终止事件及清理；文件已经提交、正在写历史时则保留成功结果。恢复 probe 期间原素材或缓存改变不会认领部分文件。真实媒体边界 **54 passed**，12 个相关 TypeScript／页面文件 **147 passed，3 skipped**，真实 HDR10+／DV 回归 **26 passed**，类型检查通过。Windows 路径在 macOS 模拟，非 Windows 实机通过。
- 最终 macOS Electron 验证：在集成提交 `7807db57` 使用实际应用、原生 worker 和独立 profile，健康 CFR 缓存经流式复制后与原缓存 SHA-256 一致、完整解码，XML 引用副本；真实 4K 缓存完整扫描期间点击取消，收到唯一 `EXPORT_CANCELLED`，未留下临时视频。此前在 `a87abc20` 以视频后 90/120 帧损坏的缓存验证 XML 回源；在 `ef3a31a2` 用真实 HDR10+ 验证合并视频、分段 + XML、实际输出颜色、预览解码帧推进、音画提示点及日志路径不可写。详见下方独立报告；不同提交的检查不应合并表述为同一次运行。

- 集成后的 App、export-start、export-history、history 定向检查：**78 passed，3 skipped**；类型检查、脚本语法和 `git diff --check` 通过。共享两平台自动色彩策略 10 项通过。
- 在 `bb5405d2` 执行一次全量 TypeScript 测试：**633 passed，12 failed，48 skipped**，未宣称全量全绿。对未修改基线独立执行得到 **602 passed，12 failed，45 skipped**：既有失败包含 analysis-cleanup、Windows 路径布局、Windows probe 测试桩及缺失 `powershell.exe`。本分支已修正已有的 batch 测试平台断言；全量中另一次进程组时序失败在隔离复查通过（2 passed），analysis-cleanup 两项与基线一致且在最终修复后的 macOS 定向复查仍失败。本次未扩大到无关运行时修复。
- **Windows 实机／安装包、签名、Premiere 实际导入未验证。** 用户提供的是 Windows 日志，无法用 macOS 上模拟的 Windows 路由代替实机验收。原报告中的比赛源视频未提供，本次真实 Dolby 验证使用官方素材。
- 可自动转换范围为 HDR10+ PQ，以及带已确认兼容基础层的 Dolby Vision 8.1／8.4。未知／不兼容 Profile 提供具体转换指引，XML 仍单独尝试。

## 审查

### Standards

最终增量复审无新增可证实问题。此前发现的批量分析延迟取消及 `WORKER_EXITED` 误分类均已修复；最终复审为只读，未重复运行测试。

### Spec

初审和后续复审发现的草稿保存、XML 隔离、CFR 内容与音频时间戳、已有目标文件、源身份和取消时序问题均已补回归修复。最终增量复审无新增可证实问题，复跑了最终校验／恢复／慢复制取消、源变化、旧目标文件及部分产物保留场景。

## 本地证据

- Electron HDR 导出与结果播放：[report.json](../../output/hdr-export-xml/electron-XIAHvb/report.json)、[DV8.1 截图](../../output/hdr-export-xml/electron-XIAHvb/dv81-sdr-preview.png)、[DV8.4 截图](../../output/hdr-export-xml/electron-XIAHvb/dv84-sdr-preview.png)。
- 实际 XML 故障界面：[report.json](../../output/hdr-export-xml/electron-mWPcLJ/report.json)、[缓存消失后 XML 成功](../../output/hdr-export-xml/electron-mWPcLJ/xml-after-cache-disappears.png)、[记分牌失败保留 XML](../../output/hdr-export-xml/electron-mWPcLJ/xml-retained-scoreboard-failure.png)。
- 最终 Electron：[健康 CFR 复制及 XML](../../output/hdr-export-xml/audit-cfr-copy-electron-QoUcQU/report.json)、[4K 扫描中取消](../../output/hdr-export-xml/audit-cancel-electron-ub8jF9/report.json)；此前 [损坏 CFR 的 XML 回源](../../output/hdr-export-xml/audit-cfr-electron-cfc8Fz/report.json)、[真实 HDR10+ 导出与播放](../../output/hdr-export-xml/audit-electron-i6MezV/report.json)。
- 基线完整结果：`output/hdr-export-xml/baseline/tests.json`；进程复查：`output/hdr-export-xml/process-tests.json`；原生媒体输出：`output/hdr-export-xml/native/`。
- 官方素材位于 `/tmp/ttcut-hdr-export-samples/`。DV8.1 SHA-256：`5f9e9b1a6892853f95cad06a0c104bd0d857580ea0ea52bca2ef2034c1e11334`；DV8.4：`d81d4c17958946796f30ca28a57776cee187a421649058767c8496cbc1e469bf`。来源与大小见该目录 `original-manifest.json`。
- `verify-electron.mjs` 使用本地开发构建与独立测试 profile；默认验证真实 Dolby 导出，`--xml-failures-only` 只验证新补充的界面故障路径。

集成工作树保留供审阅。基线和先前审查修复工作树已归档；本次审计修复及 01／02／03 实施工作树在完成后重试安全归档，均被应用的 `Another active task still uses this worktree` 保护拒绝，未绕过保护强删。代码均已合入，必要媒体证据已另存。原始 `main` 检出和未跟踪的 `macos/` 保持原样。
