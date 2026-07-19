# Windows 个人发布者签名

TTcut 的发布者标识固定为 `weiye`，`package.json`、Squirrel 元数据和公开门禁均使用该值。项目不要求把个人法定姓名、注册公司、HSM 或 USB Token 写入仓库；这些信息也不是应用配置项。

`weiye` 只是项目要求的发布者/证书主题匹配标识，不能代替 Authenticode 证书和私钥。公开 RC 仍必须由 Windows 可验证的代码签名证书或签名服务完成签名和时间戳；仅创建主题为 `weiye` 的自签名证书不会在干净 Windows 机器上获得公开信任。

## PFX/硬件签名配置

传统 PFX 示例：

```powershell
$env:TTCUT_PUBLIC_RC='1'
$env:TTCUT_PUBLISHER_NAME='weiye'
$env:WINDOWS_CERTIFICATE_FILE='D:\secure\publisher-code-signing.pfx'
$env:WINDOWS_CERTIFICATE_PASSWORD='由安全环境注入，不写入脚本或仓库'
$env:WINDOWS_TIMESTAMP_SERVER='https://timestamp.example-ca.invalid'
npm run make
```

不使用本地 PFX 时，可通过 `WINDOWS_SIGNTOOL_PATH` / `WINDOWS_SIGN_WITH_PARAMS` 对接可用的远程签名服务。项目不强制 HSM 或 USB Token 形态，但签名实现必须能够让 SignTool 访问真实证书和私钥，并使用有效 RFC 3161 时间戳地址；文档中的 `.invalid` 仅为防止误用的占位示例。

Forge 会签名解包应用中的可执行文件以及 Squirrel 产物；公开模式缺少签名配置时会在打包前失败。`scripts/make.mjs` 完成后还会运行：

```powershell
npm run verify:signatures
```

验证要求 `TTcut.exe` 和最终 `TTcut-1.0.0-x64-Setup.exe` 均通过 Authenticode `/pa /all /tw`，存在时间戳，并且签名证书主题包含 `TTCUT_PUBLISHER_NAME`。签名成功不保证新文件立即没有 SmartScreen 信誉提示。

## 私钥规则

- PFX 和密码不得放入仓库、`.env`、构建日志、`.baseline` 或安装包。
- PFX、系统证书存储或受管远程签名服务均可；只允许受控发布作业访问私钥能力。
- 续期时保持同一发布者身份，并在旧证书失效前完成迁移。
- 每次签名后保存安装包 SHA-256、签名主体、证书指纹、时间戳和验证日志。
