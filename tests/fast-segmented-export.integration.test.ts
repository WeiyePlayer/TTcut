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

function runWithStderr(
  executable: string,
  args: string[],
  timeout = 120_000,
): { stdout: string; stderr: string } {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', windowsHide: true, shell: false, timeout,
  });
  if (result.status !== 0) throw new Error(result.stderr || `Process exited with ${result.status}`);
  return { stdout: result.stdout, stderr: result.stderr };
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
  const optionalString = (value: unknown) => typeof value === 'string' ? value : null;
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
    pixel_format: optionalString(video.pix_fmt),
    audio_sample_rate: audio ? Number(audio.sample_rate) : null,
    audio_channels: audio ? Number(audio.channels) : null,
    video_time_base: optionalString(video.time_base),
    audio_time_base: audio ? optionalString(audio.time_base) : null,
    rotation: 0,
    sample_aspect_ratio: optionalString(video.sample_aspect_ratio),
    color_range: optionalString(video.color_range),
    color_space: optionalString(video.color_space),
    color_transfer: optionalString(video.color_transfer),
    color_primaries: optionalString(video.color_primaries),
  };
}

function probePacketTimes(
  ffprobe: string,
  file: string,
  stream: 'a:0' | 'v:0',
): Array<{ pts: number; dts: number }> {
  const data = JSON.parse(run(ffprobe, [
    '-v', 'error', '-select_streams', stream, '-show_packets',
    '-show_entries', 'packet=pts_time,dts_time', '-of', 'json', file,
  ])) as { packets?: Array<{ pts_time?: string; dts_time?: string }> };
  return (data.packets ?? []).map((packet) => ({
    pts: Number(packet.pts_time),
    dts: Number(packet.dts_time),
  })).filter((packet) => Number.isFinite(packet.pts) && Number.isFinite(packet.dts));
}

function expectMonotonic(values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]!).toBeGreaterThanOrEqual(values[index - 1]!);
  }
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
      run(ffmpeg, buildConcatArgs(manifest, output, metadata));
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

const syntheticFfmpeg = process.env.TTCUT_X264_FFMPEG_INTEGRATION;
const syntheticFfprobe = process.env.TTCUT_X264_FFPROBE_INTEGRATION;
const syntheticEnabled = Boolean(syntheticFfmpeg && syntheticFfprobe);

describe.skipIf(!syntheticEnabled)('fast segmented timestamp repair with generated media', () => {
  it('joins separately encoded 44.1 kHz AAC segments without DTS regressions', () => {
    if (!syntheticFfmpeg || !syntheticFfprobe) throw new Error('Integration environment is incomplete.');
    const directory = mkdtempSync(path.join(tmpdir(), 'ttcut-aac-timestamps-'));
    try {
      const source = path.join(directory, 'source.mp4');
      run(syntheticFfmpeg, [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60:duration=4',
        '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=44100:duration=4',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-g', '120', '-keyint_min', '120', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '1',
        '-shortest', source,
      ]);
      const metadata = sourceMetadata(source, probe(syntheticFfprobe, source));
      expect(metadata.audio_sample_rate).toBe(44_100);
      expect(metadata.audio_channels).toBe(1);

      const selectedGroups: CutGroup[] = [
        { rallyIds: ['rally_001'], rawStart: 0.2, rawEnd: 1.1, start: 0.137, end: 1.137 },
        { rallyIds: ['rally_002'], rawStart: 2, rawEnd: 3.1, start: 1.543, end: 2.743 },
      ];
      const keyframeData = JSON.parse(run(syntheticFfprobe, [
        '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
        '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', source,
      ])) as { frames?: Array<{ best_effort_timestamp_time?: string }> };
      const keyframes = (keyframeData.frames ?? [])
        .map((frame) => Number(frame.best_effort_timestamp_time))
        .filter(Number.isFinite);
      expect(selectedGroups.every(
        (group) => !keyframes.some((keyframe) => Math.abs(keyframe - group.start) < 0.000_001),
      )).toBe(true);

      const names = selectedGroups.map((group, index) => {
        const name = `segment-${String(index + 1).padStart(6, '0')}.mp4`;
        run(syntheticFfmpeg, buildSegmentReencodeArgs(
          source,
          path.join(directory, name),
          group,
          selectSeekStart(group.start, keyframes),
          metadata,
          'libx264',
        ));
        return name;
      });
      const manifest = path.join(directory, 'segments.ffconcat');
      const output = path.join(directory, 'joined.mp4');
      writeFileSync(manifest, buildConcatManifest(names), 'utf8');
      const concatArgs = buildConcatArgs(manifest, output, metadata);
      const concat = runWithStderr(
        syntheticFfmpeg,
        concatArgs,
      );
      expect(concat.stderr).not.toMatch(/Non-monotonic DTS/i);

      const joined = probe(syntheticFfprobe, output);
      const video = joined.streams.find((stream) => stream.codec_type === 'video');
      const audio = joined.streams.find((stream) => stream.codec_type === 'audio');
      expect(video?.codec_name).toBe('h264');
      expect(audio?.codec_name).toBe('aac');
      expect(audio?.sample_rate).toBe('44100');
      expect(audio?.channels).toBe(1);
      const startTolerance = Math.max(2 / metadata.fps, 1024 / 44_100) + 0.001;
      const startTimes = {
        video: Number(video?.start_time),
        audio: Number(audio?.start_time),
      };
      expect(Math.abs(startTimes.video), JSON.stringify(startTimes)).toBeLessThanOrEqual(startTolerance);
      expect(Math.abs(startTimes.audio), JSON.stringify(startTimes)).toBeLessThanOrEqual(startTolerance);
      expect(Math.abs(Number(joined.format.duration) - expectedOutputDuration(selectedGroups)))
        .toBeLessThanOrEqual(Math.max(0.1, 2 / metadata.fps, 1024 / 44_100));

      const audioPackets = probePacketTimes(syntheticFfprobe, output, 'a:0');
      expect(audioPackets.length).toBeGreaterThan(0);
      expectMonotonic(audioPackets.map((packet) => packet.dts));
      expectMonotonic(audioPackets.map((packet) => packet.pts));
      expect(audioPackets[0]!.dts).toBeGreaterThanOrEqual(-(1024 / 44_100 + 0.001));
      expect(Math.abs(Number(video?.duration) - Number(audio?.duration))).toBeLessThanOrEqual(0.1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('exports a single non-keyframe segment and keeps AAC timestamps bounded', () => {
    if (!syntheticFfmpeg || !syntheticFfprobe) throw new Error('Integration environment is incomplete.');
    const directory = mkdtempSync(path.join(tmpdir(), 'ttcut-single-segment-'));
    try {
      const source = path.join(directory, 'source.mp4');
      run(syntheticFfmpeg, [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', source,
      ]);
      const metadata = sourceMetadata(source, probe(syntheticFfprobe, source));
      const group: CutGroup = {
        rallyIds: ['rally_001'], rawStart: 0.5, rawEnd: 1.8, start: 0.317, end: 2.117,
      };
      const output = path.join(directory, 'single.mp4');
      run(syntheticFfmpeg, buildSegmentReencodeArgs(
        source,
        output,
        group,
        0,
        metadata,
        'libx264',
      ));
      const result = probe(syntheticFfprobe, output);
      expect(Math.abs(Number(result.format.duration) - (group.end - group.start))).toBeLessThanOrEqual(0.1);
      const audioPackets = probePacketTimes(syntheticFfprobe, output, 'a:0');
      expectMonotonic(audioPackets.map((packet) => packet.dts));
      expectMonotonic(audioPackets.map((packet) => packet.pts));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('joins silent segments without adding or expecting an audio stream', () => {
    if (!syntheticFfmpeg || !syntheticFfprobe) throw new Error('Integration environment is incomplete.');
    const directory = mkdtempSync(path.join(tmpdir(), 'ttcut-silent-segments-'));
    try {
      const source = path.join(directory, 'source.mp4');
      run(syntheticFfmpeg, [
        '-hide_banner', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=3',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-an', source,
      ]);
      const metadata = sourceMetadata(source, probe(syntheticFfprobe, source));
      expect(metadata.audio_codec).toBeNull();
      const selectedGroups: CutGroup[] = [
        { rallyIds: ['rally_001'], rawStart: 0.2, rawEnd: 0.9, start: 0.137, end: 1.137 },
        { rallyIds: ['rally_002'], rawStart: 1.5, rawEnd: 2.2, start: 1.317, end: 2.317 },
      ];
      const names = selectedGroups.map((group, index) => {
        const name = `segment-${index + 1}.mp4`;
        run(syntheticFfmpeg, buildSegmentReencodeArgs(
          source,
          path.join(directory, name),
          group,
          0,
          metadata,
          'libx264',
        ));
        return name;
      });
      const manifest = path.join(directory, 'segments.ffconcat');
      const output = path.join(directory, 'joined.mp4');
      writeFileSync(manifest, buildConcatManifest(names), 'utf8');
      const concat = runWithStderr(
        syntheticFfmpeg,
        buildConcatArgs(manifest, output, metadata),
      );
      expect(concat.stderr).not.toMatch(/Non-monotonic DTS/i);
      const joined = probe(syntheticFfprobe, output);
      expect(joined.streams.some((stream) => stream.codec_type === 'audio')).toBe(false);
      expect(Math.abs(Number(joined.format.duration) - expectedOutputDuration(selectedGroups)))
        .toBeLessThanOrEqual(0.1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
