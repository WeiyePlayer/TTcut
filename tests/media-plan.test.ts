import { describe, expect, it } from 'vitest';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';
import {
  buildReencodeArgs,
  buildStreamCopyArgs,
  canUseStreamCopy,
  expectedOutputDuration,
} from '../src/main/media-plan';

const metadata: VideoMetadata = {
  path: 'D:\\input (测试)\\match[1].mp4',
  duration_seconds: 30,
  width: 1280,
  height: 720,
  fps: 30,
  nominal_fps: 30,
  variable_frame_rate: false,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  frame_count: 900,
  average_bitrate: 1_000_000,
  audio_bitrate: 192_000,
  pixel_format: 'yuv420p',
  audio_sample_rate: 48_000,
  audio_channels: 2,
  video_duration_seconds: 30,
  audio_duration_seconds: 30,
  video_start_time_seconds: 0,
  audio_start_time_seconds: 0,
  video_time_base: '1/16000',
  audio_time_base: '1/48000',
  rotation: 0,
  sample_aspect_ratio: '1:1',
  display_aspect_ratio: '16:9',
  color_range: 'tv',
  color_space: 'bt709',
  color_transfer: 'bt709',
  color_primaries: 'bt709',
};

const oneGroup: CutGroup = {
  rallyIds: ['rally_001'],
  rawStart: 10,
  rawEnd: 12,
  start: 8,
  end: 14,
};

describe('media export planning', () => {
  it('keeps every path as its own argument and never forces CFR', () => {
    const output = 'D:\\output folder\\match_ttcut.partial.mp4';
    const args = buildReencodeArgs(metadata.path, output, [oneGroup], metadata);
    expect(args).toContain(metadata.path);
    expect(args).toContain(output);
    expect(args).toContain('libopenh264');
    expect(args).toContain('aac');
    expect(args[args.indexOf('-b:v') + 1]).toBe('2000000');
    expect(args).toContain('vfr');
    expect(args).not.toContain('-r');
    expect(args.join(' ')).toContain('setsar=sar=1/1');
  });

  it('builds a single concat graph for multiple groups', () => {
    const second = { ...oneGroup, rallyIds: ['rally_002'], rawStart: 20, rawEnd: 22, start: 19, end: 24 };
    const args = buildReencodeArgs(metadata.path, 'out.mp4', [oneGroup, second], metadata);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('split=2');
    expect(filter).toContain('asplit=2');
    expect(filter).toContain('concat=n=2:v=1:a=1');
    expect(expectedOutputDuration([oneGroup, second])).toBe(11);
  });

  it('uses stream copy only for stable, packet-aligned single groups', () => {
    expect(canUseStreamCopy([oneGroup], [0, 8, 14], [0, 8, 14], metadata)).toBe(true);
    expect(canUseStreamCopy([oneGroup, { ...oneGroup, start: 20, end: 22 }], [8, 14, 20, 22], [8, 14, 20, 22], metadata)).toBe(false);
    expect(canUseStreamCopy([oneGroup], [0, 8, 14], [], metadata)).toBe(false);
    expect(canUseStreamCopy([oneGroup], [0, 8, 14], [0, 8, 14], { ...metadata, variable_frame_rate: true })).toBe(false);
  });

  it('keeps accurate copy boundaries and optional audio mapping', () => {
    const args = buildStreamCopyArgs(metadata.path, 'out.mp4', oneGroup);
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual(['-ss', '8.000000', '-to', '14.000000']);
    expect(args).toContain('0:a?');
    expect(args).toContain('copy');
  });
});
