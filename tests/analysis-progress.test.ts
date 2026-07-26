import { describe, expect, it } from 'vitest';
import { overallAnalysisProgress } from '../src/domain/analysis-progress';

describe('analysis progress mapping', () => {
  it('maps TrackNet analysis stages to the full progress range', () => {
    expect(overallAnalysisProgress('load_model', 100)).toBe(10);
    expect(overallAnalysisProgress('analysis', 50)).toBe(53);
    expect(overallAnalysisProgress('postprocess', 100)).toBe(100);
  });
});
