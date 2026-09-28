import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';
import { buildConcatArgs, buildConcatManifest, buildSegmentReencodeArgs } from '../src/main/media-plan';
import { createScoreboardPng, scoreboardDimensions } from '../src/main/scoreboard-image';

const ffmpeg = path.resolve('.runtime/windows/ffmpeg/ffmpeg.exe');

function run(args: string[]): Buffer {
  const result = spawnSync(ffmpeg, args, { windowsHide: true, timeout: 60_000, maxBuffer: 8_000_000 });
  if (result.status !== 0) throw new Error(result.stderr.toString() || `FFmpeg exited with ${result.status}`);
  return result.stdout;
}

it.skipIf(process.platform !== 'win32' || !existsSync(ffmpeg))('burns different scores into adjacent clips of one exported video', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ttcut-scoreboard-'));
  try {
    const source = path.join(directory, 'source.mp4');
    const first = path.join(directory, 'first.mp4');
    const second = path.join(directory, 'second.mp4');
    const output = path.join(directory, 'combined.mp4');
    run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    const metadata: VideoMetadata = {
      path: source, duration_seconds: 2, width: 640, height: 360, fps: 30, nominal_fps: 30,
      nominal_fps_ratio: '30/1', variable_frame_rate: false, video_codec: 'h264', audio_codec: null,
      container: 'mp4', frame_count: 60, average_bitrate: 100_000, audio_bitrate: null,
      pixel_format: 'yuv420p', audio_sample_rate: null, audio_channels: null,
      video_duration_seconds: 2, audio_duration_seconds: null, video_start_time_seconds: 0,
      audio_start_time_seconds: null, video_time_base: '1/15360', audio_time_base: null,
      rotation: 0, sample_aspect_ratio: '1:1', display_aspect_ratio: '16:9',
      color_range: null, color_space: null, color_transfer: null, color_primaries: null,
    };
    const groups: CutGroup[] = [
      { rallyIds: ['first'], rawStart: 0, rawEnd: 1, start: 0, end: 1 },
      { rallyIds: ['second'], rawStart: 1, rawEnd: 2, start: 1, end: 2 },
    ];
    const dimensions = scoreboardDimensions(metadata.width, metadata.height);
    const smallerDimensions = scoreboardDimensions(metadata.width, metadata.height, 0.7);
    const firstBoard = path.join(directory, 'first.png');
    const secondBoard = path.join(directory, 'second.png');
    writeFileSync(firstBoard, createScoreboardPng(dimensions.width, dimensions.height, { left: 1, right: 0 }));
    writeFileSync(secondBoard, createScoreboardPng(smallerDimensions.width, smallerDimensions.height, { left: 2, right: 0 }));
    run(buildSegmentReencodeArgs(source, first, groups[0]!, 0, metadata, 'libx264', { x: 0.78, y: 0.04, imagePath: firstBoard }));
    run(buildSegmentReencodeArgs(source, second, groups[1]!, 0, metadata, 'libx264', { x: 0.78, y: 0.04, scale: 0.7, imagePath: secondBoard }));
    const manifest = path.join(directory, 'segments.ffconcat');
    writeFileSync(manifest, buildConcatManifest(['first.mp4', 'second.mp4']));
    run(buildConcatArgs(manifest, output, metadata));
    const frame = (time: number) => run(['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-vf', 'crop=180:34:460:14', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
    const before = frame(0.5);
    const after = frame(1.5);
    expect(before.length).toBe(180 * 34);
    expect(after.length).toBe(before.length);
    expect(before.equals(after)).toBe(false);
    expect(before[12 * 180 + 12]).toBeLessThan(100);
    expect(after[12 * 180 + 12]).toBeGreaterThan(110);
    expect(readFileSync(output).length).toBeGreaterThan(1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
