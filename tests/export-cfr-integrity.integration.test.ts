// @vitest-environment node
import { access, chmod, copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import type { Calibration } from '../src/shared/contracts';
import type { HistoryStore as Store } from '../src/main/history';

const state = vi.hoisted(() => ({ store: null as Store | null, ffprobe: '', unavailable: false, denyCfrCopy: false, afterXml: null as (() => Promise<void>) | null, afterCfrCopy: null as (() => Promise<void>) | null }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, copyFile: (...args: Parameters<typeof real.copyFile>) => {
    if (state.denyCfrCopy && String(args[1]).includes('_TTcut_CFR.') && String(args[1]).endsWith('.partial.mp4')) {
      return Promise.reject(Object.assign(new Error('cache copy denied'), { code: 'EACCES' }));
    }
    return real.copyFile(...args).then(async () => {
      if (String(args[1]).includes('_TTcut_CFR.') && state.afterCfrCopy) {
        const action = state.afterCfrCopy; state.afterCfrCopy = null; await action();
      }
    });
  } };
});
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
vi.mock('../src/main/logger', () => ({ logLine: vi.fn(async (_task: string, _level: string, message: string) => {
  if (message.startsWith('Premiere XML written:') && state.afterXml) {
    const action = state.afterXml; state.afterXml = null; await action();
  }
}) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => os.tmpdir(), getPath: () => os.tmpdir() }, dialog: {} }));

import { HistoryStore } from '../src/main/history';
import { hasHdrFrameSideData, probeVideo } from '../src/main/probe';
import { activeTaskIds, runProcess, cancelTask } from '../src/main/processes';
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

  async function makeHistory(platform: 'win32' | 'darwin', scenario: 'valid' | 'all-video' | 'partial-video' | 'audio' | 'audio-lost' | 'unavailable', input = source) {
    Object.defineProperty(process, 'platform', { value: platform });
    state.ffprobe = ffprobe!;
    state.unavailable = false;
    const original = await probeVideo(input);
    const cache = path.join(root, `${platform}-${scenario}.mp4`);
    await copyFile(input, cache);
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
    if (scenario === 'audio-lost') {
      const bytes = await readFile(cache);
      const boxes = (start: number, end: number) => {
        const result: Array<{ start: number; end: number; type: string }> = [];
        for (let pos = start; pos + 8 <= end;) {
          const size = bytes.readUInt32BE(pos);
          if (size < 8 || pos + size > end) throw new Error('Invalid MP4 fixture box');
          result.push({ start: pos, end: pos + size, type: bytes.toString('ascii', pos + 4, pos + 8) });
          pos += size;
        }
        return result;
      };
      type Box = ReturnType<typeof boxes>[number];
      const child = (parent: Box, name: string): Box => {
        const found = boxes(parent.start + 8, parent.end).find((box) => box.type === name);
        if (!found) throw new Error(`Missing MP4 fixture box ${name}`);
        return found;
      };
      const moov = boxes(0, bytes.length).find((box) => box.type === 'moov')!;
      const audioTrack = boxes(moov.start + 8, moov.end).filter((box) => box.type === 'trak').find((trak) => {
        const handler = child(child(trak, 'mdia'), 'hdlr');
        return bytes.toString('ascii', handler.start + 16, handler.start + 20) === 'soun';
      })!;
      const stsz = child(child(child(child(audioTrack, 'mdia'), 'minf'), 'stbl'), 'stsz');
      const count = bytes.readUInt32BE(stsz.start + 16);
      expect(count).toBeGreaterThan(100);
      for (let index = 30; index < count; index++) bytes.writeUInt32BE(0, stsz.start + 20 + index * 4);
      await writeFile(cache, bytes);
      const inspection = await runProcess(ffprobe!, ['-v', 'error', '-count_frames', '-select_streams', 'a:0',
        '-show_entries', 'stream=nb_frames,nb_read_frames', '-of', 'json', cache]);
      expect(inspection.stderr).toBe('');
      expect(Number(JSON.parse(inspection.stdout).streams[0].nb_read_frames)).toBe(29);
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
    ...(['valid', 'all-video', 'partial-video', 'audio', 'audio-lost', 'unavailable'] as const).map((scenario) => ['win32', scenario] as const),
    ...((actualPlatform === 'darwin' && process.env.TTCUT_MAC_MEDIA_RUNTIME)
      ? (['valid', 'all-video', 'partial-video', 'audio', 'audio-lost', 'unavailable'] as const).map((scenario) => ['darwin', scenario] as const) : []),
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

  it.each([
    ...(['libmp3lame', 'alac'] as const).map((codec) => ['win32', codec] as const),
    ...((actualPlatform === 'darwin' && process.env.TTCUT_MAC_MEDIA_RUNTIME)
      ? (['libmp3lame', 'alac'] as const).map((codec) => ['darwin', codec] as const) : []),
  ])('%s accepts complete %s audio despite codec-specific frame sizes', async (platform, codec) => {
    const input = path.join(root, `${platform}-${codec}-original.mp4`);
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-i', source, '-c:v', 'copy', '-c:a', codec, input]);
    const record = await makeHistory(platform, 'valid', input);
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    await startExport(window, { analysis_id: record.id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 30_000 });
    const result = events.find((event) => event.type === 'export-result');
    if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(events));
    expect(await readFile(result.data.premiereXml!.outputPath, 'utf8')).toContain('_TTcut_CFR.mp4');
  }, 45_000);

  it.skipIf(actualPlatform === 'win32').each([
    'win32', ...((actualPlatform === 'darwin' && process.env.TTCUT_MAC_MEDIA_RUNTIME) ? ['darwin'] : []),
  ] as Array<'win32' | 'darwin'>)('%s checks unchanged CFR content once for XML and rally video', async (platform) => {
    const record = await makeHistory(platform, 'valid');
    const marker = path.join(root, `${platform}-cfr-scans.log`);
    const wrapper = path.join(root, `${platform}-count-ffprobe.sh`);
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" -count_frames "*) printf '%s\\n' "$*" >> ${shellQuote(marker)};; esac\nexec ${shellQuote(ffprobe!)} "$@"\n`);
    await chmod(wrapper, 0o755);
    state.ffprobe = wrapper;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: false, rally_videos: true, premiere_xml: true } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 30_000 });
      const result = events.find((event) => event.type === 'export-result');
      if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(events));
      expect(result.data.partialSuccess).toBe(false);
      expect(result.data.rallyVideos).toHaveLength(1);
      expect(result.data.premiereXml).not.toBeNull();
      const scans = (await readFile(marker, 'utf8')).trim().split('\n').filter((line) => line.includes(record.analysis.video.path));
      expect(scans).toHaveLength(2);
    } finally { state.ffprobe = ffprobe!; }
  }, 45_000);

  it.skipIf(actualPlatform === 'win32').each(['mutate', 'replace', 'during-copy', 'copy-failure'] as const)(
    'uses a safe video source when a validated CFR cache has %s', async (scenario) => {
      const record = await makeHistory('win32', 'valid');
      const cache = record.analysis.video.path;
      const marker = path.join(root, `cfr-${scenario}-scans.log`);
      const wrapper = path.join(root, `count-${scenario}-ffprobe.sh`);
      const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" -count_frames "*) printf '%s\\n' "$*" >> ${shellQuote(marker)};; esac\nexec ${shellQuote(ffprobe!)} "$@"\n`);
      await chmod(wrapper, 0o755);
      state.ffprobe = wrapper;
      state.denyCfrCopy = scenario === 'copy-failure';
      const corruptCache = async () => {
        const bytes = await readFile(cache);
        for (const packet of packets.filter((entry) => entry.stream_index === 0).slice(30)) {
          const offset = Number(packet.pos); bytes.fill(0, offset, offset + Number(packet.size));
        }
        if (scenario !== 'replace') await writeFile(cache, bytes);
        else { const replacement = `${cache}.replacement`; await writeFile(replacement, bytes); await rename(replacement, cache); }
      };
      if (scenario === 'during-copy') state.afterCfrCopy = corruptCache;
      else if (scenario !== 'copy-failure') state.afterXml = corruptCache;
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      try {
        await startExport(window, { analysis_id: record.id, destination: 'source',
          selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
          outputs: { combined_video: false, rally_videos: true, premiere_xml: true } });
        await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 30_000 });
        const terminal = events.filter((event) => event.type === 'export-result' || event.type === 'error');
        expect(terminal).toHaveLength(1);
        const result = terminal[0];
        if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
        expect(result.data.partialSuccess).toBe(false);
        expect(result.data.rallyVideos).toHaveLength(1);
        await runProcess(ffmpeg!, ['-v', 'error', '-xerror', '-i', result.data.rallyVideos[0]!.outputPath, '-f', 'null', '-'], { timeoutMs: 30_000 });
        const xml = await readFile(result.data.premiereXml!.outputPath, 'utf8');
        expect(xml.includes('<name>original_TTcut_CFR.mp4</name>')).toBe(scenario !== 'copy-failure' && scenario !== 'during-copy');
        const scans = (await readFile(marker, 'utf8')).trim().split('\n').filter((line) => line.includes(cache));
        expect(scans).toHaveLength(scenario === 'copy-failure' ? 2 : 3);
      } finally { state.ffprobe = ffprobe!; state.denyCfrCopy = false; state.afterXml = null; state.afterCfrCopy = null; }
    }, 45_000);

  it.skipIf(actualPlatform === 'win32')('returns the combined task and permits cancellation during CFR preparation', async () => {
    const record = await makeHistory('win32', 'valid');
    const marker = path.join(root, 'combined-scan-started');
    const wrapper = path.join(root, 'combined-slow-ffprobe.sh');
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" -count_frames "*) touch ${shellQuote(marker)}; exec /bin/sleep 30;; esac\nexec ${shellQuote(ffprobe!)} "$@"\n`);
    await chmod(wrapper, 0o755);
    state.ffprobe = wrapper;
    const existing = (await readdir(root)).sort();
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    const pending = startExport(window, { analysis_id: record.id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
      outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
    try {
      await vi.waitFor(async () => { await access(marker); }, { timeout: 10_000 });
      const taskId = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('startExport still pending')), 500))]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'progress', data: expect.objectContaining({ taskId, stage: 'preparing' }) }));
      await cancelTask(taskId, 'user');
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true), { timeout: 10_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
      ]);
      await rm(marker);
      expect((await readdir(root)).sort()).toEqual(existing);
    } finally {
      for (const task of activeTaskIds()) await cancelTask(task, 'user');
      await pending.catch(() => undefined);
      state.ffprobe = ffprobe!;
    }
  }, 30_000);

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
