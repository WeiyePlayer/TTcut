# Windows 发布矩阵

TTcut 的正式支持平台为仍处于 Microsoft 支持周期内的 Windows 11 x64。Windows 10 22H2 x64 保留为兼容平台；它已在 2025-10-14 结束常规支持，因此测试通过只表示 TTcut 兼容，不代表操作系统仍由 Microsoft 提供常规安全支持。

## 测试原则

- 只测试同一个最终 Authenticode 签名安装包；任何重新构建或重新签名都会产生新哈希，关键矩阵必须重跑。
- 每个用例从干净虚拟机快照或干净实体测试机开始，不把开发机历史状态当作发布证据。
- Windows 10 使用 22H2 x64 最终补丁状态，并在报告中标记 `compatibility-only`；Windows 11 使用执行测试时仍受支持的版本和最新稳定补丁。
- DPI 缩放在测试用户登录前设置为 100%、125%、150% 或 200%；变更缩放后注销并重新登录，再采集证据。
- 无 NVIDIA/CPU 回退可以在普通虚拟机验证；CUDA 必须在具有可用 NVIDIA 驱动的实体机或可信 GPU 直通环境验证。

## 必跑用例

| ID | OS | DPI | GPU | 网络 | 重点 |
| --- | --- | ---: | --- | --- | --- |
| W10-100-CPU | Windows 10 22H2 | 100% | 无 NVIDIA | 在线 | 每用户安装、CPU运行时、完整分析与导出 |
| W10-150-CPU | Windows 10 22H2 | 150% | 无 NVIDIA | 首次安装后断网 | CPU 分析、中文路径、预览 |
| W10-200-CPU | Windows 10 22H2 | 200% | 无 NVIDIA | 在线 | 840×520、滚动、标题栏、标定坐标 |
| W11-100-CPU | 受支持 Windows 11 | 100% | 无 NVIDIA | 在线 | 安装/卸载、CPU完整流程 |
| W11-125-CPU | 受支持 Windows 11 | 125% | 无 NVIDIA | 中断网络 | 断点续传、哈希失败恢复 |
| W11-150-CUDA | 受支持 Windows 11 | 150% | NVIDIA | 在线 | CUDA自检、真实权重、完整流程 |
| W11-200-CUDA | 受支持 Windows 11 | 200% | NVIDIA | 在线 | 高DPI、长任务最小化、退出取消 |
| W11-150-FALLBACK | 受支持 Windows 11 | 150% | NVIDIA但CUDA自检失败 | 在线 | 自动切换独立CPU目录 |

每个用例还必须覆盖普通用户、中文用户名、带空格/括号/方括号路径、输入被移动、低磁盘、输出目录不可写以及退出后无 Python/FFmpeg 孤儿进程。低磁盘和无权限使用专门快照或受控目录，不在开发机系统盘制造故障。

## 证据采集

在已设置好相应 DPI 的干净环境运行：

```powershell
.\scripts\capture-windows-matrix.ps1 `
  -CaseId W11-150-CUDA `
  -ExpectedScalePercent 150 `
  -InstallerPath .\TTcut-1.0.0-x64-Setup.exe `
  -InstallAndSmoke
```

脚本把系统版本、DPI、GPU、签名主体、安装包 SHA-256 和基础启动结果写入忽略的 `.baseline/windows-matrix/<case-id>/environment.json`。完整业务流程仍须运行 Playwright Electron 用例，并人工保存以下证据：

- 安装、组件同意、分析、剪辑、最终预览和卸载截图；
- Playwright、Python Worker、FFmpeg日志；
- CPU/CUDA运行时目录和 `active-runtime.json`；
- 任务取消后进程列表；
- 安装与卸载后 `%LOCALAPPDATA%\TTcut` 的预期保留/清理项。

只有所有必跑用例使用相同安装包哈希且均通过，才可以关闭 Windows/DPI 发布闸门。
