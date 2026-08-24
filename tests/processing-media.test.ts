import { describe, expect, it } from 'vitest';
import { processingMediaCacheKey, targetFrameRateRatio } from '../src/main/processing-media';
import type { VideoMetadata } from '../src/shared/contracts';

const base: VideoMetadata = {
  path: 'D:/source.mp4',
  duration_seconds: 10,
  width: 1920,
  height: 1080,
  fps: 57.8788,
  variable_frame_rate: true,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
};

describe('processing media frame-rate selection', () => {
  it('prefers the exact nominal ratio over the average ratio', () => {
    expect(targetFrameRateRatio({
      ...base,
      nominal_fps_ratio: '60000/1001',
      average_fps_ratio: '6684600/115493',
    })).toBe('60000/1001');
  });

  it('falls back to the exact average ratio when nominal is unavailable', () => {
    expect(targetFrameRateRatio({ ...base, average_fps_ratio: '30000/1001' })).toBe('30000/1001');
  });

  it('derives a reduced decimal ratio only when both exact ratios are absent', () => {
    expect(targetFrameRateRatio({ ...base, fps: 59.94 })).toBe('2997/50');
  });

  it('changes the cache key when source identity, target rate, or encoder changes', () => {
    const source = { path: base.path, size: 10, modified_time_ms: 20 };
    const original = processingMediaCacheKey(source, '60000/1001', 'libopenh264');
    expect(processingMediaCacheKey({ ...source, size: 11 }, '60000/1001', 'libopenh264')).not.toBe(original);
    expect(processingMediaCacheKey(source, '30000/1001', 'libopenh264')).not.toBe(original);
    expect(processingMediaCacheKey(source, '60000/1001', 'libx264')).not.toBe(original);
  });
});
