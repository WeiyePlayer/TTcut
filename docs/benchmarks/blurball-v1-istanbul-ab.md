# BlurBall v1 / TrackNet v1 Istanbul A/B

## 结论边界

本报告比较同一视频、同一标定、同一动态 ROI 和同一台机器上的客观输出差异。没有人工逐帧真值，因此不能据此断言哪一个模型更准确。TTcut 的“板数”是球在球台区域内的反弹/落点代理数，不是经人工确认的真实挥拍次数。

## 测试输入

- 视频：`Maharu Yoshimura vs Andrej Gacina - MS Final - WTT Feeder Istanbul 2026.mp4`
- 视频大小：101,153,938 bytes
- SHA-256：`9bf7676b1a3a400d3318f26393f263b73fe2c834692d35ac66f4fa33c42083ed`
- 解码帧数：20,131
- 源文件前后哈希与大小：一致
- 环境：Windows、Python 3.12.13、PyTorch 2.12.1+cu126、RTX 4060 Laptop GPU

## 规则

- BlurBall：检测阈值 `0.7`，步长 `3`，相邻可见帧最大位移 `< 100 px`。
- BlurBall 弹跳：局部二维轨迹速度变化、分段拟合增益和单侧轨迹出现/消失候选。
- TTcut 既有规则：最小弹跳间隔 `0.315 s`，长边放宽 `35 cm`，短边放宽 `25 cm`，回合最大相邻间隔 `3 s`。
- 有效落点区域：标定球台坐标 `x ∈ [-35, 309] cm` 且 `y ∈ [-25, 177.5] cm`。
- 两模型均使用同一动态 ROI；本视频实际模型输入均为 `280×160`，坐标随后映射回源视频。

## 结果

| 指标 | TrackNet v1 | BlurBall v1 | 差异 |
|---|---:|---:|---:|
| 端到端分析时间 | 1764.96 s | 1562.46 s | BlurBall 少 202.50 s（11.47%） |
| 纯模型前向时间 | 89.34 s | 93.50 s | BlurBall 多 4.16 s（4.66%） |
| 平均预测吞吐 | 11.43 FPS | 12.95 FPS | BlurBall 高 13.30% |
| 可见轨迹帧 | 5,135 | 6,197 | BlurBall 多 1,062（20.68%） |
| 全部落点候选 | 153 | 182 | BlurBall 多 29（18.95%） |
| 有效回合 | 40 | 42 | BlurBall 多 2（5.00%） |
| 回合内代理板数合计 | 150 | 181 | BlurBall 多 31（20.67%） |
| 峰值 CUDA 显存 | 449.8 MiB | 1114.6 MiB | BlurBall 多 664.8 MiB |

BlurBall 的端到端时间更短，但纯模型前向略慢；差异主要来自两个预测器的解码、预处理和后处理实现，而不是 BlurBall 前向更快。BlurBall 同时给出更多可见帧、落点候选和回合内代理板数；没有人工真值时，这只能说明输出数量不同，不能解释为准确率更高。

机器可读数据见 `blurball-v1-istanbul-ab.json`。完整逐帧原始基准保存在 `artifacts/blurball-v1-istanbul/tracknet_v1.json` 与 `artifacts/blurball-v1-istanbul/blurball_v1.json`。
