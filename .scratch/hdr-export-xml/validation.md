# HDR 导出与 XML 修复验收

2026-10-26，macOS arm64。分支 `fix/hdr-export-xml` 基于 Windows 1.3.10 的 `285fa450cd8f31fc79502cc0db5803ab8626033a`。3 张本地工单均已实现；未发布安装包、远端工单或 PR。

## 已验证行为

| 路径 | 证据与结果 |
| --- | --- |
| Windows TypeScript 导出路径 | macOS 主机运行真实 FFmpeg，并模拟 `win32` 路由。HDR10+ 真实 T.35 元数据、Dolby Vision 8.1／8.4 原始位流均转为 H.264、8-bit、4:2:0、有限范围 BT.709；完整解码、像素与仅改标签对照、所有帧无 HDR side data 均通过。此项不代表 Windows 实机通过。 |
| macOS 原生媒体导出 | 新增媒体 4 项、相关回归 10 项通过。覆盖两种算法、单段／多段、非黑场 Dolby 素材、HDR10+、转换后记分牌白色、音画同步、VFR、旋转／SAR、取消及 HDR10／HLG 保真。分析 CFR 归一化仍保留原保护策略。 |
| 实际 Electron + 原生 worker | DV8.1／8.4 各完成合并视频、分段视频 + XML；结果页真实播放并推进解码帧，源文件 SHA-256 不变。截图已检查，包含实际颜色与高光画面。 |
| XML 与视频隔离 | 真实文件系统验证视频准备失败/XML 成功，以及 XML 写入失败/视频成功并完整解码；保留成功文件，只报告实际请求的产物。 |
| 实际自定义界面故障 | 缓存消失后草稿保存失败仍导出 XML，且不改写持久分析记录；XML-only 跳过已启用的记分牌字体／图像准备。同时请求视频和 XML 时，字体失败通过受限的 `SCOREBOARD_RENDER_FAILED` 交给 Main，视频明确失败而 XML 保留。 |
| 时间与历史 | 真实 HistoryStore + startExport 验证 Windows/macOS 缓存回源；原素材指纹变化仍拒绝。29.97／59.94 的 600 秒剪辑点分别为 17982／35964 帧，保持 xmeml NTSC 标记。 |

真实 Dolby 位流在非零 seek 后会出现缺失 HEVC 参数集的错误，测试先复现导出失败，再验证只对相应诊断重试从源起点解码；剪辑边界、颜色目标与算法不变。验收采用 15 秒处的非黑画面，开头黑场仅用于早期解码检查，不作为颜色证据。

## 检查结果与限制

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
