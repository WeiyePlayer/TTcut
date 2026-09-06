import { describe, expect, it } from 'vitest';
import {
  IN_FLIGHT_EXPORT_PROGRESS_END,
  mapFfmpegProgress,
  STREAM_COPY_ATTEMPT_PROGRESS_END,
} from '../src/domain/export-progress';

describe('export progress mapping', () => {
  it('maps each segment into its cumulative share instead of reporting the first segment as complete', () => {
    const totalDuration = 277.383334;
    const firstSegmentDuration = 5.2;
    const firstSegmentEnd = firstSegmentDuration / totalDuration * 90;

    expect(mapFfmpegProgress(firstSegmentDuration, firstSegmentDuration, {
      startPercent: 0,
      endPercent: firstSegmentEnd,
    })).toBeCloseTo(1.6872, 3);
    expect(mapFfmpegProgress(totalDuration, totalDuration, {
      startPercent: 0,
      endPercent: 90,
    })).toBe(90);
    expect(mapFfmpegProgress(totalDuration, totalDuration, {
      startPercent: 90,
      endPercent: 99,
    })).toBe(99);
  });

  it('reserves 100 percent for the validated export result', () => {
    expect(mapFfmpegProgress(10, 10)).toBe(99);
    expect(mapFfmpegProgress(11, 10)).toBe(99);
  });

  it('supports a bounded range for each independently encoded rally video', () => {
    expect(mapFfmpegProgress(4, 8, { startPercent: 35, endPercent: 55 })).toBe(45);
    expect(mapFfmpegProgress(8, 8, { startPercent: 35, endPercent: 55 })).toBe(55);
  });

  it('leaves progress available when stream copy falls back to accurate encoding', () => {
    expect(mapFfmpegProgress(8, 8, {
      startPercent: 0,
      endPercent: STREAM_COPY_ATTEMPT_PROGRESS_END,
    })).toBe(10);
    expect(mapFfmpegProgress(4, 8, {
      startPercent: STREAM_COPY_ATTEMPT_PROGRESS_END,
      endPercent: IN_FLIGHT_EXPORT_PROGRESS_END,
    })).toBe(54.5);
  });
});
