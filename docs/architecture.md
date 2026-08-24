# TTcut 架构与安全边界

## 进程分层

1. **Electron Main**：窗口、原生对话框、设置、组件管理、任务互斥、Python/FFmpeg 进程、日志和安全媒体协议。
2. **Preload**：通过 `contextBridge` 暴露固定 `TTcutApi`；只转发白名单 IPC。
3. **React Renderer**：只维护界面状态、标定点和选择，不直接读取本地路径或启动进程。
4. **Python Worker**：读取一条请求 JSON，执行 TrackNet-only 分析，以 JSONL 输出真实进度和一个终态事件。
5. **Media / Domain**：视频探测、FFmpeg 参数、输出验证与纯回合选择/分段算法独立于 React。

## Electron 安全配置

- `contextIsolation: true`
- `nodeIntegration: false`
- Renderer `sandbox: true`
- 导航和新窗口默认拒绝
- 权限请求全部拒绝
- CSP 只允许本地打包资源、字体 data URI 和 `ttcut-media:`
- Electron fuses 禁止 RunAsNode、`NODE_OPTIONS` 和 CLI inspect，启用 ASAR 完整性校验并只从 ASAR 加载应用

本地视频不暴露为 `file://`。Main 为每个已批准路径生成随机令牌，Renderer 只获得 `ttcut-media://` URL；协议实现 Range 读取以支持播放和拖动。

## 任务模型

分析、导出和组件设置共享同一个任务槽，同一时间只允许一个活动任务。所有任务使用 UUID，事件必须带同一任务 ID。

长任务关闭窗口时触发应用内确认；取消会终止 Python/FFmpeg 子进程树，或中止组件下载并等待安装协程退出。组件安装只写入所选安装根的 `<root>\data\components`；使用任务隔离的 `.staging` 和 `.backup`，启动时恢复中断的备份并清理未完成 staging，断点下载 `.part` 保留供继续使用。

## 数据流

```text
原始 MP4/MOV -> ffprobe -> 手动四点或自动五帧球台标定（始终原始媒体）
             -> VFR 判断 -> CFR 派生媒体缓存（失败则显式 VFR 回退）
             -> AnalysisRequestV2（video_path=处理媒体）
             -> Python Worker -> 球台 13 点数据 + progress JSONL
             -> AnalysisResultV1 { source_video, processing, video=实际处理媒体 }
             -> 原子保存历史记录 + FFmpeg 从原始媒体提取首帧封面
             -> Main 重新计算标准模式，或严格验证自定义时间段 -> CutGroup[]
             -> FFmpeg（CFR 保持目标帧率，VFR 回退沿用 VFR 策略）
             -> .partial.mp4 -> 探测/同步/元数据验证
             -> 原子改名 -> ttcut-media:// 成片预览
```

原始媒体负责身份和标定；处理媒体负责球路分析、分析后预览、剪辑和新分析的 XML。旧历史记录没有 `processing` 来源块时保持旧的 VFR 语义，重新分析后才进入该管线。CFR 缓存使用任务隔离的 partial 文件、原子提交和完整校验；失败/取消的本次新缓存会被删除，删除最后一个引用时再清理已成功缓存。

自定义剪辑的默认导出仍生成一个合并 MP4。用户启用“分段导出”和/或“导出 XML”时，Main 使用相同的显式时间段校验，但保留一回合一项：分段导出为每项写入独立 MP4；XML 使用 FCP7 `xmeml` v4，normalized CFR 会在产物目录复制完整 CFR 媒体并让 XML 指向副本，源 CFR/回退/旧记录则引用原始视频，并在连续 V1 与匹配源媒体声道数的链接音频轨时间线上放置入出点。两类产物写入源视频旁唯一的 `_TTcut_自定义` 目录，任一产物成功即可保留；取消会清理该次目录，且此类导出不更新历史记录的单一输出路径。相接片段只在合并 MP4 模式中合并，绝不合并为一个用户可见的分段视频。

“所有回合”和“精彩回合”只提交模式、阈值和枚举化前后时间，Main 使用最近一次经验证的分析结果重新计算边界。单视频“自定义”可提交 Renderer 中已编辑的显式时间段，但 Main 仍是信任边界：它根据历史分析重新验证回合 ID 存在且唯一、数值有限、源视频范围、至少一帧、顺序和不重叠性。相接区间只在验证后合并为一个 `CutGroup`。详见 ADR 0008。

历史页只向 Main 提交记录 UUID。Main 使用规范化路径、文件大小和修改时间验证原始媒体；normalized CFR 记录还会检查完整处理媒体文件是否仍存在，缺失时拒绝复用。处理媒体在生成时已经过 FFprobe/FFmpeg 完整校验，自定义页通过 `ttcut-media://` Range 直接播放实际处理媒体，不生成预览临时文件；时间轴草稿只存在 Renderer 内存中。

## 设置与本地数据

- `userData/settings.json`：经 Zod 校验、临时文件写入后原子替换；损坏文件会备份并恢复默认值。
- `userData/history/index.json`、`records/`、`covers/`：本地分析摘要、完整结果、自动标定的五帧/13 点结构化数据和首帧 JPEG；同一文件指纹重新分析时替换旧记录，删除历史不会触碰源视频或输出视频。
- `userData/logs`：技术日志；普通错误页不直接呈现 traceback。
- `<root>\app`：可由安装、修复和自动更新替换的程序区。
- `<root>\data\components`：受管组件、下载缓存、导入暂存、回滚备份和来源清单。
- `<root>\data\processing-media\v1`：按原始媒体指纹、目标 FPS、编码器和策略版本隔离的 CFR 派生媒体缓存。
- `%APPDATA%\TTcut`：设置、历史、日志和 Chromium 状态，不随组件存储位置变化。
- 输入视频、输出视频和真实验证基线不会上传。

## macOS 迁移边界

Renderer、领域算法、协议类型和 Python Worker 不依赖 Windows。需要替换或验证的边界是：

- NSIS 安装器、注册表安装布局和 Windows 固定盘路径策略；
- Windows 组件清单与 `tar.exe`；
- 进程树终止实现；
- 固定 FFmpeg/macOS Python 运行时资产；
- 签名、公证和媒体协议在 macOS sandbox 下的路径授权。
