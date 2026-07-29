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

const CALIBRATION_RANGES: Record<string, readonly [number, number]> = {
  table_sampling: [0, 40],
  table_model: [40, 60],
  table_inference: [60, 100],
};

function mapProgress(
  ranges: Record<string, readonly [number, number]>,
  stage: string,
  percent: number,
): number {
  const range = ranges[stage] ?? [0, 100];
  const local = Math.max(0, Math.min(100, percent));
  return range[0] + (range[1] - range[0]) * local / 100;
}

export function overallAnalysisProgress(
  stage: string,
  percent: number,
  calibrationMethod: 'manual' | 'automatic' | 'precalibrated' = 'manual',
): number {
  const ranges = calibrationMethod === 'automatic' ? AUTOMATIC_ANALYSIS_RANGES : MANUAL_ANALYSIS_RANGES;
  return mapProgress(ranges, stage, percent);
}

export function overallCalibrationProgress(stage: string, percent: number): number {
  return mapProgress(CALIBRATION_RANGES, stage, percent);
}
