# TTcut 仓库协作指引

## 任务推进

- 按用户当前目标完成工作；在已授权范围内自行处理常规、可逆的实现选择。信息缺失时先核查代码，只有答案会实质改变范围或结果时才提问，同时推进不依赖答案的工作。
- 用户的新消息默认用于调整当前任务；回答中途问题后继续原目标，除非用户明确取消或替换任务。
- 遵守系统和开发者约束；用户明确要求优先于仓库或技能的一般建议。技能若导致暂停，指出具体文件、原文和适用原因，不从模糊建议推导额外审批。
- 保持补丁聚焦，保留用户指定的产品文案和默认行为。不要因模型升级顺便修改产品模型、依赖或发布配置。
- 默认直接完成当前任务；仅在用户或适用指令明确要求多代理工作时委派，并分清文件归属，避免覆盖其他人的编辑。

## 先确认当前代码

- 修改前检查 cwd、分支、HEAD、工作树及已有改动；不要重置、覆盖或混入用户已有提交。上游差异必须针对实际分支核查，未 fetch 的远端引用只代表本地缓存。
- 先用 `rg` 定位，再读取与问题有关的文件。以当前实现、契约和验证结果核对文档；历史说明不是当前行为的证明。
- `src/main/` 管理原生能力、任务及子进程；`src/preload/` 暴露受限 IPC；`src/renderer/` 管理 React 界面；`src/shared/` 定义共享契约；`src/domain/` 放纯领域逻辑；`worker/ttcut_worker/` 执行 Python 分析。
- 变更跨进程字段时检查 `src/shared/contracts.ts`、调用方、Python 请求解析及相关测试。界面不得绕过 Main 的输入校验直接操作本地文件或进程。
- 桌面随包球检测模型是 BlurBall；TrackNet 是开发态显式启用的本地测试路径。核查 `src/main/components.ts`、`src/main/analysis.ts` 和 `scripts/verify-model-assets.mjs`，不要套用 Android 项目的模型约定。
- `CONTEXT.md` 可用于查领域术语，`docs/architecture.md` 和 `docs/adr/` 可用于查设计背景；其中模型描述存在历史残留，涉及模型时必须核查上述实现。

## Windows 命令

- 使用 PowerShell 7.6.5：通过非登录 `C:\Windows\System32\cmd.exe` 启动 `C:\Progra~1\PowerShell\7\pwsh.exe -NoLogo -NoProfile`。复杂脚本使用 UTF-16LE Base64 `-EncodedCommand`，首次运行确认 `$PSVersionTable.PSVersion.ToString()`。
- 使用 `npm.cmd` / `npx.cmd`；将 Git 的 `HEAD...@{u}` 作为引号包裹的字符串传递，避免 PowerShell 解析。
- `npm.cmd run make:official` 当前会调用旧 `powershell`。需要正式构建时，用上述 PowerShell 7 启动方式加 `-File scripts/build-official-release.ps1` 和任务要求的参数直接运行。

## 按变更选择验证

- 纯说明或指令修改：检查差异、引用路径、命令及指令冲突；无需启动应用或跑全量测试。
- TypeScript/React 逻辑：运行相关 `npm.cmd test -- tests/<实际测试文件>`；类型或共享接口变更补充 `npm.cmd run typecheck`。
- Python 分析逻辑：选用具有项目依赖的 Python 解释器，运行 `python -m pytest worker/tests/<实际测试文件> -q`；不要为了指令审计安装运行时或模型。
- 跨模块改动按影响面扩大到 `npm.cmd test` / `npm.cmd run test:python`。应用交互、打包或媒体链路需要相应真实验证时，再运行 Electron E2E 或实际视频流程；`npm.cmd run test:e2e` 会校验模型、暂存资源并打包，应预留成本。
- 用有意义的回归验证行为；相关检查通过后，只因新改动、失败或具体未解决风险继续扩大或重复测试。
- 区分单元测试、真实 Electron、真实视频、安装器、签名和远端发布的证据；没有执行的项目明确写未验证，不推导为通过。算法效果只能由相应视频对照支撑。

## 完成与交付

- 简洁说明结果、关键原因、已做验证及剩余限制；对事实、推测和无法确认的内容作必要区分，不无依据迎合。
- 若任务要求 PR 合并或发布，按该次授权完成；需要额外授权的动作，先准备可审阅的具体结果。授权不会因阶段切换而失效。
- 请求普通 PR 合并时使用正常 push / PR merge / 本地 fast-forward 流程，并核查同步结果；不要擅自 force-push、重写历史或发布产物。

审计背景及来源见 [指令审计记录](docs/agent-instructions-audit.md)。

## Cloud Agent（Linux）

默认镜像已有 Node.js 22 与 npm 10。环境安装脚本会安装 `python3-venv`，在 `/opt/ttcut-venv` 按 `worker/requirements-cpu.txt` 安装 CPU 版依赖和 `pytest==8.3.5`，并在仓库根与 `website/` 执行 `npm ci`。`/usr/local/bin/python` 必须是执行 `/opt/ttcut-venv/bin/python` 的包装脚本；把虚拟环境里的解释器符号链接到其他路径会让 CPython 忽略 `pyvenv.cfg`。`pytest` 链接到同一环境。

模型权重不在 Git 中。安装脚本按 `resources/online-model-delivery.json` 下载并校验 `resources/models/`。

在此环境使用 `npm`、`npx` 和 `python -m pytest worker/tests -q`，不要使用 `npm.cmd` 或 PowerShell 发布脚本。`npm run typecheck` 可直接运行。`npm test` 中依赖 Windows 路径、PowerShell 签名或仅 Windows 更新器的用例会失败，其余 Vitest 可通过。`npm start` 启动 Electron；没有图形会话时用 `xvfb-run -a npm start`。系统 FFmpeg 不能代替受管视频处理组件，打开视频会得到 `MEDIA_COMPONENT_MISSING` 或 `MEDIA_RUNTIME_VERSION_MISMATCH`。Windows 安装包、签名和正式发布不在此环境验证。
