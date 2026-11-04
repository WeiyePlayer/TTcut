// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', timings: [] as string[] }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => ({
  ffmpeg: process.env.TTCUT_FFMPEG_INTEGRATION, ffprobe: process.env.TTCUT_FFPROBE_INTEGRATION,
}) }));
vi.mock('../src/main/logger', () => ({ logLine: async (_area: string, _level: string, line: string) => { state.timings.push(line); } }));
import { disposePreviewFrames, extractPreviewFrame } from '../src/main/preview-frame';
import { runProcess } from '../src/main/processes';

const ffmpeg = process.env.TTCUT_FFMPEG_INTEGRATION;
const ffprobe = process.env.TTCUT_FFPROBE_INTEGRATION;
const platform = process.platform;

describe.skipIf(!ffmpeg || !ffprobe)('real FFmpeg calibration frames (host media tools, simulated Windows probe route)', () => {
  let source: string;
  beforeAll(async () => {
    // Exercise the actual FFmpeg/ffprobe implementation, not the macOS helper.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    state.root = await mkdtemp(path.join(tmpdir(), 'ttcut-frame-integration-'));
    const raw = path.join(state.root, 'prores.mov');
    source = path.join(state.root, 'prores-rotated.mov');
    await runProcess(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=red:s=1920x1080:r=30:d=1',
      '-f', 'lavfi', '-i', 'color=blue:s=1920x1080:r=30:d=1',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
      '-c:v', 'prores_ks', '-profile:v', '0', '-threads', '2', '-pix_fmt', 'yuv422p10le', raw], { timeoutMs: 30_000 });
    await runProcess(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-display_rotation:v:0', '90', '-i', raw, '-c', 'copy', source], { timeoutMs: 30_000 });
  }, 45_000);

  afterAll(async () => {
    await disposePreviewFrames();
    Object.defineProperty(process, 'platform', { value: platform });
    if (state.root) await rm(state.root, { recursive: true, force: true });
  });

  function inspect(file: string) {
    const result = spawnSync(ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file]);
    expect(result.status).toBe(0);
    const pixel = spawnSync(ffmpeg!, ['-v', 'error', '-i', file, '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
    expect(pixel.status).toBe(0);
    return { stream: JSON.parse(result.stdout.toString()).streams[0], pixel: [...pixel.stdout] };
  }

  it('extracts the selected red/blue frames with display rotation and bounded cache', async () => {
    const first = await extractPreviewFrame(source, 0);
    const red = inspect(first);
    expect(red.stream).toMatchObject({ codec_name: 'mjpeg', width: 405, height: 720 });
    expect(red.pixel[0]).toBeGreaterThan(220);
    expect(red.pixel[2]).toBeLessThan(30);
    const last = await extractPreviewFrame(source, 2);
    const blue = inspect(last);
    expect(blue.stream).toMatchObject({ codec_name: 'mjpeg', width: 405, height: 720 });
    expect(blue.pixel[0]).toBeLessThan(30);
    expect(blue.pixel[2]).toBeGreaterThan(220);
    expect(await readdir(path.dirname(last))).toEqual([path.basename(last)]);
    console.info('Host FFmpeg frame timings:', state.timings);
  }, 30_000);
});
