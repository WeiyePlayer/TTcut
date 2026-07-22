# 分析运行时资产

## 固定版本和目录

TTcut 的分析运行时固定为 Python 3.12.13、PyTorch 2.12.1、NumPy 2.5.1 和 opencv-python 4.13.0.92。CPU、CUDA 12.6 和 CUDA 13.2 必须构建为三个完整且互不修改的目录。CUDA 13.2 运行时用于包含 `sm_120` 的新架构；CUDA 12.6 资产、URL、哈希和安装目录保持不变：

```text
%LOCALAPPDATA%\TTcutData\components\analysis-runtime\3.12.13-2.12.1\cpu\python.exe
%LOCALAPPDATA%\TTcutData\components\analysis-runtime\3.12.13-2.12.1\cu126\python.exe
%LOCALAPPDATA%\TTcutData\components\analysis-runtime\3.12.13-2.12.1\cu132\python.exe
```

根目录的 `active-runtime.json` 只记录最近一次通过自检的运行时。`device:auto` 优先测试 CUDA；CUDA 不存在或自检失败时选择 CPU。不得在同一环境中通过 pip 原地替换 CPU/CUDA 版 PyTorch。

Python 3.12.13 官方只发布源码，因此公开资产不能伪装成 python.org 提供的 Windows 二进制。当前基座已从官方 `Python-3.12.13.tar.xz`（SHA-256 `c08bc65a81971c1dd5783182826503369466c7e67374d1646519adf05207b684`）使用 Visual Studio 2022 Community 17.14、MSVC 14.44/v143 构建；源码、编译器、固定 wheel 和自检结果记录在每个运行时根目录的 `TTcut-runtime-provenance.json`。

直接 wheel 的不可变 URL、字节数和 SHA-256 已锁定在 `worker/runtime-wheel-lock.json`。可运行 `node scripts/resolve-runtime-wheel-lock.mjs` 重新解析官方索引并人工审阅差异；Release 构建使用已提交清单，不在用户电脑上解析浮动索引。

## 构建运行包

准备好的目录必须分别命名为：

```text
ttcut-analysis-3.12.13-2.12.1-cpu
ttcut-analysis-3.12.13-2.12.1-cu126
ttcut-analysis-3.12.13-2.12.1-cu132
```

目录中需要根部 `python.exe`、`LICENSE.txt`、完整标准库和 site-packages。pip 安装产生的 PyTorch、NumPy、OpenCV `.dist-info` 及全部许可证目录不得删除。然后在与目标运行时相符的 Windows x64 发布机运行：

```powershell
node scripts/package-analysis-runtime.mjs cpu D:\prepared\ttcut-analysis-3.12.13-2.12.1-cpu
node scripts/package-analysis-runtime.mjs cu126 D:\prepared\ttcut-analysis-3.12.13-2.12.1-cu126
node scripts/package-analysis-runtime.mjs cu132 D:\prepared\ttcut-analysis-3.12.13-2.12.1-cu132
```

脚本执行固定版本、自带许可证和 CUDA 可用性检查，拒绝包含 `TrackNet_best.pt` 的运行包，并在忽略的 `.baseline/runtime-assets` 中生成 ZIP、大小和 SHA-256。CPU ZIP 为 269,628,039 字节，SHA-256 `b656c87f6261ad53929d72b6726855ecb5961b378315137de1b1af6ce8fd125b`；cu126 完整 ZIP 为 2,766,688,555 字节，SHA-256 `2fd0f1498153bd77b886d2e50787a7e40ff35e683ab8b6d6a55787ea51d98e0d`。

## 托管和发布

1. 把 CPU ZIP、cu126 固定分片和 cu132 固定分片上传到不可变、支持 HTTPS 和 Range 请求的正式发布资产位置。cu126 与 cu132 完整 ZIP 超过 GitHub 单资产限制，因此由 `scripts/split-runtime-asset.mjs` 按 1,000,000,000 字节切成有序分片。
2. 将真实 URL、大小和 SHA-256 写入 `resources/components.json` 的 `analysis_runtime.assets`；禁止 `latest`、可覆盖对象或占位 URL。
3. CPU、cu126 与 cu132 三个描述必须齐全，目录和 variant 必须匹配。
4. 在当前发布机执行 CPU 运行时自检、可用 CUDA 运行时自检和真实 Worker 验证；不再要求跨机器发布矩阵。
5. 运行 `TTCUT_OFFICIAL_RELEASE=1` 的发布审计；资产缺少、URL仍是占位值或哈希不匹配都会阻止正式构建。

CPU 与 cu126 资产固定在 [WeiyePlayer/TTcut-runtime-assets `analysis-3.12.13-2.12.1-r1`](https://github.com/WeiyePlayer/TTcut-runtime-assets/releases/tag/analysis-3.12.13-2.12.1-r1)。cu132 资产固定在 [WeiyePlayer/TTcut-runtime-assets `analysis-3.12.13-2.12.1-cu132-r1`](https://github.com/WeiyePlayer/TTcut-runtime-assets/releases/tag/analysis-3.12.13-2.12.1-cu132-r1)。安装器逐片校验后顺序合并，并再次校验完整 ZIP 哈希；发布前必须验证每个远端对象的文件名、字节数、GitHub SHA-256 摘要和 `206 Partial Content` Range 响应。

## 固定模型文件

模型不进入普通 Git、源码归档或 TTcut 安装包。它固定在 [WeiyePlayer/TTcut-runtime-assets `tracknet-weight-1.0.0`](https://github.com/WeiyePlayer/TTcut-runtime-assets/releases/tag/tracknet-weight-1.0.0)：

- 文件名：`TrackNet_best.pt`
- 字节数：`136191005`
- SHA-256：`ffb5469161c4bd39a5a7e745c3d13f076b2c5e575f33279ea62f1e5803245a52`
- 安装位置：`%LOCALAPPDATA%\TTcutData\components\models\TrackNet_best.pt`

用户安装“分析组件”时，应用只下载缺失或校验失败的运行时/模型文件。运行时和模型全部通过大小、SHA-256 与自检后，分析组件才进入可用状态。设置页不单独显示模型名称、版本、哈希、URL 或路径。
