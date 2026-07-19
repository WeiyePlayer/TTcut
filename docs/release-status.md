# TTcut v1.0.0 Pre-release 发布状态

更新时间：2026-07-19（Asia/Shanghai）

## 已完成的本地验收

- 应用、构建信息和用户界面版本已统一为 `1.0.0`。
- TypeScript 类型检查通过；Vitest 37 项通过、1 项按设计跳过；Python Worker 8 项通过。
- `1-193.mp4` 使用真实 CUDA、真实固定权重完成 15,207 帧分析，得到 47 个有效回合；历史恢复、第三回合预览、导出与成片播放均通过。
- 发行审计通过：Git 与安装包不包含 `.pt/.pth`、测试视频、开发机绝对路径、日志或缓存。
- 固定权重改为随“分析组件”按需下载；运行时和权重全部校验通过后才启用分析。
- Squirrel.Windows x64 构建成功，自动更新关闭，因此公开 Release 不上传 `.nupkg` 和 `RELEASES`。

## 本次公开资产

目录：`out/make/squirrel.windows/x64`

- `TTcut-1.0.0-x64-Setup.exe`：144,757,248 字节；SHA-256 `5ed76791b120599520abe865f0abf45439b6609fb1e9ae653dc04a766b584632`
- `SHA256SUMS.txt`：172 字节；SHA-256 `441eff8e73099754d90a1bdc8b8da1a4fd8313898258d7b98ba27275de090733`
- `sbom.cdx.json`：4,275 字节；SHA-256 `1d9c0c98053846ee8b007168fffd3158b3636054895daf2f261587c74d2593f3`

安装程序的 Authenticode 状态是 `NotSigned`。`TTCUT_PUBLIC_RC=1` 的可信签名门禁仍保留；本次普通构建只作为 GitHub Pre-release 发布。

## 尚未完成的外部矩阵

- 安装包尚未进行 Authenticode 签名，Windows SmartScreen 可能显示未知发布者警告。
- 尚未在同一份最终安装包上完成干净 Windows 10 22H2、Windows 11、CPU/CUDA 和 125%/150%/200% DPI 的完整矩阵。
- Windows 10 22H2 作为兼容目标保留，但已不在微软常规支持周期内。

以上限制必须在 GitHub Pre-release 页面醒目标注，不能把当前产物描述为已签名正式版。
