const MANUAL_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 3],
  load_model: [3, 10],
  analysis: [10, 96],
  postprocess: [96, 100],
};

const AUTOMATIC_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 3],
  table_sampling: [3, 18],
  table_model: [18, 25],
  table_inference: [25, 32],
  load_model: [32, 40],
  analysis: [40, 96],
  postprocess: [96, 100],
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
