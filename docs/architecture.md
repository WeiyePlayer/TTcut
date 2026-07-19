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

长任务关闭窗口时触发应用内确认；取消会终止 Python/FFmpeg 子进程树，或中止组件下载并等待安装协程退出。组件安装只写入 `%LOCALAPPDATA%\TTcutData\components`，与 Squirrel 所有的 `%LOCALAPPDATA%\TTcut` 应用安装根隔离；使用任务隔离的 `.staging` 和 `.backup`，启动时恢复中断的备份并清理未完成 staging，断点下载 `.part` 保留供继续使用。

## 数据流

```text
MP4 -> ffprobe -> 四点标定 -> AnalysisRequestV1
     -> Python Worker -> progress JSONL -> AnalysisResultV1
     -> 原子保存历史记录 + FFmpeg 提取首帧封面
     -> Main 重新计算选择 -> CutGroup[]
     -> FFmpeg -> .partial.mp4 -> 探测/同步/元数据验证
     -> 原子改名 -> ttcut-media:// 成片预览
```

Renderer 不能提交任意剪辑时间段；Main 只接受模式、阈值、回合 ID 和枚举化的前后时间，并使用最近一次经验证的分析结果重新计算边界。

历史页只向 Main 提交记录 UUID。Main 使用规范化路径、文件大小和修改时间验证源视频，重新探测媒体后激活已保存的 `AnalysisResultV1`；源文件缺失或变化时拒绝复用。自定义回合预览将原始回合起止各扩展固定 1 秒并截断到源边界，通过 `ttcut-media://` Range 播放；表格时间、剪辑设置和选择状态均不受影响，也不生成临时剪辑。

## 设置与本地数据

- `userData/settings.json`：经 Zod 校验、临时文件写入后原子替换；损坏文件会备份并恢复默认值。
- `userData/history/index.json`、`records/`、`covers/`：本地分析摘要、完整结果和首帧 JPEG；同一文件指纹重新分析时替换旧记录，删除历史不会触碰源视频或输出视频。
- `userData/logs`：技术日志；普通错误页不直接呈现 traceback。
- `%LOCALAPPDATA%\TTcutData\components`：受管组件、下载缓存和来源清单；独立于 Squirrel 应用安装根。
- 输入视频、输出视频和真实验证基线不会上传。

## macOS 迁移边界

Renderer、领域算法、协议类型和 Python Worker 不依赖 Windows。需要替换或验证的边界是：

- Squirrel.Windows 打包器和每用户安装路径；
- Windows 组件清单与 `tar.exe`；
- 进程树终止实现；
- 固定 FFmpeg/macOS Python 运行时资产；
- 签名、公证和媒体协议在 macOS sandbox 下的路径授权。
