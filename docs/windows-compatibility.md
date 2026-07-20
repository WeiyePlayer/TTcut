# Windows 兼容策略

TTcut v1.0.0 支持 Windows 10 22H2 x64（build `19045`）以及 Windows 11 x64（Client build `>=22000`）。不支持 Windows 10 21H2 及更早版本、x86、Windows on ARM、Windows Server。

Windows 10 22H2 已结束微软常规支持。TTcut 的兼容声明只表示应用允许在该版本运行，不代表操作系统仍能获得微软安全更新。

## 应用自检

应用启动时读取 `CurrentBuildNumber`、`InstallationType` 和进程架构，不依赖可能仍显示 Windows 10 的 `ProductName`。兼容信息无法可靠读取时按不兼容处理：设置、许可和日志仍可打开，但组件安装、分析和导出被 Main 与界面同时阻止。

受管组件继续执行各自的完整性检查：

- 分析组件校验固定模型 SHA-256、Python/PyTorch 运行环境和 CPU/CUDA 可用性；CUDA 失败时使用独立 CPU 环境。
- 视频处理组件校验 FFmpeg/ffprobe 版本、构建配置和必要编码器。
- 任务启动前重新检查对应组件，避免已移动或损坏的组件继续运行。

## 单机诊断

兼容诊断不再是多系统发布矩阵。它只采集当前机器的系统 build、架构、DPI、GPU、安装包哈希、签名信息和可选安装启动结果：

```powershell
.\scripts\capture-windows-compatibility.ps1 `
  -CaseId local-150 `
  -ExpectedScalePercent 150 `
  -InstallerPath .\out\make\squirrel.windows\x64\TTcut-1.0.0-x64-Setup.exe `
  -ExpectedSignerThumbprint <THUMBPRINT> `
  -InstallAndSmoke
```

结果写入忽略的 `.baseline/windows-compatibility/<case-id>/environment.json`。`-RequireValidSignature` 只适用于能建立公共信任链的证书；当前 `CN=weiye` 自签名证书应使用固定 thumbprint 验证，不应导入普通用户的根证书存储。

125%、150%、200% 的 Electron 自动化仍用于检查 840×520 DIP 下的布局、滚动和标题栏，但属于当前开发机回归测试，不代表完成了跨 Windows 版本认证。

