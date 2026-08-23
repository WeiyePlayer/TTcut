import { describe, expect, it } from 'vitest';
import { requestedAnalysisDevice } from '../src/domain/analysis-device';

describe('BlurBall analysis device selection', () => {
  it('preserves the requested component preference', () => {
    for (const device of ['auto', 'cuda', 'cpu'] as const) {
      expect(requestedAnalysisDevice(device)).toBe(device);
    }
  });
});
