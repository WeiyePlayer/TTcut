# Windows 兼容策略

TTcut 已移除启动时的 **Windows build / 系统版本硬拦截**。

应用不再根据 `CurrentBuildNumber`、`InstallationType` 阻止组件安装、分析或导出。
Bootstrap 仍会返回 `platformCompatibility` 字段，但固定为 `supported`，仅保留接口兼容。

## 仍须注意

- 官方组件与安装包仍以 **Windows x64** 为主。
- `component-manager` 对非 `win32` 平台的组件路径/安装仍会失败。
- 取消版本门禁 **不等于** 在任意系统、任意架构上功能完整；ARM64、Server、过旧 Windows 可能因依赖缺失而运行失败。
- 分析组件与视频处理组件会继续做自身完整性、版本与运行环境自检。

## 单机诊断

兼容诊断脚本仍可采集当前机器的 build、架构、DPI 与安装包信息，用于问题排查，不再作为发布阻断条件：

```powershell
.\scripts\capture-windows-compatibility.ps1 `
  -CaseId local-150 `
  -ExpectedScalePercent 150 `
  -InstallerPath .\out\make\nsis\x64\TTcut-1.1.2-x64-Setup.exe `
  -ExpectedSignerThumbprint <THUMBPRINT> `
  -InstallAndSmoke
```

结果写入忽略的 `.baseline/windows-compatibility/<case-id>/environment.json`。
