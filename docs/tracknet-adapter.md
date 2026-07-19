# TrackNet 最小适配器

## 来源与范围

派生源固定为 TrackNetV3_TableTennis 提交 `40d4d26bc85802d5925ead6b1fd0ad3c6a8a84ba`。逐文件来源见 `worker/SOURCE_MANIFEST.md`。

发行 Worker 只保留：

- TrackNet 模型结构和严格 checkpoint 加载；
- OpenCV 流式解码、逐帧时间戳和 TrackNet/missing 轨迹点；
- 热图候选提取与连续性选择；
- 四点单应性标定；
- 三帧/五帧弹跳检测；
- 仅依赖弹跳事件的回合分组；
- stdin 一条 JSON、stdout JSONL 的 Worker 入口。

Release staging 和审计会拒绝测试、缓存、`.pt/.pth` 权重以及 Inpaint、速度、击球、叠加、Gradio/WebUI 相关名称。运行依赖只有 PyTorch、NumPy 和 OpenCV；标准库不另列。

## 推理与轨迹

- 模型输入为 512×288，按 checkpoint 的 `seq_len` 和 `bg_mode` 建立网络。
- 权重通过 `model.load_state_dict(..., strict=True)` 加载。
- 默认批量为 4 个序列；每个真实解码帧必须得到一个轨迹点。
- 轨迹点来源只允许 `tracknet` 或 `missing`。
- CUDA 显存不足转换为可恢复的设备错误；`auto` 在 CUDA 可用时选 CUDA，否则选 CPU。
- stdout 只写协议 JSONL；traceback 和底层诊断只写 stderr。

## 弹跳和回合

- 三帧：三帧都可见且中帧 Y 严格大于前后帧。
- 五帧：首尾可见，中间至少一帧可见；选择 Y 最大且更靠近窗口中心的候选。
- 帧号必须连续、时间必须有限且严格递增。
- 标定映射后的落点允许球桌长度方向 35 cm、宽度方向 25 cm 容差。
- 相邻候选至少间隔 0.12 秒。
- 相邻弹跳时间差 `<= 3.0` 秒同组，`> 3.0` 秒分组。
- 少于两个弹跳的孤立组丢弃；回合开始/结束为首末弹跳时间。

## 真实权重验证

验证输入：

- `1-193.mp4`，SHA-256 `76a1a8b1af63c4299cba250514dce9dbb9ecea020f03f6681b3fa37530b6c090`
- `TrackNet_best.pt`，SHA-256 `ffb5469161c4bd39a5a7e745c3d13f076b2c5e575f33279ea62f1e5803245a52`
- 标定点：`(695,303) (934,315) (831,413) (466,381)`
- CUDA / RTX 4060 Laptop、Python 3.12.13、PyTorch 2.12.1+cu126

结果：15,207 帧全部对齐；5,491 个可见坐标逐点完全相同；212 个原始弹跳、47 个有效回合和 204 个组内弹跳与当前核心算法完全一致。Worker stderr 为 0，未生成叠加视频。

旧的 `output/1-193_events.csv` 早于当前弹跳检测实现，不能作为该提交的有效事件基线。

## 权重边界

应用固定检查上述权重 SHA-256。权利人 `weiye` 已授权将权重作为 TTcut 分析组件的一部分公开分发；正式版在用户同意安装分析组件后从固定 Release 下载到受管组件目录，安装包和 Git 仓库均不包含该文件。生产运行时不提供权重路径覆盖或目录导入入口。
