import { describe, expect, it } from 'vitest';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';
import {
  buildConcatArgs,
  buildConcatManifest,
  buildReencodeArgs,
  buildSegmentReencodeArgs,
  buildStreamCopyArgs,
  canUseStreamCopy,
  expectedOutputDuration,
  selectSeekStart,
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
    expect(args).toContain('-autorotate');
    expect(args).not.toContain('-noautorotate');
    expect(args.slice(args.indexOf('-metadata:s:v:0'), args.indexOf('-metadata:s:v:0') + 2))
      .toEqual(['-metadata:s:v:0', 'rotate=0']);
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

  it('builds x264 veryfast CRF 18 arguments without the OpenH264 bitrate policy', () => {
    const args = buildReencodeArgs(metadata.path, 'x264.mp4', [oneGroup], metadata, 'libx264');
    expect(args).toContain('libx264');
    expect(args).toContain('veryfast');
    expect(args).toContain('18');
    expect(args).not.toContain('libopenh264');
    expect(args).not.toContain('-b:v');
    expect(args).not.toContain('-profile:v');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
  });

  it('keeps supported source pixel formats for x264 and falls back for unknown formats', () => {
    const tenBit = buildReencodeArgs(metadata.path, 'x264-10bit.mp4', [oneGroup], { ...metadata, pixel_format: 'yuv420p10le' }, 'libx264');
    expect(tenBit[tenBit.indexOf('-pix_fmt') + 1]).toBe('yuv420p10le');
    const unknown = buildReencodeArgs(metadata.path, 'x264-unknown.mp4', [oneGroup], { ...metadata, pixel_format: 'gbrp' }, 'libx264');
    expect(unknown[unknown.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
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

  it.each(['libopenh264', 'libx264'] as const)(
    'builds a keyframe-seeked, precisely trimmed segment for %s',
    (encoder) => {
      const args = buildSegmentReencodeArgs(
        metadata.path,
        'segment-000001.mp4',
        oneGroup,
        5,
        metadata,
        encoder,
      );
      expect(args.slice(0, args.indexOf('-i') + 2)).toEqual([
        '-hide_banner', '-y', '-autorotate',
        '-ss', '5.000000', '-t', '9.000000', '-i', metadata.path,
      ]);
      const filter = args[args.indexOf('-filter_complex') + 1];
      expect(filter).toContain('trim=start=3.000000:end=9.000000');
      expect(filter).toContain('atrim=start=3.000000:end=9.000000');
      expect(args).toContain(encoder);
    },
  );

  it('selects the nearest keyframe no later than the segment start', () => {
    expect(selectSeekStart(8, [0, 2.5, 7.75, 9])).toBe(7.75);
    expect(selectSeekStart(8, [9, 12])).toBe(0);
  });

  it('builds a safe relative ffconcat manifest and repairs AAC timestamps without re-encoding video', () => {
    const manifest = buildConcatManifest(['segment-000001.mp4', "nested/segment-'000002.mp4"]);
    expect(manifest).toBe(
      "ffconcat version 1.0\nfile 'segment-000001.mp4'\nfile 'nested/segment-'\\''000002.mp4'\n",
    );
    expect(manifest.charCodeAt(0)).not.toBe(0xfeff);

    const args = buildConcatArgs('segments.ffconcat', 'output.partial.mp4', {
      ...metadata,
      audio_sample_rate: 44_100,
      audio_channels: 1,
      audio_bitrate: 128_000,
    });
    expect(args).toEqual(expect.arrayContaining([
      '-f', 'concat', '-safe', '1', '-i', 'segments.ffconcat',
      '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128000', '-ar', '44100', '-ac', '1',
      '-af', 'aresample=async=1:first_pts=0',
      '-avoid_negative_ts', 'auto',
    ]));
    expect(args).not.toEqual(expect.arrayContaining(['-c', 'copy']));
  });

  it('does not add audio concat options for silent segments', () => {
    const args = buildConcatArgs('segments.ffconcat', 'silent.partial.mp4', {
      ...metadata,
      audio_codec: null,
      audio_sample_rate: null,
      audio_channels: null,
      audio_bitrate: null,
    });
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-avoid_negative_ts', 'auto']));
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('-b:a');
    expect(args).not.toContain('-ar');
    expect(args).not.toContain('-ac');
    expect(args).not.toContain('-af');
  });

  it('omits audio filters and encoding for silent segmented input', () => {
    const args = buildSegmentReencodeArgs(
      metadata.path,
      'silent.mp4',
      oneGroup,
      0,
      { ...metadata, audio_codec: null, audio_bitrate: null, audio_sample_rate: null, audio_channels: null },
      'libx264',
    );
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).not.toContain('atrim');
    expect(args).not.toContain('-c:a');
  });

  it('preserves VFR output mode for segmented encoding', () => {
    const args = buildSegmentReencodeArgs(
      metadata.path,
      'vfr.mp4',
      oneGroup,
      0,
      { ...metadata, variable_frame_rate: true },
      'libopenh264',
    );
    expect(args.slice(args.indexOf('-fps_mode'), args.indexOf('-fps_mode') + 2)).toEqual(['-fps_mode', 'vfr']);
    expect(args).not.toContain('-r');
  });
});
