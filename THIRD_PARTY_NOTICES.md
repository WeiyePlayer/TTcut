# TTcut third-party notices

TTcut 组合使用多个保留各自许可证的组件。本文件不替代发布包中应附带的许可证正文。

## Desktop application

- Electron — MIT License
- React and React DOM — MIT License
- Zod — MIT License
- Vite and Vitest — MIT License
- Electron Forge — MIT License
- Playwright（仅开发与测试）— Apache License 2.0
- Inter — SIL Open Font License 1.1
- Noto Sans SC — SIL Open Font License 1.1

完整 npm 依赖树和锁定版本记录在 `package-lock.json`。构建时由 `scripts/generate-release-metadata.mjs` 从实际发行依赖生成 `release-metadata/licenses`、HTML 许可中心和 CycloneDX SBOM；缺少许可证正文会使构建失败。

## Analysis runtime

- CPython — Python Software Foundation License
- PyTorch — BSD-style license
- NumPy — BSD 3-Clause License
- OpenCV — Apache License 2.0
- TrackNetV3-derived source — 见 `worker/SOURCE_MANIFEST.md` 及其记录的上游许可

`TrackNet_best.pt` 的权利人 `weiye` 已明确授权 TTcut 将固定权重作为软件组成部分公开复制和分发。权重不进入 Git 或安装包，而是在用户同意安装分析组件时从固定 Release 资产下载到受管组件目录。固定 URL、大小、哈希和授权证据记录在 `resources/components.json`，授权声明正文位于 `resources/rights/tracknet-weight-rights.md`，并随发行许可中心一并打包。

## Media runtime

- FFmpeg — LGPL，具体义务取决于实际构建配置
- BtbN/FFmpeg-Builds build scripts — MIT License
- OpenH264 — BSD 2-Clause License；Cisco 分发的二进制还可能适用额外专利许可条款

固定 Windows 媒体组件为 BtbN `win64-lgpl-shared-8.1`，release `autobuild-2026-07-17-13-22`。资产名、SHA-256、编码器和构建参数记录在 `resources/components.json`。该配置启用 `libopenh264`，并明确禁用 `libx264` 和 `libx265`。安装器要求媒体组件根目录存在随资产提供的完整 `LICENSE.txt`，否则拒绝安装。

### Optional x264 media component

TTcut 还支持用户手动导入独立的 BtbN `win64-gpl` 构建。该组件不进入 TTcut 安装包，也不改变默认 OpenH264 组件的在线安装流程。

- Release：`autobuild-2026-07-22-13-36`
- Asset：`ffmpeg-N-125716-g1b1f602699-win64-gpl.zip`
- SHA-256：`6dcf685c2fea98221b3f179961165e9c31f55bead576c4479ae4549858fbf826`
- 构建：启用 GPL、`libx264` 和 AAC；导入时还会执行 8K 编码自检。
- 许可正文：随 BtbN 资产提供的 `LICENSE.txt`；[BtbN FFmpeg Builds LICENSE](https://github.com/BtbN/FFmpeg-Builds/blob/master/LICENSE)
- 构建来源：[BtbN fixed Release](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-22-13-36)

导入有效 x264 后，必须重编码的片段使用 `libx264`、`veryfast` 和 CRF 18；可直接复制的片段仍使用 stream copy。FFmpeg 的 GPL 组件可能产生额外的再分发义务，使用者应根据实际分发方式进行许可审阅。

## Build-only tools

- NuGet command-line 7.0.3 — Apache License 2.0（仅 Squirrel 构建期下载，不打入应用运行时）

按需安装的分析运行时必须保留 CPython 根许可证以及 PyTorch、NumPy、OpenCV wheel 的完整 `.dist-info` 许可证目录；缺少任一正文会被组件自检拒绝。FFmpeg/OpenH264 的最终合规结论仍取决于实际构建和专利分发审阅，不能由本 notice 替代。
