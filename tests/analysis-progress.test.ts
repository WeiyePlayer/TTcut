import { describe, expect, it } from 'vitest';
import { overallAnalysisProgress } from '../src/domain/analysis-progress';

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
});
