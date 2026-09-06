# TTcut 指令审计记录

审计日期：2026-09-05。范围由用户确认为仅 TTcut 仓库。

## 基线与来源

- 工作目录：`D:\DOCUMENTS\TTcut`。
- 审计起点：`feature/new-fast`，HEAD `c849bbe56d3faf18dd5e5e42268780c4c3502a41`，工作区干净。
- 相对本地缓存的 `origin/feature/new-fast` 为 ahead 1 / behind 0；本次没有 fetch、切分支、提交、推送或合并。
- 通过包含隐藏及忽略目录的文件名检索确认：项目源目录内没有 `AGENTS.md`、`AGENTS.override.md`、`SKILL.md` 或 instructions 文件；跳过 `.git`、依赖、虚拟环境和构建产物目录。`.agents/` 为空，Git 跟踪文件中也没有上述指令文件。
- 本会话还加载个人全局 AGENTS.md 和外部技能；它们不在此次修改范围。没有审计全部已安装插件，也没有修改全局文件。
- 依据：[OpenAI 官方 GPT-6 Astra 指导](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)的 Prompting best practices。页面已实际读取；其建议用于改善指令清晰度，不构成本仓库性能提升的实测证据。

## 发现与处理

| 发现 | 仓库证据 | 本次处理 |
| --- | --- | --- |
| 缺少项目级协作入口 | 无仓库指令文件，`.agents/` 为空 | 新增根目录 AGENTS.md，明确推进方式、实现入口和完成条件 |
| 旧模型描述会误导任务 | `docs/architecture.md` 的 Python Worker 仍写 TrackNet-only；`CONTEXT.md` 的 Ball Model Profile 将 TrackNet 称为 bundled compatibility route | AGENTS.md 明确以当前模型实现与打包校验为核查依据；旧文档正文未在本次改写 |
| 当前代码与旧模型描述不一致 | `src/main/components.ts` 对本地 TrackNet 检查非打包态及 `TTCUT_ENABLE_LOCAL_TRACKNET=1`；`scripts/verify-model-assets.mjs` 仅允许 table_analyze.pt / blurball_best.pt，并拒绝本地 TrackNet 权重 | 写明桌面 BlurBall 与开发态 TrackNet 的适用范围 |
| 正式构建入口调用旧 PowerShell | `package.json` 的 make:official 使用 powershell | 给出 PowerShell 7 直接执行现有构建脚本的路径；未更改构建脚本或签名行为 |
| 检查成本差异较大 | `package.json` 中 test:e2e 会暂存资源并运行 electron-forge package；Vitest、pytest 可定向选择测试 | 按说明、TS/React、Python、跨模块及真实链路区分验证要求 |
| 无项目 SKILL 可修订 | 仓库文件清单及空 `.agents/` | 不为本次审计添加没有独立工作流用途的技能；通用项目规则集中在 AGENTS.md |

## 验证边界

此次仅新增两份 Markdown。核对本地引用、npm scripts、Python 测试入口、模型门控及 Git 差异；不运行应用测试、模型推理、打包或发布。

没有执行 Astra 修改前后的任务对照，因此不能声称速度、token 成本或正确率已提升。后续若评估效果，应在相同起点和工具条件下比较代表性任务的完成情况、额外确认次数、测试开销及回归问题。
