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
  buildReencodeArgs,
  buildSegmentReencodeArgs,
  expectedOutputDuration,
  selectSeekStart,
} from '../src/main/media-plan';
import { assessExportDuration } from '../src/domain/export-duration';

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
const syntheticFfmpeg = process.env.TTCUT_X264_FFMPEG_INTEGRATION;
const syntheticFfprobe = process.env.TTCUT_X264_FFPROBE_INTEGRATION;
const syntheticEnabled = Boolean(syntheticFfmpeg && syntheticFfprobe);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

const groups: CutGroup[] = [
  { rallyIds: ['rally_001'], rawStart: 8, rawEnd: 10, start: 6.108, end: 10.108 },
  { rallyIds: ['rally_002'], rawStart: 32, rawEnd: 35, start: 29.565, end: 34.565 },
];

const concatAvSyncRegressionGroups: CutGroup[] = [
  { rallyIds: ['rally_001'], rawStart: 0.865, rawEnd: 9.506, start: 0.865, end: 9.506 },
  { rallyIds: ['rally_002'], rawStart: 18.095, rawEnd: 23.678, start: 18.095, end: 23.678 },
  { rallyIds: ['rally_003'], rawStart: 32.782, rawEnd: 37.697, start: 32.782, end: 37.697 },
  { rallyIds: ['rally_004'], rawStart: 45.5, rawEnd: 50.682, start: 45.5, end: 50.682 },
  { rallyIds: ['rally_005'], rawStart: 73.784, rawEnd: 85.593, start: 73.784, end: 85.593 },
  { rallyIds: ['rally_006'], rawStart: 94.416, rawEnd: 101.011, start: 94.416, end: 101.011 },
  { rallyIds: ['rally_007'], rawStart: 109.965, rawEnd: 115.014, start: 109.965, end: 115.014 },
  { rallyIds: ['rally_008'], rawStart: 143.659, rawEnd: 149.707, start: 143.659, end: 149.707 },
];

const concatEqualDtsRegressionGroups: CutGroup[] = [
  { rallyIds: ['rally_001'], rawStart: 2.365, rawEnd: 8.006, start: 0, end: 11.006 },
  { rallyIds: ['rally_002'], rawStart: 17.234, rawEnd: 21.464, start: 14.734, end: 24.464 },
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

function expectStrictlyIncreasing(values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]!).toBeGreaterThan(values[index - 1]!);
  }
}

function probeVideoPacketDurations(ffprobe: string, file: string): number[] {
  const data = JSON.parse(run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=duration_time', '-of', 'json', file,
  ])) as { packets?: Array<{ duration_time?: string }> };
  return (data.packets ?? [])
    .map((packet) => Number(packet.duration_time))
    .filter(Number.isFinite);
}

function streamDuration(data: ReturnType<typeof probe>, type: 'video' | 'audio'): number {
  return Number(data.streams.find((stream) => stream.codec_type === type)?.duration);
}

function timeBaseSeconds(value: unknown): number {
  const [numerator, denominator] = String(value).split('/').map(Number);
  return denominator ? numerator! / denominator : 0;
}

function createAbnormalFrameDurationSource(ffmpeg: string, output: string): void {
  run(ffmpeg, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-filter_complex',
    "[0:v]setpts='if(eq(N,0),0,PREV_OUTPTS+if(eq(mod(N,9),0),0.2665/TB,0.0001/TB))'[v]",
    '-map', '[v]', '-map', '1:a:0',
    '-fps_mode', 'vfr',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-shortest', output,
  ]);
}

function verifyVfr73IntervalExport(
  encoder: MediaEncoder,
  ffmpeg: string,
  ffprobe: string,
): void {
  const directory = mkdtempSync(path.join(tmpdir(), `ttcut-vfr-73-${encoder}-`));
  try {
    const source = path.join(directory, 'source-vfr.mp4');
    run(ffmpeg, [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60:duration=18',
      '-f', 'lavfi', '-i', 'sine=frequency=731:sample_rate=48000:duration=18',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', "select='not(eq(mod(n,10),0))'",
      '-fps_mode', 'vfr',
      '-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'ultrafast'] : []), '-g', '120',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-shortest', source,
    ]);
    const metadata = {
      ...sourceMetadata(source, probe(ffprobe, source)),
      variable_frame_rate: true,
    };
    expect(metadata.fps).toBeLessThan(metadata.nominal_fps ?? Number.POSITIVE_INFINITY);

    const selectedGroups: CutGroup[] = Array.from({ length: 73 }, (_, index) => {
      const start = 0.137 + index * 0.235;
      const end = start + 0.123;
      return {
        rallyIds: [`rally_${String(index + 1).padStart(3, '0')}`],
        rawStart: start,
        rawEnd: end,
        start,
        end,
      };
    });
    const targetSeconds = expectedOutputDuration(selectedGroups);
    const output = path.join(directory, 'joined-vfr.mp4');
    run(
      ffmpeg,
      buildReencodeArgs(source, output, selectedGroups, metadata, encoder),
      180_000,
    );

    const joined = probe(ffprobe, output);
    const video = joined.streams.find((stream) => stream.codec_type === 'video');
    const audio = joined.streams.find((stream) => stream.codec_type === 'audio');
    const assessment = assessExportDuration(
      Number(joined.format.duration),
      targetSeconds,
      selectedGroups.length,
      metadata,
    );
    expect(assessment.withinTolerance, JSON.stringify(assessment)).toBe(true);
    expect(video?.codec_name).toBe('h264');
    expect(audio?.codec_name).toBe('aac');
    expect(Math.abs(Number(video?.duration) - Number(audio?.duration))).toBeLessThanOrEqual(0.1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

  it.skipIf(!enabled)('keeps eight separately encoded AAC segments synchronized after concat', () => {
    if (!input || !ffmpeg || !ffprobe) throw new Error('Integration environment is incomplete.');
    const directory = mkdtempSync(path.join(tmpdir(), `ttcut-concat-av-sync-${encoder}-`));
    try {
      const metadata = {
        ...sourceMetadata(input, probe(ffprobe, input)),
        variable_frame_rate: true,
      };
      const keyframeJson = JSON.parse(run(ffprobe, [
        '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
        '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input,
      ])) as { frames?: Array<{ best_effort_timestamp_time?: string }> };
      const keyframes = (keyframeJson.frames ?? [])
        .map((frame) => Number(frame.best_effort_timestamp_time))
        .filter(Number.isFinite);
      const segmentDurations: number[] = [];
      let segmentVideoTimeBase = 0;
      const names = concatAvSyncRegressionGroups.map((group, index) => {
        const name = `segment-${String(index + 1).padStart(6, '0')}.mp4`;
        const segmentPath = path.join(directory, name);
        run(ffmpeg, buildSegmentReencodeArgs(
          input,
          segmentPath,
          group,
          selectSeekStart(group.start, keyframes),
          metadata,
          encoder,
        ));
        const segment = probe(ffprobe, segmentPath);
        segmentDurations.push(Number(segment.format.duration));
        segmentVideoTimeBase ||= timeBaseSeconds(
          segment.streams.find((stream) => stream.codec_type === 'video')?.time_base,
        );
        return name;
      });
      const manifest = path.join(directory, 'segments.ffconcat');
      writeFileSync(
        manifest,
        buildConcatManifest(names, segmentDurations, Math.max(segmentVideoTimeBase, 0.000_001)),
        'utf8',
      );

      const fixedOutput = path.join(directory, 'joined-fixed.mp4');
      const fixedArgs = buildConcatArgs(manifest, fixedOutput, metadata);
      const legacyOutput = path.join(directory, 'joined-legacy.mp4');
      const legacyArgs = fixedArgs
        .filter((argument) => argument !== '-shortest')
        .map((argument) => argument === 'aresample=async=1:first_pts=0,apad'
          ? 'aresample=async=1:first_pts=0'
          : argument);
      legacyArgs[legacyArgs.length - 1] = legacyOutput;
      run(ffmpeg, legacyArgs);
      const legacy = probe(ffprobe, legacyOutput);
      const legacyAvDelta = Math.abs(
        streamDuration(legacy, 'video') - streamDuration(legacy, 'audio'),
      );
      if (encoder === 'libopenh264') expect(legacyAvDelta).toBeGreaterThan(0.1);

      const concat = runWithStderr(ffmpeg, fixedArgs);
      expect(concat.stderr).not.toMatch(/Non-monotonic DTS/i);
      const fixed = probe(ffprobe, fixedOutput);
      expect(Math.abs(Number(fixed.format.duration) - 53.822)).toBeLessThanOrEqual(0.1);
      const fixedAvDelta = Math.abs(
        streamDuration(fixed, 'video') - streamDuration(fixed, 'audio'),
      );
      expect(fixedAvDelta).toBeLessThanOrEqual(0.1);
      expect(fixedAvDelta).toBeLessThan(legacyAvDelta);
      const audioPackets = probePacketTimes(ffprobe, fixedOutput, 'a:0');
      expectMonotonic(audioPackets.map((packet) => packet.dts));
      expectMonotonic(audioPackets.map((packet) => packet.pts));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);

  it.skipIf(!enabled || encoder !== 'libx264')(
    'guards equal x264 decode timestamps at concat boundaries',
    () => {
      if (!input || !ffmpeg || !ffprobe) throw new Error('Integration environment is incomplete.');
      const directory = mkdtempSync(path.join(tmpdir(), 'ttcut-concat-equal-dts-libx264-'));
      try {
        const metadata = {
          ...sourceMetadata(input, probe(ffprobe, input)),
          variable_frame_rate: true,
        };
        const keyframeJson = JSON.parse(run(ffprobe, [
          '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
          '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', input,
        ])) as { frames?: Array<{ best_effort_timestamp_time?: string }> };
        const keyframes = (keyframeJson.frames ?? [])
          .map((frame) => Number(frame.best_effort_timestamp_time))
          .filter(Number.isFinite);
        const segmentDurations: number[] = [];
        let segmentVideoTimeBase = 0;
        const names = concatEqualDtsRegressionGroups.map((group, index) => {
          const name = `segment-${String(index + 1).padStart(6, '0')}.mp4`;
          const segmentPath = path.join(directory, name);
          run(ffmpeg, buildSegmentReencodeArgs(
            input,
            segmentPath,
            group,
            selectSeekStart(group.start, keyframes),
            metadata,
            encoder,
          ));
          const segment = probe(ffprobe, segmentPath);
          segmentDurations.push(Number(segment.format.duration));
          segmentVideoTimeBase ||= timeBaseSeconds(
            segment.streams.find((stream) => stream.codec_type === 'video')?.time_base,
          );
          return name;
        });

        const legacyManifest = path.join(directory, 'legacy.ffconcat');
        writeFileSync(legacyManifest, buildConcatManifest(names), 'utf8');
        const legacyOutput = path.join(directory, 'legacy.mp4');
        const legacy = runWithStderr(
          ffmpeg,
          buildConcatArgs(legacyManifest, legacyOutput, metadata),
        );
        expect(legacy.stderr).toMatch(/Non-monotonic DTS/i);

        const fixedManifest = path.join(directory, 'fixed.ffconcat');
        writeFileSync(
          fixedManifest,
          buildConcatManifest(
            names,
            segmentDurations,
            Math.max(segmentVideoTimeBase, 0.000_001),
          ),
          'utf8',
        );
        const fixedOutput = path.join(directory, 'fixed.mp4');
        const fixed = runWithStderr(
          ffmpeg,
          buildConcatArgs(fixedManifest, fixedOutput, metadata),
        );
        expect(fixed.stderr).not.toMatch(/Non-monotonic DTS/i);
        const videoPackets = probePacketTimes(ffprobe, fixedOutput, 'v:0');
        expectStrictlyIncreasing(videoPackets.map((packet) => packet.dts));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.skipIf(!ffmpeg || !ffprobe)('exports 73 VFR AAC intervals within the dynamic duration budget', () => {
    if (!ffmpeg || !ffprobe) throw new Error('Integration environment is incomplete.');
    verifyVfr73IntervalExport(encoder, ffmpeg, ffprobe);
  }, 240_000);

  it.skipIf(!syntheticFfmpeg || !syntheticFfprobe || !ffmpeg || !ffprobe)(
    'clears abnormal frame durations before encoding',
    () => {
      if (!syntheticFfmpeg || !syntheticFfprobe || !ffmpeg || !ffprobe) {
        throw new Error('Integration environment is incomplete.');
      }
      const directory = mkdtempSync(path.join(tmpdir(), `ttcut-frame-duration-${encoder}-`));
      try {
        const source = path.join(directory, 'source-abnormal-duration.mp4');
        createAbnormalFrameDurationSource(syntheticFfmpeg, source);
        const sourceDurations = probeVideoPacketDurations(syntheticFfprobe, source);
        expect(Math.min(...sourceDurations)).toBeLessThanOrEqual(1 / 30 + 0.001);
        expect(Math.max(...sourceDurations)).toBeGreaterThanOrEqual(0.19);

        const metadata = {
          ...sourceMetadata(source, probe(syntheticFfprobe, source)),
          variable_frame_rate: true,
        };
        const group: CutGroup = {
          rallyIds: ['rally_001'], rawStart: 0, rawEnd: 0.3, start: 0, end: 0.3,
        };
        const fixedOutput = path.join(directory, 'fixed.mp4');
        const fixedArgs = buildSegmentReencodeArgs(
          source,
          fixedOutput,
          group,
          0,
          metadata,
          encoder,
        );
        const filterIndex = fixedArgs.indexOf('-filter_complex') + 1;
        expect(fixedArgs[filterIndex]).toContain('setpts=PTS-STARTPTS:strip_fps=1');

        const legacyOutput = path.join(directory, 'legacy.mp4');
        const legacyArgs = [...fixedArgs];
        legacyArgs[filterIndex] = legacyArgs[filterIndex]!.replace(':strip_fps=1', '');
        legacyArgs[legacyArgs.length - 1] = legacyOutput;
        run(ffmpeg, legacyArgs);
        const legacy = probe(ffprobe, legacyOutput);
        expect(Math.abs(streamDuration(legacy, 'video') - streamDuration(legacy, 'audio')))
          .toBeGreaterThan(0.1);

        run(ffmpeg, fixedArgs);
        const fixed = probe(ffprobe, fixedOutput);
        const video = fixed.streams.find((stream) => stream.codec_type === 'video');
        const audio = fixed.streams.find((stream) => stream.codec_type === 'audio');
        expect(video?.codec_name).toBe('h264');
        expect(audio?.codec_name).toBe('aac');
        expect(video?.width).toBe(320);
        expect(video?.height).toBe(240);
        expect(Math.abs(Number(fixed.format.duration) - (group.end - group.start)))
          .toBeLessThanOrEqual(0.1);
        expect(Math.abs(streamDuration(fixed, 'video') - streamDuration(fixed, 'audio')))
          .toBeLessThanOrEqual(0.1);

        const videoPackets = probePacketTimes(ffprobe, fixedOutput, 'v:0');
        const audioPackets = probePacketTimes(ffprobe, fixedOutput, 'a:0');
        expectStrictlyIncreasing(videoPackets.map((packet) => packet.dts));
        expectStrictlyIncreasing(audioPackets.map((packet) => packet.dts));
        run(ffmpeg, [
          '-hide_banner', '-v', 'error', '-i', fixedOutput,
          '-map', '0:v:0', '-an', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', nullDevice,
        ]);
        run(ffmpeg, [
          '-hide_banner', '-v', 'error', '-i', fixedOutput,
          '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-f', 's16le', nullDevice,
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

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
      writeFileSync(
        manifest,
        buildConcatManifest(names, selectedGroups.map((group) => group.end - group.start)),
        'utf8',
      );
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
