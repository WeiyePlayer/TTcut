# TTcut Electron macOS 本地验收报告

状态：本阶段实现与本地交付已完成。应用版本 `1.2.10`，构建 `electron-local-20260904154405750`，打包源码 `d974c897f5b002260564097a97b50c36a1c5c166`；打包前已跟踪源码为干净状态。验证主机为 macOS 26.6.2、Apple M5、16 GB；这不能代替 macOS 15 或其他 Apple Silicon 机型的实机验收。

## 交付物

- `.app`：`out/TTcut-darwin-arm64/TTcut.app`
- `TTcut-1.2.10-macOS-arm64-electron.dmg`：241,359,292 bytes，SHA-256 `7d79b576cee26d1c270e78a5f51b5c2ea000a492a7a9b6db368a5e495340c6a1`
- `TTcut-1.2.10-macOS-arm64-electron.zip`：239,658,004 bytes，SHA-256 `657d9ef13e56c2acd451a8f69b58cf8f5e359632eb858bccee5ba59bbc7639b8`
- `SHA256SUMS` 与 `build-manifest.json` 位于同一交付目录。本地 ad-hoc 签名已验证，未使用 Developer ID，未公证，未配置 Mac 自动更新源。

## 已验证

- TypeScript 类型检查通过。Mac 专项 Vitest 为 5 个文件、16 项全部通过；覆盖 JSONL 分帧、错误任务 ID、重复终态、无结果退出、协议上限、处理媒体映射、内置资源损坏、磁盘不足、不可写目录和整组进程回收。
- 原生 Swift 测试 21 项通过；包含原预处理/热图对照、回合及片段规则、VFR、旋转/SAR、10-bit SDR、多声道、HDR10、HLG、短 8K、8K 10-bit HDR、失败隔离及取消。含音轨的导出验证要求起止音画差不超过 100 ms。
- 模型复核保持原误差门槛：BlurBall 三组输入最大绝对误差 `1.1175870895385742e-07`，Table CPU 最大绝对误差 `2.8189271688461304e-05`，均为 0 个超限值。Table 配置为 Core ML `cpuOnly`；BlurBall 为 `cpuAndGPU`，该配置不证明具体一次推理由 GPU 执行。
- 打包应用通过 18 项实际调用：本地运行时启动、中英文设置、Table 与 BlurBall 全量/两阶段调用、手动区间导出、分回合 MP4、Premiere XML、HDR10/HLG 保留、SDR 预览播放、VFR CFR 化、损坏缓存发现与重建、Worker 崩溃、取消、窗口隐藏/恢复、历史重开和源文件变化保护。
- 批处理使用真实原生服务验证了两项串行任务、自动标定失败后的手动标定、取消、剩余队列继续、重试、零回合历史、隐藏窗口继续和明确退出确认。非空回合交互使用明确标注的可控历史结果，只验证 UI 行为，不代表模型准确率。
- ZIP 已解压至仓库外的中文及空格路径。正常模式和进程级外网阻断模式各通过 18 项应用检查；PATH 只保留系统目录。阻断模式为避免 macOS 外层沙箱和 Chromium 二次初始化冲突，仅对测试进程加 `--no-sandbox`；默认启动单独通过，交付应用的默认沙箱未更改。
- 29 个 Mach-O 均为 arm64，最低系统版本不高于 15.0，只依赖系统或应用内路径，并通过深度签名校验。DMG 只读挂载、Applications 链接、包内容一致性、内置 ffprobe 执行和两个归档的 SHA-256 均已验证。

## 未宣称通过

完整 Vitest 结果为 249 通过、10 失败、20 跳过。10 个失败用例依赖 Windows 盘符、注册安装目录、PowerShell/证书或 Windows 更新器；因此 Windows 原生构建、安装、CUDA/CPU 推理、媒体运行时和更新回归均未在本机宣称通过。

真实比赛识别准确率、真实 HDR 观感、持续 8K 性能、真实 NLE 导入、macOS 15 实机和其他 Apple Silicon 芯片仍待验收。Dolby Vision 和 HDR10+ 已由原生层明确拒绝并在中英文 UI 中解释，但没有真实动态 HDR 文件验收。正式签名、公证、发布和 Mac 自动更新仍不在本阶段。

## 证据

可分发校验文件在当前目录；结构化验收结果、截图、模型对照和测试汇总在 `verification/`。实现与使用命令见仓库 `macos/ELECTRON.md`，架构决定见 `docs/adr/0016-electron-macos-native-services.md`。
