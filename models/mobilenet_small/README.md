# Small 一轮微调候选与 6 fps 时序层

本目录补齐 TTcut 本地 Small 后端此前依赖的外部模型与算法源码。文件来自 `E:\MobileNetV3-Large`，对应用户选定的冻结候选及 2026-09-30 重新拟合的时序配置。

## 文件入口

| 内容 | 文件 | SHA256 |
|---|---|---|
| 一轮微调候选权重，MobileNetV3-Small | [best.pt](huji_student/runs/manual_p3_20260930_epoch1/best.pt) | `22f0d7639106e5997c77e76d948f1b11848cd6af7efd6fbf75d3f19e97c982ed` |
| 重新拟合的 6 fps 时序参数 | [balanced.json](config/rally_decoder_small_epoch1_refit_6fps_20260930_balanced.json) | `47eca8435f29ec56ea0d40ab229b6f7eb3453924ba78d954c1cf6da988bdff17` |

- [来源与身份清单](manifest.json)：权重和配置的绑定关系、数据集哈希与拟合设置。
- [完整拟合脚本](annotation_tools/refit_small_candidate.py)：准备标注、按真实 6 fps 评分、分组交叉拟合、选择时序参数及评估。
- [校准器](rally_detection/calibration.py)：多尺度时序特征、正则化逻辑回归拟合及预测。
- [解码器](rally_detection/decoder.py)、[边界修正](rally_detection/refinement.py)、[时序推理入口](rally_detection/pipeline.py)：评分到阶段及回合的实际算法。
- [模型构建与加载](huji_student/train.py)、[图像评分](rally_detection/score.py)：加载候选检查点所需的架构及预处理。
- [评估摘要](evaluation_summary.json)：原配置与新配置在原训练、验证、评估划分中的对照。

候选权重文件大小为 **6,219,031 字节**，是完整 PyTorch 检查点，可以从 GitHub 下载；没有使用 Git LFS 指针。它是此前冻结的 `manual_p3_20260930_epoch1` 一轮候选。继续训练后产生的 `c9c0…` 权重不是本目录的选用模型。这里的 epoch1 是按第二次实验设置复现的第一个微调 epoch，不能与“第一次微调实验”的选模结果混称。

## 拟合依据与限制

针对该候选的原始 **6 fps** 分数拟合，类别顺序为 `serve / play / other`，解码器 ID 为 `fde1bc9ab4419b4e`。数据为 Label Studio 项目 2 的 16 段连续完整标注，以及项目 3 的 239 段活动片段，共 255 段；train / val / test 数量为 181 / 44 / 30。

训练分组按来源场次隔离，使用三折训练分组预测选择参数，显式惩罚回合拆分、合并和 Other 误报。未标注及 IGNORE 时间不作为 Other。标注帧范围不得超过视频真实结尾。这里的测试划分已在此前开发中评估过，图像模型也见过部分连续视频，不能当作全新未见素材的泛化证明。评估摘要来自时序拟合时，早于后续的“对打不足 2 秒剔除”剪辑策略；没有把策略变化后的指标当作已测结果。

## 重放与再次拟合

本目录具有完整 Python 包结构；使用已安装 NumPy、PyTorch、torchvision、Pillow、OpenCV 的训练环境。命令行先将工作目录设为本目录，以优先加载这里的源码。

```powershell
# 在 TTcut/models/mobilenet_small 中执行；输出路径必须是新文件。
& 'E:\MobileNetV3-Large\.venv-training\Scripts\python.exe' -m rally_detection.pipeline `
  --scores 'E:\MobileNetV3-Large\data\rally_detection\manual_p3_epoch1_6fps\vid_0194299495da.npz' `
  --output '<新的重放结果.json>'

& 'E:\MobileNetV3-Large\.venv-training\Scripts\python.exe' -m annotation_tools.refit_small_candidate fit `
  --project-root 'E:\MobileNetV3-Large' `
  --export 'E:\MobileNetV3-Large\data\annotations\label_studio_p3_20260930_refit01.json' `
  --scores 'E:\MobileNetV3-Large\data\rally_detection\manual_p3_epoch1_6fps' `
  --output '<新的拟合报告目录>' --model-output '<新的配置.json>'
```

`--project-root` 指定本机训练数据工程，保留原始数据清单和来源哈希检查；算法实现来自本目录。用户原始视频、人工标注、评分缓存和 Python 环境没有纳入上传，所以仅克隆仓库不能凭空重新生成训练数据。

本次补传不修改已运行的 TTcut，不重新打包，不切换模型。TTcut 当前仍通过 `TTCUT_MOBILENET_ROOT` 指定的外部工程加载运行环境和选定模型；本目录是同一份权重、配置及源码的可下载存档。
