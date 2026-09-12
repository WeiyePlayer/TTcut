import { describe, expect, it } from 'vitest';
import { batchOutputProfile, batchSegmentDuration, buildBatchSegmentArgs } from '../src/main/batch-media-plan';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';

const video: VideoMetadata = {
  path: 'C:\\match.mp4', duration_seconds: 10, width: 1920, height: 1080, fps: 29.8,
  nominal_fps_ratio: '30000/1001', average_fps_ratio: '149/5', variable_frame_rate: true,
  video_codec: 'h264', audio_codec: null, container: 'mp4',
};
const group: CutGroup = { start: 1.123, end: 4.567, rawStart: 2, rawEnd: 3, rallyIds: ['rally_001'] };

describe('merged video encoding plan', () => {
  it('uses the nominal rational frame rate, then the average, without mutating the input', () => {
    const output = batchOutputProfile(video, true);
    expect(output.fps).toBeCloseTo(30000 / 1001, 8);
    expect(output).toMatchObject({ variable_frame_rate: false, audio_codec: 'aac', audio_channels: 2, audio_sample_rate: 48000 });
    expect(video.variable_frame_rate).toBe(true);
    expect(video.audio_codec).toBeNull();
    expect(batchOutputProfile({ ...video, nominal_fps_ratio: '0/0' }, false).fps).toBeCloseTo(29.8, 8);
    expect(batchOutputProfile({ ...video, nominal_fps_ratio: null, average_fps_ratio: null }, false).fps).toBeCloseTo(29.8, 8);
  });

  it('uses macOS nominal FPS when VFR average differs and the nominal ratio is absent', () => {
    const output = batchOutputProfile({ ...video, nominal_fps_ratio: null, nominal_fps: 30, average_fps_ratio: '18/1', fps: 18 }, false);
    expect(output.fps).toBe(30);
  });

  it('quantizes each clip to whole output frames and uses an exactly divisible track timescale', () => {
    const profile = batchOutputProfile(video, false);
    const duration = batchSegmentDuration(group, profile);
    expect(Math.abs(duration - (group.end - group.start))).toBeLessThanOrEqual(0.5 / profile.fps);
    const args = buildBatchSegmentArgs(video, profile, group, 'out.mp4', 'libx264');
    expect(args[args.indexOf('-video_track_timescale') + 1]).toBe('30000');
    expect(args[args.indexOf('-r') + 1]).toBe('30000/1001');
    expect(args).toContain('-bf');
    expect(args).not.toContain('[aout]');
  });

  it('pads rather than stretches portrait media and supplies silent audio only when required', () => {
    const profile = batchOutputProfile(video, true);
    const args = buildBatchSegmentArgs({ ...video, width: 1080, height: 1920, rotation: 90 }, profile, group, 'out.mp4', 'libopenh264');
    expect(args).toContain('-autorotate');
    expect(args).toContain('anullsrc=r=48000:cl=stereo');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('force_original_aspect_ratio=decrease');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('pad=1920:1080:');
    expect(args).not.toContain('-bf');
  });
});
