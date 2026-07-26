# FFmpeg 探测与导出策略

## 固定媒体组件

- 提供方：BtbN/FFmpeg-Builds
- Release：`autobuild-2026-07-17-13-22`
- Asset：`ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip`
- SHA-256：`fcbf0f5c58fec3e516e35ba26d81bc6cbaea09dde76bffd151fa93c0316b0b50`
- 运行时要求：shared、`libopenh264`、AAC、明确禁用 `libx264`/`libx265`

完整目录见 `resources/components.json`。组件安装在用户明确同意后开始，支持 `.part` 断点文件、大小与 SHA-256 校验、归档布局检查、编码器/构建参数自检和原子目录替换。

上游说明：[BtbN FFmpeg Builds](https://github.com/BtbN/FFmpeg-Builds)。

## 探测

ffprobe 读取：容器、时长、视频/音频编码、尺寸、平均和标称帧率、帧数、码率、像素格式、采样率、声道、流时长/起点/时间基、旋转、SAR/DAR 和色彩字段。

帧数缺失时使用 `-count_frames`。VFR 由帧率字段差异和最多 60 秒的视频包 duration 采样共同判断；采样失败时保留字段判断，不主动转为 CFR。

## 选择流复制或重编码

当前仅在以下条件全部满足且只有一个剪辑组时尝试 stream copy：

- 非 VFR；
- 视频时间基有效；
- 起止点在一帧容差内对齐关键帧；
- 有音频时，音频时间基有效且起止点对齐音频包边界。

流复制结果仍执行完整输出验证，失败则删除 `.partial.mp4` 并自动回退准确重编码。多组输出当前直接使用一次 `filter_complex`，避免多代编码。

## 准确重编码

- 视频：`trim + setpts`，多组通过一次 `concat`；`libopenh264`、High profile、`yuv420p`、VFR 时间戳模式，不传强制 `-r`。
- 音频：`atrim + asetpts`，AAC，尽量保留源采样率、声道和近似码率。
- `-noautorotate`，恢复旋转元数据、SAR 和已知色彩字段。
- 不缩放、不加水印、不生成分析叠加视频。

真实基线发现“按源视频平均码率再次编码”只有 SSIM 0.9337，未达到 0.95 验收线。当前目标视频码率因此调整为源视频码率的 2 倍（上限 50 Mbps），真实多片段导出 SSIM 为 0.951042。该证据驱动修正优先于原计划中的同码率假设。

## 输出安全

- 输出命名为 `_ttcut.mp4`、`_ttcut_2.mp4`……，从不覆盖已有文件。
- 先写同目录、任务 UUID 命名的 `.partial.mp4`。
- 导出前检查源文件、目录写权限和估算磁盘空间。
- 成功条件包括：可探测、H.264、分辨率一致、音频存在性一致、AAC（有音频时）、时长容差、起始时间戳、音画差不超过 100 ms，以及 SAR/色彩/旋转一致。
- 仅在全部验证通过后原子重命名并显示 100%。

