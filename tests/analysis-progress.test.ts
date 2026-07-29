import { describe, expect, it } from 'vitest';
import { overallAnalysisProgress, overallCalibrationProgress } from '../src/domain/analysis-progress';

describe('analysis progress mapping', () => {
  it('keeps the manual TrackNet analysis mapping unchanged', () => {
    expect(overallAnalysisProgress('load_model', 100)).toBe(10);
    expect(overallAnalysisProgress('analysis', 50)).toBe(53);
    expect(overallAnalysisProgress('postprocess', 100)).toBe(100);
  });

  it('reserves 5% for automatic calibration and 95% for analysis', () => {
    expect(overallAnalysisProgress('table_sampling', 50, 'automatic')).toBe(1);
    expect(overallAnalysisProgress('table_model', 100, 'automatic')).toBe(3);
    expect(overallAnalysisProgress('table_inference', 100, 'automatic')).toBe(5);
    expect(overallAnalysisProgress('load_model', 100, 'automatic')).toBe(5);
    expect(overallAnalysisProgress('analysis', 50, 'automatic')).toBe(52.5);
    expect(overallAnalysisProgress('postprocess', 100, 'automatic')).toBe(100);
  });

  it('treats precalibrated analysis as TrackNet-only work', () => {
    expect(overallAnalysisProgress('load_model', 100, 'precalibrated')).toBe(10);
    expect(overallAnalysisProgress('analysis', 50, 'precalibrated')).toBe(53);
  });

  it('maps the three automatic calibration stages onto one continuous bar', () => {
    expect(overallCalibrationProgress('table_sampling', 50)).toBe(20);
    expect(overallCalibrationProgress('table_sampling', 100)).toBe(40);
    expect(overallCalibrationProgress('table_model', 0)).toBe(40);
    expect(overallCalibrationProgress('table_model', 100)).toBe(60);
    expect(overallCalibrationProgress('table_inference', 50)).toBe(80);
    expect(overallCalibrationProgress('table_inference', 100)).toBe(100);
  });
});
