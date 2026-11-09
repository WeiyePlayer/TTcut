# 01: 预览给用户发起的任务让路

**What to build:** macOS 上 HDR 兼容预览转码进行时，用户开始标定、分析或导出会直接中止预览而不再报 TASK_BUSY；有用户任务在跑时预览请求在主进程等待（不再返回 TASK_BUSY，见 03）。只剩预览时，历史记录操作与退出不受拦截，退出时仍会清理预览的转码进程。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 预览以可抢占任务登记，不计入用户任务的忙碌判定
- [x] 用户任务开始时中止所有可抢占预览及其子进程
- [x] 有用户任务时，新的预览请求在主进程等待（原为返回 TASK_BUSY，已由 03 改为主进程排队）
- [x] 退出时取消并等待预览进程结束
- [x] processes 单元测试覆盖抢占、等待、退出清理；`npm test` 与 typecheck 通过
