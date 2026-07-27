const MANUAL_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 3],
  load_model: [3, 10],
  analysis: [10, 96],
  postprocess: [96, 100],
};

const AUTOMATIC_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 0],
  table_sampling: [0, 2],
  table_model: [2, 3],
  table_inference: [3, 5],
  load_model: [5, 5],
  analysis: [5, 100],
  postprocess: [100, 100],
};

export function overallAnalysisProgress(
  stage: string,
  percent: number,
  calibrationMethod: 'manual' | 'automatic' = 'manual',
): number {
  const ranges = calibrationMethod === 'automatic' ? AUTOMATIC_ANALYSIS_RANGES : MANUAL_ANALYSIS_RANGES;
  const range = ranges[stage] ?? [0, 100];
  const local = Math.max(0, Math.min(100, percent));
  return range[0] + (range[1] - range[0]) * local / 100;
}
