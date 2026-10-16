# macOS 动态 HDR 在分析前被拦截

## 用户日志与证据边界

用户提供的 `app(2).log` 共 14 行，运行版本为 1.3.9、macOS arm64。
其中 Core ML、模型与 FFmpeg 的组件检查均通过，没有视频探测、HDR 类型或
视频错误记录。因此，这份日志不能确定用户原视频是 HDR10、HDR10+ 还是
Dolby Vision，也不能证明本次复现的错误就是该原视频的错误。

## 已复现的代码问题

`VideoInfo.validate()` 同时承担视频元数据校验与动态 HDR 保真导出限制。
`MediaProbe.inspect()` 和原生分析 Worker 都调用它，导致 HDR10+ / Dolby Vision
在导入、标定或分析前返回 `DYNAMIC_HDR_UNSUPPORTED`。Windows 探测路径没有
这道限制。静态 HDR10 与 HLG 原本不被该检查拒绝。

使用随包 FFmpeg 编码 HEVC Main10 / BT.2020 / PQ 合成素材，并为每帧插入
libavutil 序列化的有效 SMPTE 2094-40 SEI。ffprobe 实际解码显示
`HDR Dynamic Metadata SMPTE2094-40 (HDR10+)`。修复前的 1.3.9 原生媒体进程
在 `probe` 阶段返回 `DYNAMIC_HDR_UNSUPPORTED`，尚未执行模型分析。

## 修复

- 通用视频校验只判断基本元数据，允许动态 HDR 进入探测、预览和分析。
- 新增独立的 `validateHDRExport()`，在编码及合并导出入口检查，包含流复制
  优化路径，防止静默丢失动态 HDR 元数据。CFR 保真转码同样受该检查约束，
  分析沿用已有的原始 VFR 回退路径。
- Main 导出层保留原生 `DYNAMIC_HDR_UNSUPPORTED` 错误码；中英文文案明确
  限制发生在保真导出，不再提示用户该视频无法分析。
- `app.log` 记录实际 HDR 类型、位深、传递函数及已存在源文件的探测失败。
  日志写入失败不覆盖原始异常，取消与不存在的缓存不记作视频错误。

没有修改模型、检测阈值、回合算法或导出源文件。历史 ADR 对首次发布阶段
的动态 HDR 限制描述仍是历史决策，本次仅调整该限制的应用边界。

## 验证

- 8 项相关 Swift 测试通过：真实 HDR10+ 探测、24 帧原生解码、SDR 预览、
  封面、实际 Core ML 分析，以及标定到达模型阶段；合成图案没有真实球桌，
  标定允许返回 `AUTO_CALIBRATION_FAILED`。覆盖动态 HDR 两种导出策略的
  明确拒绝，静态 HDR10 / HLG 的导出保留控制也通过。
- 34 项相关 TypeScript 回归通过，类型检查与差异检查通过。
- 本地独立打包应用的 7 项 Electron 检查全部通过，结果见
  `output/hdr-audit-20261014/electron/report.json`，包括导入、实际预览帧推进、
  Core ML 分析、历史源文件保留、导出限制及诊断日志。
- 修复前复现材料位于 `/tmp/ttcut-hdr-audit-20261014/`。本地应用使用临时
  ad-hoc 签名，只用于验证，没有发布或替换正式发行资产。

验证素材是合成 HDR10+ 视频，不代表真实比赛识别准确率。未获得用户原视频，
也没有真实 Dolby Vision 素材验证，不能宣称该用户素材或所有 Dolby Vision
格式已经闭环验证。
