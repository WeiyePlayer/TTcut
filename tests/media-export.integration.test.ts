import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';
import { buildReencodeArgs, expectedOutputDuration } from '../src/main/media-plan';

const ffmpeg = process.env.TTCUT_FFMPEG_INTEGRATION;
const ffprobe = process.env.TTCUT_FFPROBE_INTEGRATION;
const input = process.env.TTCUT_VIDEO_INTEGRATION;
const output = process.env.TTCUT_OUTPUT_INTEGRATION;
const enabled = Boolean(ffmpeg && ffprobe && input && output);

const groups: CutGroup[] = [
  {
    rallyIds: ['rally_001'],
    rawStart: 8.608,
    rawEnd: 10.21,
    start: 6.108,
    end: 12.21,
  },
  {
    rallyIds: ['rally_003'],
    rawStart: 32.065,
    rawEnd: 37.937,
    start: 29.565,
    end: 39.937,
  },
];

const metadata: VideoMetadata = {
  path: input ?? 'missing.mp4',
  duration_seconds: 507.44,
  width: 1280,
  height: 720,
  fps: 633625 / 21142,
  nominal_fps: 30000 / 1001,
  variable_frame_rate: false,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  frame_count: 15207,
  average_bitrate: 787549,
  audio_bitrate: 218139,
  pixel_format: 'yuv420p',
  audio_sample_rate: 48000,
  audio_channels: 2,
  video_duration_seconds: 507.408,
  audio_duration_seconds: 507.405167,
  video_start_time_seconds: 0.032,
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

describe.skipIf(!enabled)('real FFmpeg export', () => {
  it('accurately exports two groups with previewable H.264/AAC and SSIM >= 0.95', () => {
    if (!ffmpeg || !ffprobe || !input || !output) throw new Error('Integration environment is incomplete.');
    expect(existsSync(input)).toBe(true);
    expect(existsSync(output)).toBe(false);

    const encode = spawnSync(ffmpeg, buildReencodeArgs(input, output, groups, metadata), {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 120_000,
    });
    if (encode.status !== 0) throw new Error(encode.stderr || `FFmpeg exited with ${encode.status}`);
    expect(existsSync(output)).toBe(true);

    const probe = spawnSync(ffprobe, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', output,
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
    if (probe.status !== 0) throw new Error(probe.stderr || `ffprobe exited with ${probe.status}`);
    const data = JSON.parse(probe.stdout) as {
      format: { duration: string };
      streams: Array<Record<string, unknown>>;
    };
    const video = data.streams.find((stream) => stream.codec_type === 'video');
    const audio = data.streams.find((stream) => stream.codec_type === 'audio');
    expect(video?.codec_name).toBe('h264');
    expect(audio?.codec_name).toBe('aac');
    expect(video?.width).toBe(1280);
    expect(video?.height).toBe(720);
    expect(video?.sample_aspect_ratio).toBe('1:1');
    expect(video?.color_space).toBe('bt709');
    expect(video?.color_transfer).toBe('bt709');
    expect(video?.color_primaries).toBe('bt709');
    expect(Math.abs(Number(data.format.duration) - expectedOutputDuration(groups))).toBeLessThanOrEqual(0.1);
    expect(Math.abs(Number(video?.duration) - Number(audio?.duration))).toBeLessThanOrEqual(0.1);

    const referenceInputs = groups.map((_, index) => `[v${index}]`).join('');
    const splitOutputs = groups.map((_, index) => `[src${index}]`).join('');
    const filters = [`[0:v:0]split=${groups.length}${splitOutputs}`];
    groups.forEach((group, index) => {
      filters.push(
        `[src${index}]trim=start=${group.start.toFixed(6)}:end=${group.end.toFixed(6)},`
        + `setpts=PTS-STARTPTS[v${index}]`,
      );
    });
    filters.push(`${referenceInputs}concat=n=${groups.length}:v=1:a=0[reference]`);
    filters.push('[1:v:0]setpts=PTS-STARTPTS[encoded]');
    filters.push('[reference][encoded]ssim=shortest=1');
    const quality = spawnSync(ffmpeg, [
      '-hide_banner', '-i', input, '-i', output,
      '-filter_complex', filters.join(';'), '-an', '-f', 'null', 'NUL',
    ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 120_000 });
    if (quality.status !== 0) throw new Error(quality.stderr || `SSIM check exited with ${quality.status}`);
    const match = /All:([0-9.]+)/.exec(quality.stderr);
    expect(match, quality.stderr).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(0.95);
  }, 180_000);
});
