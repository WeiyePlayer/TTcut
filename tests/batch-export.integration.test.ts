// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../src/shared/api';
import type { HistoryRecordV1 } from '../src/shared/contracts';

const state = vi.hoisted(() => ({ records: new Map<string, HistoryRecordV1>(), events: [] as AppEvent[] }));
vi.mock('electron', () => ({ dialog: {} }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main/media-protocol', () => ({ registerMediaPath: (value: string) => value }));
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ open: async (id: string) => state.records.get(id) }) }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => ({
  ffmpeg: process.env.TTCUT_FFMPEG_INTEGRATION,
  ffprobe: process.env.TTCUT_FFPROBE_INTEGRATION,
  mediaEncoder: process.env.TTCUT_BATCH_ENCODER ?? 'libopenh264',
}) }));

import { startBatchExport } from '../src/main/batch-export';
import { cancelAllTasksAndWait, runProcess } from '../src/main/processes';
import { probeVideo } from '../src/main/probe';
import { createCutGroups } from '../src/domain/segments';

const ffmpeg = process.env.TTCUT_FFMPEG_INTEGRATION;
const enabled = Boolean(ffmpeg && process.env.TTCUT_FFPROBE_INTEGRATION);
const selection = { mode: 'all', pre_roll_seconds: 1.5, post_roll_seconds: 0.5 } as const;

describe.skipIf(!enabled)('real cross-video merged export', () => {
  let root: string;
  const ids = [1, 2, 3, 4].map((id) => `${id}1111111-1111-4111-8111-111111111111`);
  beforeAll(async () => {
    root = await mkdtemp(path.join(process.env.TTCUT_BATCH_TEST_ROOT ?? tmpdir(), 'ttcut-merged-media-'));
    const encoder = process.env.TTCUT_BATCH_ENCODER ?? 'libopenh264';
    const configs = [
      { name: 'red.mp4', color: 'red', size: '320x180', rate: '30000/1001', audio: true, vfr: false },
      { name: 'green.mp4', color: 'lime', size: '180x320', rate: '24', audio: false, vfr: false },
      { name: 'blue-raw.mp4', color: 'blue', size: '320x180', rate: '25', audio: false, vfr: false },
      { name: 'yellow.mp4', color: 'yellow', size: '256x144', rate: '30', audio: true, vfr: true },
    ];
    for (const [index, config] of configs.entries()) {
      let file = path.join(root, config.name);
      const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=${config.color}:s=${config.size}:r=${config.rate}:d=4`];
      if (config.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4');
      if (config.vfr) args.push('-vf', "select='not(mod(n,2))+not(mod(n,5))'", '-fps_mode', 'vfr');
      args.push('-c:v', encoder, '-b:v', '1000000', '-pix_fmt', 'yuv420p');
      if (config.audio) args.push('-c:a', 'aac');
      args.push(file);
      await runProcess(ffmpeg!, args);
      if (index === 2) {
        const rotated = path.join(root, 'blue-rotated.mp4');
        await runProcess(ffmpeg!, ['-hide_banner', '-y', '-display_rotation:v:0', '90', '-i', file, '-c', 'copy', rotated]);
        file = rotated;
      }
      const video = await probeVideo(file);
      state.records.set(ids[index]!, {
        id: ids[index]!, source: { path: file, name: path.basename(file), size: 1, modified_time_ms: 1 },
        analysis: { schema_version: 1, video, rallies: [{
          id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 2, end_time_seconds: 2.2,
        }] },
      } as HistoryRecordV1);
    }
  }, 60_000);

  afterAll(async () => {
    await cancelAllTasksAndWait();
    if (root && !process.env.TTCUT_BATCH_TEST_ROOT) await rm(root, { recursive: true, force: true });
  });

  function pixel(file: string, seconds: number, x = 160, y = 90): number[] {
    const result = spawnSync(ffmpeg!, ['-v', 'error', '-ss', String(seconds), '-i', file,
      '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1,format=rgb24`, '-f', 'rawvideo', '-'], { windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return [...result.stdout];
  }

  it('preserves clip order and duration with mixed frame rates, VFR, rotation and silent sources', async () => {
    expect(state.records.get(ids[3]!)!.analysis.video.variable_frame_rate).toBe(true);
    expect(state.records.get(ids[2]!)!.analysis.video).toMatchObject({ width: 180, height: 320 });
    const windowStub = { isDestroyed: () => false, webContents: {
      send: (_channel: string, event: AppEvent) => { state.events.push(event); },
    } } as unknown as BrowserWindow;
    await startBatchExport(windowStub, { items: ids.map((analysis_id) => ({ analysis_id, selection })) });
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'batch-export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    const terminal = state.events.find((event) => event.type === 'batch-export-result' || event.type === 'error')!;
    if (terminal.type !== 'batch-export-result') throw new Error(JSON.stringify(terminal));
    const metadata = await probeVideo(terminal.data.outputPath);
    const durations = ids.map((id) => createCutGroups(state.records.get(id)!.analysis, selection)
      .reduce((sum, group) => sum + group.end - group.start, 0));
    expect(metadata).toMatchObject({ width: 320, height: 180, audio_codec: 'aac', audio_sample_rate: 48000, audio_channels: 2, video_codec: 'h264' });
    expect(metadata.fps).toBeCloseTo(30000 / 1001, 2);
    expect(Math.abs(metadata.duration_seconds - durations.reduce((sum, value) => sum + value, 0))).toBeLessThan(0.1);
    expect(Math.abs(metadata.video_duration_seconds! - metadata.audio_duration_seconds!)).toBeLessThan(0.1);
    const samples = [0, 1, 2, 3].map((index) => pixel(terminal.data.outputPath, durations.slice(0, index).reduce((sum, value) => sum + value, 0) + 1));
    expect(samples[0]![0]).toBeGreaterThan(220);
    expect(samples[0]![1]).toBeLessThan(30);
    expect(samples[1]![1]).toBeGreaterThan(180);
    expect(samples[1]![0]).toBeLessThan(40);
    expect(samples[1]![2]).toBeLessThan(40);
    expect(samples[2]![2]).toBeGreaterThan(220);
    expect(samples[3]![0]).toBeGreaterThan(220);
    expect(samples[3]![1]).toBeGreaterThan(220);
    expect(pixel(terminal.data.outputPath, durations[0]! + 1, 2, 90).every((value) => value < 20)).toBe(true);
    const silent = await runProcess(ffmpeg!, ['-hide_banner', '-ss', String(durations[0]! + 0.5), '-t', '1',
      '-i', terminal.data.outputPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const maximum = /max_volume: ([-\d.]+) dB/.exec(silent.stderr);
    expect(Number(maximum?.[1])).toBeLessThan(-60);
    expect((await readdir(root)).some((name) => name.startsWith('.ttcut-batch-'))).toBe(false);
    if (process.env.TTCUT_BATCH_TEST_ROOT) await writeFile(path.join(root, 'validation.json'), JSON.stringify({ metadata, durations, samples, terminal }, null, 2));
  }, 90_000);

  it.each([
    { sources: [1, 2], hasAudio: false, width: 180, height: 320, fps: 24 },
    { sources: [1, 3], hasAudio: true, width: 180, height: 320, fps: 24 },
    { sources: [3], hasAudio: true, width: 256, height: 144, fps: 30 },
  ])('exports $sources with the first source profile and hasAudio=$hasAudio', async ({ sources, hasAudio, width, height, fps }) => {
    const events: AppEvent[] = [];
    const windowStub = { isDestroyed: () => false, webContents: {
      send: (_channel: string, event: AppEvent) => { events.push(event); },
    } } as unknown as BrowserWindow;
    await startBatchExport(windowStub, { items: sources.map((index) => ({ analysis_id: ids[index], selection })) });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'batch-export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    const terminal = events.find((event) => event.type === 'batch-export-result' || event.type === 'error')!;
    if (terminal.type !== 'batch-export-result') throw new Error(JSON.stringify(terminal));
    const metadata = await probeVideo(terminal.data.outputPath);
    expect(metadata).toMatchObject({ width, height, audio_codec: hasAudio ? 'aac' : null });
    expect(metadata.fps).toBeCloseTo(fps, 2);
    expect(metadata.variable_frame_rate).toBe(false);
  }, 90_000);
});
