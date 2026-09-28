# Windows 分析缓慢：DirectML 探测成功后正式会话初始化失败

后续试用仍在实际推理时触发 CPU 回退，详见
[第二次日志诊断与批量修补](windows-directml-runtime-recovery-2026-09-28.md)。
本文保留第一次日志和补丁的历史证据，不代表问题已在用户机器解决。

## 结论与证据边界

用户提供的 `logs(4).zip` 对应 TTcut 1.3.7。正式 BlurBall 球检测使用 CPU：
DirectML 探测成功后，第二次创建会话失败，Worker 明确回退并在 CPU 上完成分析。
因此优先处理 GPU 启用后的稳定性，而不是先调整码率、抽帧或识别阈值。

现有日志足以确认回退，但不能确认底层失败究竟来自驱动、资源不足还是其他
DirectML/ORT 错误。`UnicodeDecodeError` 遮蔽了原始本地错误，不能据此认定
中文视频路径有问题，也不能据截图认定 GPU 18% 都由 TTcut 产生。

## 日志时间线

分析任务：`00e33c7c-80e0-4178-8f75-25d164cb947b.log`。以下时间为日志 UTC。

| 时间 | 证据 |
| --- | --- |
| 14:08:07.338 | 组件检查报告 ONNX Runtime 1.24.3、`acceleration=directml`。这只是自检状态。 |
| 14:09:06.866 | 开始分析，`requestedDevice=auto`。 |
| 14:09:38.167 | `DirectML model probe passed: 744x264, batch=16`。 |
| 14:09:41.421 | `onnx_models.py:create_session` → ORT `sess.initialize_session` 抛出 `UnicodeDecodeError`，包装为 `DirectML session initialization failed.`。 |
| 14:09:41.427 | `Restarting once on CPU.` |
| 14:09:41.508 | `BlurBall inference runtime: provider=cpu, batch_size=4, precision=float32`。 |
| 15:12:37.541 | 保存结果，解码 28,592 帧，80 个回合。 |

视频约 961.87 秒，1920×1080、H.264、29.729 FPS、约 20 Mbps、VFR。
开始到保存耗时 3810.675 秒（63 分 30.675 秒），整体处理约 7.50 FPS，耗时约
视频时长的 3.96 倍。CPU 推理启动到保存约 62 分 56 秒，不能把这段全部等同于
模型执行时间，因为旧日志没有解码、预处理和后处理的独立计时。

日志中的 `normalizeVariableFrameRate=false`、`processingMode=original_vfr`
说明这次没有额外执行整片 CFR 转码。后面的 `libx264` 日志属于导出，不能用来
判断球检测设备；4 个片段、约 19.83 秒的导出在约 7.4 秒完成。

## 代码定位与本地补丁

基于 `62334daedb0cb8125f6665d25f24c7c1aa5a4af3` 的干净工作区：

1. 原 `directml_probe.select_configuration()` 创建会话、执行探测、销毁会话，
   只返回设备/批量配置。`onnx_models.load_blurball()` 随后再次 `create_session()`。
   用户失败发生在这次重复初始化，尚未开始正式 GPU 球检测。
2. 分析现在保留并复用探测成功的同一个会话。组件检查仍只返回可序列化的配置。
   GPU 配置缓存命中时，也验证当前进程中的实际会话；如推理失败，从缓存批量
   向更小批量试探。保留已有的整任务 CPU 回退保护。
3. 提升探测缓存版本，避免旧版本记录的 CPU 回退继续阻止新实现尝试 DirectML。
4. 当原生异常被错误地按 UTF-8 解码时，保留其原始字节按 Windows 本地编码解码的
   内容（限长），同时保留异常链。新报告可继续定位具体 HRESULT/驱动错误。
5. 全量预测结束时记录设备、帧数、推理耗时、预测总耗时、平均 FPS。计时写入
   stderr，不破坏 Worker stdout 的 JSONL 协议。推理耗时包含现有热图转换，
   预测总耗时还包含解码、预处理及轨迹输出，并非整任务全部耗时。

这项修补消除了已观察到的重复初始化失败点；不等于已经在用户机器上证明
驱动问题修复，也没有修改模型、识别阈值、抽帧策略或发布版本。

## 多 GPU 判断

仓库原注释声称默认 adapter 0，但随包 ORT 1.24.3 的 Python 绑定通过
`CreateFromProviderOptions()`，未指定 `device_id` 时走 DXCore 设备选取，默认
GPU 过滤并按高性能排序。已修正这条过时注释及缓存身份标签。因此不能直接套用
旧 C API 的 device_id=0 说明，推断该用户一定误用了 Intel 核显。

官方源码：

- [ORT 1.24.3 Python provider binding](https://github.com/microsoft/onnxruntime/blob/v1.24.3/onnxruntime/python/onnxruntime_pybind_state.cc)
- [ORT 1.24.3 DirectML provider factory](https://github.com/microsoft/onnxruntime/blob/v1.24.3/onnxruntime/core/providers/dml/dml_provider_factory.cc)

原始日志没有显卡名称、适配器 LUID 或逐算子分配，不能确认探测具体使用了哪块
显卡，也不能量化 GPU/CPU 算子比例。

## 验证

- 使用随包 Python / ONNX Runtime 1.24.3，并从本机现有测试环境加载 pytest，
  `test_directml_probe.py`、`test_onnx_models.py`、`test_onnx_fallback_protocol.py`、
  `test_blurball.py`：48 passed。
- 回归覆盖第二次会话创建会失败时仍复用第一次成功会话（冷缓存/热缓存）、
  缓存批量重新验证及缩小、CPU 回退、原始错误保存、JSONL 协议。
- 本机 RTX 4060 Laptop 环境，真实随包 BlurBall ONNX，用户相同输入尺寸
  744×264、batch=16，使用合成归一化张量：只创建一次 DirectML 会话；连续
  三次输出均为有限值，形状为 `[16,3,264,744]`，重复输出最大绝对差为 0。
- 本机旧加载路径也能成功，未复现用户的原生初始化异常。
- 本次未收到源视频，未在用户的 i5-12600K / 未知型号 NVIDIA 环境复测，
  未进行真实视频速度/识别精度对照、Electron/安装包验收或发布。

## 用户机器复测判据

在包含补丁的构建上重新分析同一个视频，确认正式运行日志为 `provider=directml`
且没有 CPU 回退；对比整任务耗时和新增计时。如果仍然失败，依据新增原始错误
再判断驱动、设备/显存等原因。只有 GPU 稳定运行后仍慢，才根据实际计时继续
优化解码、预处理或模型执行；目前不承诺提速倍数。
