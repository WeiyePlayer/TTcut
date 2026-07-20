# Windows 自签名发布

TTcut v1.0.0 的安装包使用主题为 `CN=weiye` 的自签名 Authenticode 证书。签名用于固定发布者字段并验证文件在签名后没有被修改，但证书不链接到 Windows 公共信任根，因此普通用户仍可能看到“未知发布者”或 SmartScreen 警告。

不得把本方案描述为可信 CA 签名，也不得要求普通用户把项目证书导入“受信任的根证书颁发机构”。

## 正式构建

Windows SDK x64 SignTool、Node.js 和项目依赖可用后运行：

```powershell
npm run make:official
```

`scripts/build-official-release.ps1` 会：

1. 选择当前用户证书存储中唯一可用的 `CN=weiye` Code Signing 证书；不存在时创建三年有效、RSA 3072、SHA-256、私钥不可导出的自签名证书。
2. 使用证书精确 thumbprint 和 Windows SDK x64 SignTool 签署应用目录内可签名文件、`TTcut.exe` 与 Squirrel Setup。
3. 使用 RFC 3161 SHA-256 时间戳。
4. 仅在构建验证期间把公钥临时加入当前用户根存储，并在 `finally` 中删除临时信任。
5. 验证构建目录、Squirrel `.nupkg` 内的 `TTcut.exe` 和最终 Setup，再生成最终哈希与 SBOM。

如存在多个可用证书，必须显式传入 thumbprint：

```powershell
.\scripts\build-official-release.ps1 -CertificateThumbprint <THUMBPRINT>
```

## 门禁变量

- `TTCUT_OFFICIAL_RELEASE=1`：正式构建，要求固定证书 thumbprint、Windows SDK SignTool、时间戳和构建后签名验证。
- `TTCUT_PUBLIC_RC=1`：保留为旧发布流程兼容别名。
- `TTCUT_PUBLISHER_NAME`：必须为 `weiye`。
- `WINDOWS_CERTIFICATE_THUMBPRINT`：正式发布证书的精确指纹。
- `WINDOWS_SIGNTOOL_PATH`：Windows SDK x64 `signtool.exe` 的绝对路径。
- `WINDOWS_TIMESTAMP_SERVER`：RFC 3161 时间戳服务；默认使用 `http://timestamp.digicert.com`。

私钥不写入仓库、构建目录、日志、`.baseline`、Release 或环境文件。由于私钥不可导出，当前 Windows 用户配置损坏后无法继续使用同一自签名证书，必须创建新证书并在后续 Release 中公布新的 thumbprint。
