import { describe, expect, it } from 'vitest';
import { validatePreview } from '../src/domain/preview-validation';
import type { VideoMetadata } from '../src/shared/contracts';

const video = (overrides: Partial<VideoMetadata> = {}): VideoMetadata => ({
  path: '/tmp/preview.mp4', duration_seconds: 100, fps: 30, width: 320, height: 180,
  video_codec: 'h264', pixel_format: 'yuv420p', audio_codec: 'aac', container: 'mp4',
  variable_frame_rate: false, video_duration_seconds: 90, ...overrides,
});
describe('native preview cache validation', () => {
  it('accepts video coverage despite longer audio/container timing or full-range H.264', () => {
    expect(() => validatePreview(video({ video_start_time_seconds: 10 }), video({
      duration_seconds: 101, video_duration_seconds: 90.05, pixel_format: 'yuvj420p',
    }))).not.toThrow();
  });
  it('rejects truncated video and unsupported formats', () => {
    expect(() => validatePreview(video(), video({ video_duration_seconds: 85 }))).toThrow('VIDEO_TRUNCATED');
    expect(() => validatePreview(video(), video({ pixel_format: 'yuv420p10le' }))).toThrow('FORMAT_UNSUPPORTED');
    expect(() => validatePreview(video(), video({ video_codec: 'hevc' }))).toThrow('FORMAT_UNSUPPORTED');
  });
  it('uses frame counts only when stream duration is missing, never container duration', () => {
    const source = video({ video_duration_seconds: null, frame_count: 2700 });
    expect(() => validatePreview(source, video({ video_duration_seconds: null, frame_count: 2699 }))).not.toThrow();
    expect(() => validatePreview(source, video({ video_duration_seconds: null, frame_count: 2400 }))).toThrow('VIDEO_TRUNCATED');
    expect(() => validatePreview(video({ video_duration_seconds: null }), video({ duration_seconds: 10, video_duration_seconds: null }))).not.toThrow();
  });
});
