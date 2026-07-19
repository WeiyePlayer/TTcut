import { describe, expect, it } from 'vitest';
import { RALLY_PREVIEW_PADDING_SECONDS, rallyPreviewRange } from '../src/domain/preview';
import type { Rally } from '../src/shared/contracts';

function rally(start: number, end: number): Rally {
  return {
    id: 'rally_003',
    index: 3,
    bounce_count: 9,
    start_time_seconds: start,
    end_time_seconds: end,
  };
}

describe('rally preview range', () => {
  it('uses fixed one-second padding for rally 3 of 1-193.mp4', () => {
    expect(RALLY_PREVIEW_PADDING_SECONDS).toBe(1);
    expect(rallyPreviewRange(rally(32.065, 37.937), 507.44)).toEqual({
      start: 31.065,
      end: 38.937,
    });
  });

  it('clamps preview padding to the source boundaries', () => {
    expect(rallyPreviewRange(rally(0.4, 9.7), 10)).toEqual({ start: 0, end: 10 });
  });

  it('rejects an invalid source duration', () => {
    expect(() => rallyPreviewRange(rally(1, 2), 0)).toThrow('INVALID_VIDEO_DURATION');
  });
});
