# 01: 源目录不可写时导出自动改存到「影片/TTcut」

**What to build:** 单视频页和自定义页导出（合并视频、分段视频、Premiere XML，含 `destination: 'source'` 与对话框默认位置）在源视频目录不可写时，不弹窗，自动写到 `~/Movies/TTcut`（`app.getPath('videos')/TTcut`），结果页显示实际路径并可打开所在文件夹。源目录可写时行为完全不变。设计见 `../spec.md` 第 1、2 节。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Main 中有一个共享的输出目录解析：源目录写探测失败（EACCES/EPERM/EROFS）时创建并返回回退目录，并记录日志
- [ ] 回退目录也不可写时仍报 `OUTPUT_DIRECTORY_UNWRITABLE`；ENOENT 等其他错误不触发回退
- [ ] 合并视频、自定义分段视频与 XML 目录、`destination: 'source'` 都落到回退目录，同名后缀规则不变
- [ ] 请求契约不新增字段；结果中的输出路径为实际路径
- [ ] 单元测试用只读临时目录模拟不可写源目录；`npm test` 与 typecheck 通过
