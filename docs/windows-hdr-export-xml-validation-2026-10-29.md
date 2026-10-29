# Windows 动态 HDR 和独立 XML 导出验收

验收日期：2026-10-29（Asia/Shanghai）。本地分支 `codex/windows-sync-hdr-export-xml` 基于 `origin/fix/hdr-export-xml` 的 `ec1c1acd197a5de25f96e67de2f144c4c1501477`；该远端分支从 `develop` 的 `285fa450cd8f31fc79502cc0db5803ab8626033a` 向前 34 个提交，尚无 PR。此前 macOS 编辑器和运行时更新已在 Windows PR #126 和 #128 合入；macOS 主分支此后的 v1.3.10 交付记录不需要重复移植。面向 `main` 的 PR #129 是产品首页文档更新，不属于本次功能同步。

## Windows 适配

- 独立审计发现 macOS 的自定义剪辑初稿排除边界尚未带入 Windows：已让 hybrid v4 的默认片段沿用自动导出对已确认排除区间的限制，旧版历史不启用这项限制，用户仍可手动调整。
- 短回合优先在安全区间内补足一帧；若安全空间不足，不越界或静默丢弃，而由导出校验拦截并提示用户返回自定义编辑器调整或取消选择。相邻短片段的默认归一化和重新选择不会把边界推入排除区间。
- 旧历史回归夹具改用缺少保真元数据的原片，再验证重新探测和回源；新代码在已有可信元数据时可以复用该数据，不能一律要求探测。
- XML 测试按 `file://` URL 解析并比较原始路径，覆盖 Windows 反斜线与 URL 斜线的差异。
- 音频损坏夹具根据实际 MP4 时间表生成时间戳重叠，兼容 Windows FFmpeg 的单条 `stts` 项和 macOS 构建的两条项。额外验证音频帧数与流时长仍完整、内容检查仍拒绝该缓存。
- 新增 Windows 慢探测进程取消回归，确认已注册任务能够终止进程，仅发出一次取消事件且不留下输出。该项使用可控慢进程模拟探测，而实际 FFprobe 的完整解码另由下述媒体测试验证。
- 原有 Electron 验收脚本增加 Windows 随包程序和样片目录支持；另允许现有随包回归脚本接收真实 HDR10+ 输入。macOS 原有入口保留。

## Windows 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 与全量 Vitest | 类型检查通过；680 项通过、97 项按环境跳过，0 失败。全量运行不设置真实视频变量，因此媒体集成另行运行。 |
| 实际 FFmpeg 和历史 / XML | 最终代码 52 项通过、18 项跳过；覆盖原片回源、损坏视频或音频缓存、音频时间戳重叠、XML 独立输出、源文件变化、取消和输出发布清理。部分 macOS 测试或依赖 POSIX shell 的用例在 Windows 跳过。 |
| Windows 缓存探测中取消 | 新增独立回归 1 项通过；真实 Windows 子进程被终止，无输出残留。 |
| 比赛片段、批量合并和时间戳 | 实际 FFmpeg 检查 14 项通过、5 项环境跳过；包含真实比赛片段质量、混合帧率和音频批量导出、73 段 VFR、AAC 与拼接 DTS。 |
| 真实 HDR10+ | 使用 FF Pictures / Internet Archive 原始 HEVC 位流提取的非黑场片段，实际导出并全解码。逐帧检查无 HDR 残留，转换结果与仅修改色彩标签的错误基线平均 RGB 差值为 28.024；源片段 SHA-256 不变。 |
| 真实 Dolby Vision 8.1 / 8.4 | 两项实际 FFmpeg 测试通过：原始位流转为 BT.709、8 位 H.264，画面非黑、具有颜色和高光，逐帧无 HDR 残留，完整解码；原片哈希不变。 |
| 随包 Windows Electron | 使用独立 profile 和未签名测试程序，真实 HDR10+ 输入完成 Main IPC 导出；自动标定、120 帧 DirectML 分析、旧历史丢失 CFR 缓存恢复、HLG 导出和结果页播放通过。另用真实比赛视频及构造的 hybrid v4 分析记录，检查自定义剪辑初稿避开排除区间并完成视频导出；共 8 项、正常退出。该记录用于验证剪辑行为，不证明分析算法准确率。 |
| Dolby 随包 Electron | 原始 Dolby 8.1 / 8.4 分别完成合并视频、独立回合视频与 XML；两种合并结果在实际结果页播放并产生解码帧，共 4 项、正常退出。 |
| 真实 XML 故障界面 | 独立 XML 在 CFR 缓存消失、记分牌字体准备失败时仍成功；同时请求回合视频与 XML 时，记分牌失败被单独报告、XML 保留，共 2 项、正常退出。 |

## 样片和证据

- [Dolby 官方测试内容](https://github.com/DolbyLaboratories/dolby-vision-contents)：8.1 原片 SHA-256 `5f9e9b1a6892853f95cad06a0c104bd0d857580ea0ea52bca2ef2034c1e11334`；8.4 原片 `d81d4c17958946796f30ca28a57776cee187a421649058767c8496cbc1e469bf`，均已与官方 Git LFS 指针核对。
- [FF Pictures HDR10+ 测试片的 Internet Archive 镜像](https://archive.org/details/hdr10test_lake_2021_02_01)：本次从原始位流约第 15 秒开始无重编码提取约 3 秒，片段 SHA-256 `2eaef392b1ea473e8c7e151307c2797c17f9e9f079ff7696b8f96c0b5e2d1812`。并未下载并校验完整原片的 SHA-256。
- 全量测试：`output/playwright/windows-hdr-sync-20261029/full-tests-audited.json`；媒体测试：`media-tests-audited.json`；真实 HDR10+：`real-hdr-tests.json`；真实 Dolby：`dolby-tests.json`；取消测试：`windows-cancel-test-final.json`，均位于同一目录。
- 最终随包真实 HDR10+ 和 Windows 回归：`output/playwright/windows-runtime-fidelity-mq7gKm/report.json`；Dolby 随包：`output/hdr-export-xml/electron-jytiQo/report.json`；XML 故障界面：`output/hdr-export-xml/electron-VkheLv/report.json`。
- 测试程序：`output/playwright/windows-hdr-sync-20261029/package-audit-final/TTcut-win32-x64/TTcut.exe`，未签名；需保留同级应用目录。EXE SHA-256 `78f08fca3b1c4308e933473961de0056ecc507f494fa8792081d636a057338bc`；`resources/app.asar` SHA-256 `081b3c4ba0c96d0fe70a62f39f4ce00c84bab37624c94eb3c880e54bf60f0045`。测试 FFmpeg 与随包 FFmpeg 的 SHA-256 均为 `508867e8e98746492152e25b0c09a9ffd167d40dffc945ba4a70c4ccaf438b1e`。

验收使用独立配置和测试素材，不修改用户历史或源视频。Windows 当前不能直接解析 macOS 新版 continuous_visibility 历史中的时间基准与排除区间；仓库也没有正式跨机器历史导入及源路径迁移流程。未经实际 Premiere 导入、其他 Windows 设备或 macOS 原生重新验收；未知 Dolby Vision profile 和混合 HDR 多源批量转换不属于自动转换范围。缓存完整性扫描需要完整解码，耗时尚未量化。没有创建 PR、推送、签名或发布。
