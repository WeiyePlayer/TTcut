import { describe, expect, it } from 'vitest';
import { requestedAnalysisDevice } from '../src/domain/analysis-device';

describe('ball model analysis device selection', () => {
  it('lets TrackNet and BlurBall use auto, CUDA, or CPU components', () => {
    for (const device of ['auto', 'cuda', 'cpu'] as const) {
      expect(requestedAnalysisDevice('tracknet_v1', device)).toBe(device);
      expect(requestedAnalysisDevice('blurball_v1', device)).toBe(device);
    }
  });
});
