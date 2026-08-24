const MANUAL_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 3],
  load_model: [3, 10],
  analysis: [10, 96],
  postprocess: [96, 100],
};

const MANUAL_TWO_STAGE_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 3],
  load_model: [3, 10],
  candidate_analysis: [10, 55],
  interval_union: [55, 56],
  refinement_analysis: [56, 96],
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

const AUTOMATIC_TWO_STAGE_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [0, 0],
  table_sampling: [0, 2],
  table_model: [2, 3],
  table_inference: [3, 5],
  load_model: [5, 5],
  candidate_analysis: [5, 50],
  interval_union: [50, 51],
  refinement_analysis: [51, 96],
  postprocess: [96, 100],
};

const NORMALIZED_MANUAL_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  probe: [25, 25],
  load_model: [25, 25],
  analysis: [25, 96],
  candidate_analysis: [25, 70],
  interval_union: [70, 71],
  refinement_analysis: [71, 96],
  postprocess: [96, 100],
};

const NORMALIZED_AUTOMATIC_ANALYSIS_RANGES: Record<string, readonly [number, number]> = {
  table_sampling: [0, 2],
  table_model: [2, 3],
  table_inference: [3, 5],
  probe: [30, 30],
  load_model: [30, 30],
  analysis: [30, 100],
  candidate_analysis: [30, 78],
  interval_union: [78, 79],
  refinement_analysis: [79, 100],
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
  analysisMode: 'full' | 'two_stage' = 'full',
  processingMode: 'source' | 'normalized' = 'source',
): number {
  const ranges = processingMode === 'normalized'
    ? (calibrationMethod === 'automatic'
      ? NORMALIZED_AUTOMATIC_ANALYSIS_RANGES
      : NORMALIZED_MANUAL_ANALYSIS_RANGES)
    : analysisMode === 'two_stage'
      ? (calibrationMethod === 'automatic' ? AUTOMATIC_TWO_STAGE_ANALYSIS_RANGES : MANUAL_TWO_STAGE_ANALYSIS_RANGES)
      : (calibrationMethod === 'automatic' ? AUTOMATIC_ANALYSIS_RANGES : MANUAL_ANALYSIS_RANGES);
  return mapProgress(ranges, stage, percent);
}

export function overallCalibrationProgress(stage: string, percent: number): number {
  return mapProgress(CALIBRATION_RANGES, stage, percent);
}
