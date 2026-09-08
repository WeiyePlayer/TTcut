# 融合回合识别缓存验收

开发工具 `scripts/validate-hybrid-rallies.py` 只重放缓存轨迹，不载入模型、不解码视频。
输出目录必须是新目录，以免覆盖已有人工证据。JSON 保存完整指标，CSV 按期望项列出
实际区间、板数、筛除原因及 one_to_one / split / merged / missing / unexpected 关系。

## 输入与命令

使用具有项目 Python 依赖的解释器，从仓库根目录执行：

```text
python scripts/validate-hybrid-rallies.py worker/tests/fixtures/visibility-motion-c51.json.gz --output .baseline/hybrid-c51-review
python scripts/validate-hybrid-rallies.py cache.json.gz --labels labels.json --output .baseline/hybrid-approved-check --check
```

缓存 JSON/gzip 字段：`fps`、`calibration`（video_width/video_height/points）、
`analysis_roi`（x0/y0/x1/y1），或 `width/height` 表示分析区域尺寸，以及 `trajectory`。
轨迹行支持 `[time,visibility,x,y]`（索引为源帧）、`[frame,time,visibility,x,y]`
或完整 TrajectoryPoint 字段。坐标必须与校准同一源图像空间，不能传模型缩放坐标。
新 XML 回归缓存也支持 `motion_config` 和六列 `[frame,time,visibility,x,y,confidence]`；
后者保留完整置信度，使用顶层 `time_source`，不按平均帧率重建 VFR 时间。
缺少置信度时使用既有 TrajectoryPoint 默认值 0，并在报告标记；落点依赖置信度的
候选可能因此减少，这类报告不能冒充完整缓存或新推理的效果证明。

人工标注结构：

```json
{
  "approved": false,
  "tolerance_seconds": 0,
  "rallies": [{"start_time_seconds": 1, "end_time_seconds": 5, "bounce_count": 4}],
  "excluded_fragments": [{"start_time_seconds": 6, "end_time_seconds": 8, "reasons": ["dead_bounce_cluster"]}]
}
```

逐项审核实际结果与期望区间、类型、板数后，由人工填写 `approved: true`，将缓存、
标注和批准结果一并冻结到回归基线。脚本不自动批准、不用当前输出覆盖期望。
`--check` 要求明确批准且逐条匹配，否则非零退出；无标注时批准状态为 false，匹配值为 null。
容差仅由人工标注指定，默认精确时间比较，不能用总回合数代替边界验收。

## 限制

单元测试中的合成轨迹和注入落点用于验证规则，现有真实缓存用于开发复盘。
旧连续模式的人工 core/XML 标注不是融合算法的逐帧批准结果，不能自动转成新基线。
尚未提供的新人工标注保持待验收；不生成“已批准”的虚假样本。

## 2026-09-08 XML 对照优化

三段完整轨迹、原始边界和 XML 源区间已冻结为 `worker/tests/fixtures/hybrid-xml-*.json.gz`，
不包含原视频。未调整的边界以旧历史为期望，不从新输出生成期望；另列两个原视频核对的
尾部补全例外。详细方法、改善与未解决项见 [优化报告](hybrid-xml-optimization-20260908.md)。

```text
python -m pytest worker/tests/test_hybrid_xml_regression.py -q
python scripts/validate-hybrid-rallies.py worker/tests/fixtures/hybrid-xml-side.json.gz --output .baseline/hybrid-side-v2-review
```

后一命令是完整轨迹重放报告，不自动标记人工批准。XML 含前后余量和相邻片段中点裁切，
不能把 XML 边界直接当作算法原始边界；本次按导出器实际使用的整数 timebase 还原编辑时间。
