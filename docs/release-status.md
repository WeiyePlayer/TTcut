# TTcut v1.0.0 正式版发布状态

更新时间：2026-07-20（Asia/Shanghai）

## 发布范围

- 应用版本保持 `1.0.0`。
- 支持 Windows 10 22H2 x64（build `19045`）和 Windows 11 x64 Client（build `>=22000`）。
- 不支持旧版 Windows 10、Windows Server、x86 和 ARM64。
- 启动时会探测平台、架构、`CurrentBuildNumber` 与 `InstallationType`；不兼容或探测失败时仍可打开设置、第三方许可和日志，但组件安装、分析及导出会被禁用。
- 跨系统、干净系统和多 DPI 矩阵不作为发布门禁。当前机器继续执行平台、组件、CPU/CUDA、FFmpeg、界面和 125%/150%/200% DPI 回归自检。

## 正式资产

目录：`out/make/squirrel.windows/x64`

- `TTcut-1.0.0-x64-Setup.exe`：144,831,592 字节；SHA-256 `45a1d704e906f1a825b64f8998e1409f9670d3282f2754c2bbf14e0009219e0e`
- `SHA256SUMS.txt`：172 字节；SHA-256 `1e8e010899f02358188020fcdd2338659bf7efd5c788eaf5df5eb3f89ae9df48`
- `sbom.cdx.json`：4,275 字节；SHA-256 `a0a471fa4469fa2ba508b7f8fcc25f3f1b76b104ac9e6f7759434797c629cbb0`

## 签名状态

- 证书主题：`CN=weiye`
- 证书 SHA-1 thumbprint：`F840029C794D8925B6F9815B10FD2850CB608A9E`
- 签名摘要：SHA-256
- RFC 3161 时间戳：DigiCert SHA-256 时间戳服务
- 已验证打包目录中的 `TTcut.exe`、Squirrel 包内的 `TTcut.exe` 和外层 Setup 均带相同签名及时间戳。
- 验证完成后，构建时临时加入当前用户根存储的公钥已删除；普通用户不需要也不应安装该根证书。

这是自签名证书，不具备公共 CA 信任。签名可以验证文件签名后未被修改，但 Windows 仍可能显示“未知发布者”或 SmartScreen 警告，不能将其宣传为受 Windows 公共信任的可信签名。

## 同版本资产替换记录

2026-07-20 将既有 `v1.0.0` Pre-release 更新为正式 Release，并替换同名三个发行资产。旧安装包 SHA-256 为：

`5ed76791b120599520abe865f0abf45439b6609fb1e9ae653dc04a766b584632`

旧资产及元数据已保存在忽略目录 `.baseline/release-v1.0.0-old/` 作为恢复依据。替换会重置对应资产的下载统计；此前下载的旧安装包仍对应旧哈希，不应再与新的 `SHA256SUMS.txt` 混用。

## 发布验证

- TypeScript 类型检查通过；Vitest 51 项通过、1 项按设计跳过；Python Worker 8 项通过；网站构建及 2 项渲染测试通过。
- Electron E2E 5 项通过、1 项按开关跳过：真实 CUDA 流程得到 47 个有效回合，并完成历史恢复、第三回合预览、FFmpeg 导出、成片播放、首次媒体组件安装和 125%/150%/200% DPI 回归。跳过项是显式启用后才会下载数 GB 资产的在线组件续传用例。
- CPU 运行时自检确认 PyTorch `2.12.1+cpu` 且 CUDA 不可用；CUDA 运行时自检确认 PyTorch `2.12.1+cu126`、CUDA 12.6 和 NVIDIA GeForce RTX 4060 Laptop GPU 可用。
- 权重、CPU 运行时、三个 cu126 分片及媒体组件均通过 HTTPS Range `206`、远端总大小检查。
- 本机兼容诊断确认 Windows 11 Client build `26100`、x64、100% DPI；证据位于忽略目录 `.baseline/windows-compatibility/win11-26100-official-v1.0.0/`。
- 发行审计、三个可签名层级的 Authenticode/时间戳校验以及 Git 敏感文件审计通过。
- Release 发布后重新下载三个资产，核对 GitHub digest、大小、本地 SHA-256、SBOM 和签名。
- Release 必须满足 `isDraft=false`、`isPrerelease=false`、Latest，且 `v1.0.0` tag 与最终 `main` 发布提交一致。
