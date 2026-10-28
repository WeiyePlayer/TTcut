// @vitest-environment node
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import type { Calibration } from '../src/shared/contracts';
import type { HistoryStore as Store } from '../src/main/history';

const state = vi.hoisted(() => ({ store: null as Store | null, ffprobe: '', unavailable: false }));
vi.mock('../src/main/history', async (original) => ({
  ...await original<typeof import('../src/main/history')>(), getHistoryStore: () => state.store!,
}));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => {
  if (state.unavailable) throw new Error('MEDIA_COMPONENT_MISSING');
  return { ffmpeg: process.env.TTCUT_FFMPEG_INTEGRATION!, ffprobe: state.ffprobe, mediaEncoder: 'libx264' };
} }));
vi.mock('../src/main/macos/runtime', () => ({
  macRuntimeRoot: () => process.env.TTCUT_MAC_MEDIA_RUNTIME!, verifyMacRuntime: async () => {},
}));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => os.tmpdir(), getPath: () => os.tmpdir() }, dialog: {} }));

import { HistoryStore } from '../src/main/history';
import { hasHdrFrameSideData, probeVideo } from '../src/main/probe';
import { runProcess, cancelTask } from '../src/main/processes';
import { startExport } from '../src/main/export';

const ffmpeg = process.env.TTCUT_FFMPEG_INTEGRATION;
const ffprobe = process.env.TTCUT_FFPROBE_INTEGRATION;
const actualPlatform = process.platform;

describe.skipIf(!ffmpeg || !ffprobe)('CFR content integrity through HistoryStore and XML export', () => {
  let root: string;
  let source: string;
  let packets: Array<{ stream_index: number; pos: string; size: string }>;
  const calibration: Calibration = { video_width: 160, video_height: 90,
    points: { top_left: [10, 10], top_right: [140, 10], bottom_right: [140, 80], bottom_left: [10, 80] } };
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-cfr-content-'));
    source = path.join(root, 'original.mp4');
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-shortest', source], { timeoutMs: 30_000 });
    packets = JSON.parse((await runProcess(ffprobe!, ['-v', 'error', '-show_packets',
      '-show_entries', 'packet=stream_index,pos,size', '-of', 'json', source])).stdout).packets;
  }, 60_000);
  afterAll(async () => {
    Object.defineProperty(process, 'platform', { value: actualPlatform });
    state.store = null;
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function makeHistory(platform: 'win32' | 'darwin', scenario: 'valid' | 'all-video' | 'partial-video' | 'audio' | 'unavailable') {
    Object.defineProperty(process, 'platform', { value: platform });
    state.ffprobe = ffprobe!;
    state.unavailable = false;
    const original = await probeVideo(source);
    const cache = path.join(root, `${platform}-${scenario}.mp4`);
    await copyFile(source, cache);
    if (scenario === 'all-video' || scenario === 'partial-video' || scenario === 'audio') {
      const bytes = await readFile(cache);
      for (const packet of packets.filter((entry) => entry.stream_index === (scenario === 'audio' ? 1 : 0)).slice(scenario === 'all-video' ? 0 : 30)) {
        const offset = Number(packet.pos);
        bytes.fill(0, offset, offset + Number(packet.size));
      }
      await writeFile(cache, bytes);
      const inspection = await runProcess(ffprobe!, ['-v', 'error', '-count_frames', '-select_streams', scenario === 'audio' ? 'a:0' : 'v:0',
        '-show_entries', 'stream=nb_read_frames', '-of', 'json', cache]);
      expect(inspection.stderr.length).toBeGreaterThan(0);
      if (scenario !== 'all-video') expect(Number(JSON.parse(inspection.stdout).streams[0].nb_read_frames)).toBeGreaterThan(0);
    }
    state.store = new HistoryStore(path.join(root, `history-${platform}-${scenario}`), async (_input, cover) => { await writeFile(cover, 'cover'); });
    const record = await state.store.upsert({ schema_version: 1, source_video: original,
      video: { ...original, path: cache, variable_frame_rate: false,
        ...(original.native_video ? { native_video: { ...original.native_video, path: cache } } : {}) },
      processing: { mode: 'normalized_cfr', target_fps_ratio: '30/1', encoder: 'libx264', warning_code: null },
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 2 }] }, calibration);
    return record;
  }

  it.each([
    ...(['valid', 'all-video', 'partial-video', 'audio', 'unavailable'] as const).map((scenario) => ['win32', scenario] as const),
    ...((actualPlatform === 'darwin' && process.env.TTCUT_MAC_MEDIA_RUNTIME)
      ? (['valid', 'all-video', 'partial-video', 'audio', 'unavailable'] as const).map((scenario) => ['darwin', scenario] as const) : []),
  ])('%s XML uses only complete and verifiable CFR content (%s)', async (platform, scenario) => {
    const record = await makeHistory(platform, scenario);
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    state.unavailable = scenario === 'unavailable';
    try {
      await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 30_000 });
    } finally { state.unavailable = false; }
    const terminal = events.filter((event) => event.type === 'export-result' || event.type === 'error');
    expect(terminal).toHaveLength(1);
    const result = terminal[0];
    if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
    const xml = await readFile(result.data.premiereXml!.outputPath, 'utf8');
    if (scenario === 'valid') {
      expect(xml).toContain('<name>original_TTcut_CFR.mp4</name>');
      expect(await readFile(path.join(result.data.outputDirectory, 'original_TTcut_CFR.mp4'))).toEqual(await readFile(source));
    } else {
      expect(xml).toContain('<name>original.mp4</name>');
      expect(xml).not.toContain('_TTcut_CFR.mp4');
    }
  }, 45_000);
  it.each([
    'win32', ...((actualPlatform === 'darwin' && process.env.TTCUT_MAC_MEDIA_RUNTIME) ? ['darwin'] : []),
  ] as Array<'win32' | 'darwin'>)('%s combined export uses the original after a damaged cache', async (platform) => {
    const record = await makeHistory(platform, 'partial-video');
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    await startExport(window, { analysis_id: record.id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
      outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 45_000 });
    const terminal = events.filter((event) => event.type === 'export-result' || event.type === 'error');
    expect(terminal).toHaveLength(1);
    const result = terminal[0];
    if (result?.type !== 'export-result' || result.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(result));
    await runProcess(ffmpeg!, ['-v', 'error', '-xerror', '-i', result.data.outputPath,
      '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeoutMs: 30_000 });
    const stored = JSON.parse(await readFile(path.join(root, `history-${platform}-partial-video`, 'records', `${record.id}.json`), 'utf8'));
    expect(stored.analysis.video.path).toBe(record.analysis.video.path);
    expect(stored.completion_kind).toBe('export');
  }, 60_000);

  it.skipIf(actualPlatform === 'win32')('cancels the full-content check without writing XML or falling back', async () => {
    const record = await makeHistory('win32', 'valid');
    const marker = path.join(root, 'scan-started');
    const wrapper = path.join(root, 'slow-ffprobe.sh');
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" -count_frames "*) touch ${shellQuote(marker)}; exec /bin/sleep 30;; esac\nexec ${shellQuote(ffprobe!)} "$@"\n`);
    await chmod(wrapper, 0o755);
    state.ffprobe = wrapper;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
    try {
      await vi.waitFor(async () => { await access(marker); }, { timeout: 10_000 });
      await cancelTask(taskId, 'user');
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true), { timeout: 10_000 });
      expect(events.filter((event) => event.type === 'export-result' || event.type === 'error')).toEqual([
        expect.objectContaining({ type: 'error', code: 'EXPORT_CANCELLED' }),
      ]);
    } finally { state.ffprobe = ffprobe!; }
  }, 30_000);

  it.skipIf(actualPlatform === 'win32')('bounds FFprobe diagnostics during the streaming HDR-frame scan', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const wrapper = path.join(root, 'noisy-ffprobe.sh');
    const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\nexec ${node} -e 'process.stderr.write("scan failed: " + "x".repeat(2000000), () => process.exit(7));'\n`);
    await chmod(wrapper, 0o755);
    state.ffprobe = wrapper;
    try {
      const failure = await hasHdrFrameSideData(source).then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({ name: 'ProcessExecutionError', exitCode: 7, stderr: expect.stringMatching(/^scan failed: /) });
      expect((failure as { stderr: string }).stderr).toHaveLength(16_384);
    } finally { state.ffprobe = ffprobe!; }
  });

});
