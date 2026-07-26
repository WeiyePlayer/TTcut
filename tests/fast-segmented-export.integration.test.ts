import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';
import type { MediaEncoder } from '../src/main/components';
import {
  buildConcatArgs,
  buildConcatManifest,
  buildSegmentReencodeArgs,
  expectedOutputDuration,
  selectSeekStart,
} from '../src/main/media-plan';

const input = process.env.TTCUT_VIDEO_INTEGRATION;
const cases = [
  {
    encoder: 'libopenh264' as const,
    ffmpeg: process.env.TTCUT_OPENH264_FFMPEG_INTEGRATION,
    ffprobe: process.env.TTCUT_OPENH264_FFPROBE_INTEGRATION,
  },
  {
    encoder: 'libx264' as const,
    ffmpeg: process.env.TTCUT_X264_FFMPEG_INTEGRATION,
    ffprobe: process.env.TTCUT_X264_FFPROBE_INTEGRATION,
  },
];

const groups: CutGroup[] = [
  { rallyIds: ['rally_001'], rawStart: 8, rawEnd: 10, start: 6.108, end: 10.108 },
  { rallyIds: ['rally_002'], rawStart: 32, rawEnd: 35, start: 29.565, end: 34.565 },
];

function run(executable: string, args: string[], timeout = 120_000): string {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout,
  });
  if (result.status !== 0) throw new Error(result.stderr || `Process exited with ${result.status}`);
  return result.stdout;
}

function probe(ffprobe: string, file: string): {
  format: { duration: string };
  streams: Array<Record<string, unknown>>;
} {
  return JSON.parse(run(ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-show_data_hash', 'sha256', '-of', 'json', file,
  ])) as {
    format: { duration: string };
    streams: Array<Record<string, unknown>>;
  };
}

function sourceMetadata(inputPath: string, data: ReturnType<typeof probe>): VideoMetadata {
  const video = data.streams.find((stream) => stream.codec_type === 'video')!;
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  const rational = (value: unknown) => {
    const [left, right] = String(value).split('/').map(Number);
    return right ? left! / right : 0;
  };
  return {
    path: inputPath,
    duration_seconds: Number(data.format.duration),
    width: Number(video.width),
    height: Number(video.height),
    fps: rational(video.avg_frame_rate),
    nominal_fps: rational(video.r_frame_rate),
    variable_frame_rate: false,
    video_codec: String(video.codec_name),
    audio_codec: audio ? String(audio.codec_name) : null,
    container: 'mp4',
    average_bitrate: Number(video.bit_rate) || null,
    audio_bitrate: audio ? Number(audio.bit_rate) || null : null,
    pixel_format: String(video.pix_fmt),
    audio_sample_rate: audio ? Number(audio.sample_rate) : null,
    audio_channels: audio ? Number(audio.channels) : null,
    video_time_base: String(video.time_base),
    audio_time_base: audio ? String(audio.time_base) : null,
    rotation: 0,
    sample_aspect_ratio: String(video.sample_aspect_ratio),
    color_range: String(video.color_range),
    color_space: String(video.color_space),
    color_transfer: String(video.color_transfer),
    color_primaries: String(video.color_primaries),
  };
}

describe.each(cases)('fast segmented export with $encoder', ({ encoder, ffmpeg, ffprobe }) => {
  const enabled = Boolean(input && ffmpeg && ffprobe);
  it.skipIf(!enabled)('exports distant segments with matching signatures and removes temporary files', () => {
    if (!input || !ffmpeg || !ffprobe) throw new Error('Integration environment is incomplete.');
    const directory = mkdtempSync(path.join(tmpdir(), `ttcut-${encoder}-`));
    try {
      const metadata = sourceMetadata(input, probe(ffprobe, input));
      const keyframeJson = JSON.parse(run(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
        '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input,
      ])) as { frames?: Array<{ best_effort_timestamp_time?: string }> };
      const keyframes = (keyframeJson.frames ?? []).map((frame) => Number(frame.best_effort_timestamp_time));
      const signatures: string[] = [];
      const names = groups.map((group, index) => {
        const name = `segment-${String(index + 1).padStart(6, '0')}.mp4`;
        const output = path.join(directory, name);
        run(ffmpeg, buildSegmentReencodeArgs(
          input,
          output,
          group,
          selectSeekStart(group.start, keyframes),
          metadata,
          encoder as MediaEncoder,
        ));
        const data = probe(ffprobe, output);
        const selected = data.streams.map((stream) => ({
          codec_name: stream.codec_name,
          profile: stream.profile,
          level: stream.level,
          pix_fmt: stream.pix_fmt,
          width: stream.width,
          height: stream.height,
          time_base: stream.time_base,
          extradata_hash: stream.extradata_hash,
          sample_rate: stream.sample_rate,
          channels: stream.channels,
          channel_layout: stream.channel_layout,
        }));
        signatures.push(JSON.stringify(selected));
        return name;
      });
      expect(new Set(signatures).size).toBe(1);

      const manifest = path.join(directory, 'segments.ffconcat');
      const output = path.join(directory, 'joined.mp4');
      writeFileSync(manifest, buildConcatManifest(names), 'utf8');
      expect(readFileSync(manifest).subarray(0, 3).toString('hex')).not.toBe('efbbbf');
      run(ffmpeg, buildConcatArgs(manifest, output));
      const joined = probe(ffprobe, output);
      const video = joined.streams.find((stream) => stream.codec_type === 'video');
      const audio = joined.streams.find((stream) => stream.codec_type === 'audio');
      expect(video?.codec_name).toBe('h264');
      expect(audio?.codec_name).toBe('aac');
      expect(video?.width).toBe(metadata.width);
      expect(video?.height).toBe(metadata.height);
      expect(Math.abs(Number(joined.format.duration) - expectedOutputDuration(groups))).toBeLessThanOrEqual(0.1);
      expect(Math.abs(Number(video?.duration) - Number(audio?.duration))).toBeLessThanOrEqual(0.1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      expect(() => readFileSync(directory)).toThrow();
    }
  }, 180_000);
});
