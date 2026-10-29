// @vitest-environment node
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../src/shared/api';
import type { Calibration } from '../src/shared/contracts';
import type { HistoryStore as Store } from '../src/main/history';

const state = vi.hoisted(() => ({ store: null as Store | null, ffprobe: '', ffmpegOverride: '', unavailable: false, denyCfrCopy: false, preflightFault: '' as '' | 'space' | 'write', output: '', runtime: '', afterXml: null as (() => Promise<void>) | null, afterCfrCopy: null as (() => Promise<void>) | null, afterSegment: null as (() => Promise<void>) | null, afterXmlWrite: null as (() => Promise<void>) | null, injectRenameFailure: false, renameFailed: false, afterPublishRename: null as (() => Promise<void>) | null, afterRecoveryProbe: null as (() => Promise<void>) | null, afterRecoveryLog: null as (() => Promise<void>) | null, slowCopySource: '', slowCopyStream: null as (() => Readable) | null }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, rename: (...args: Parameters<typeof real.rename>) => {
    if (state.injectRenameFailure && String(args[0]).endsWith('.partial.mp4')) {
      state.injectRenameFailure = false; state.renameFailed = true;
      return Promise.reject(Object.assign(new Error('temporary rename failure'), { code: 'EACCES' }));
    }
    return real.rename(...args).then(async () => {
      if ((String(args[0]).endsWith('.partial.mp4') || String(args[0]).endsWith('.partial.xml'))
        && !String(args[0]).includes('_TTcut_CFR.') && state.afterPublishRename) {
        const action = state.afterPublishRename; state.afterPublishRename = null; await action();
      }
    });
  },
  writeFile: (...args: Parameters<typeof real.writeFile>) => real.writeFile(...args).then(async () => {
    if (String(args[0]).endsWith('.partial.xml') && state.afterXmlWrite) {
      const action = state.afterXmlWrite; state.afterXmlWrite = null; await action();
    }
  }),
  statfs: (...args: Parameters<typeof real.statfs>) => state.preflightFault === 'space'
    ? Promise.resolve({ bavail: 0n, bsize: 1n }) : real.statfs(...args),
  open: (...args: Parameters<typeof real.open>) => state.preflightFault === 'write' && String(args[0]).endsWith('.write-test')
    ? Promise.reject(Object.assign(new Error('write denied'), { code: 'EACCES' })) : real.open(...args),
  };
});
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return { ...real, createReadStream: (...args: Parameters<typeof real.createReadStream>) =>
    String(args[0]) === state.slowCopySource && state.slowCopyStream
      ? state.slowCopyStream() as unknown as ReturnType<typeof real.createReadStream> : real.createReadStream(...args) };
});
vi.mock('../src/main/export-copy', async (original) => {
  const real = await original<typeof import('../src/main/export-copy')>();
  return { ...real, copyExportCfr: async (...args: Parameters<typeof real.copyExportCfr>) => {
    if (state.denyCfrCopy) throw Object.assign(new Error('cache copy denied'), { code: 'EACCES' });
    await real.copyExportCfr(...args);
    if (state.afterCfrCopy) { const action = state.afterCfrCopy; state.afterCfrCopy = null; await action(); }
  } };
});
vi.mock('../src/main/history', async (original) => ({
  ...await original<typeof import('../src/main/history')>(), getHistoryStore: () => state.store!,
}));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => {
  if (state.unavailable) throw new Error('MEDIA_COMPONENT_MISSING');
  return { ffmpeg: state.ffmpegOverride || process.env.TTCUT_FFMPEG_INTEGRATION!, ffprobe: state.ffprobe, mediaEncoder: 'libx264' };
} }));
vi.mock('../src/main/probe', async (original) => {
  const real = await original<typeof import('../src/main/probe')>();
  return { ...real, probeVideo: async (...args: Parameters<typeof real.probeVideo>) => {
    const result = await real.probeVideo(...args);
    if (state.renameFailed && String(args[0]).endsWith('.partial.mp4') && state.afterRecoveryProbe) {
      const action = state.afterRecoveryProbe; state.afterRecoveryProbe = null; await action();
    }
    return result;
  } };
});
vi.mock('../src/main/macos/runtime', () => ({
  macRuntimeRoot: () => state.runtime || process.env.TTCUT_MAC_MEDIA_RUNTIME!, verifyMacRuntime: async () => {},
}));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn(async (_task: string, _level: string, message: string) => {
  if (message.startsWith('Premiere XML written:') && state.afterXml) {
    const action = state.afterXml; state.afterXml = null; await action();
  }
  if (message.startsWith('Retained usable output after') && state.afterRecoveryLog) {
    const action = state.afterRecoveryLog; state.afterRecoveryLog = null; await action();
  }
  if (message.startsWith('Rally segment 1 timing') && state.afterSegment) {
    const action = state.afterSegment; state.afterSegment = null; await action();
  }
}) }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => os.tmpdir(), getPath: () => os.tmpdir() }, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: state.output }) } }));

import { HistoryStore } from '../src/main/history';
import { hasCompleteCfrContent, hasHdrFrameSideData, probeVideo } from '../src/main/probe';
import { activeTaskIds, runProcess, cancelTask } from '../src/main/processes';
import { startExport } from '../src/main/export';

const ffmpeg = process.env.TTCUT_FFMPEG_INTEGRATION;
const ffprobe = process.env.TTCUT_FFPROBE_INTEGRATION;
const actualPlatform = process.platform;
const windowsCompiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');

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

  async function makeHistory(platform: 'win32' | 'darwin', scenario: 'valid' | 'all-video' | 'partial-video' | 'audio' | 'audio-lost' | 'audio-timing' | 'unavailable', input = source) {
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
    if (scenario === 'audio-lost' || scenario === 'audio-timing') {
      let bytes = await readFile(cache);
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
      const mdia = child(audioTrack, 'mdia');
      const minf = child(mdia, 'minf');
      const stbl = child(minf, 'stbl');
      if (scenario === 'audio-lost') {
        const stsz = child(stbl, 'stsz');
        const count = bytes.readUInt32BE(stsz.start + 16);
        expect(count).toBeGreaterThan(100);
        for (let index = 30; index < count; index++) bytes.writeUInt32BE(0, stsz.start + 20 + index * 4);
      } else {
        const stts = child(stbl, 'stts');
        const entryCount = bytes.readUInt32BE(stts.start + 12);
        const entries = Array.from({ length: entryCount }, (_, index) => ({
          count: bytes.readUInt32BE(stts.start + 16 + index * 8),
          duration: bytes.readUInt32BE(stts.start + 20 + index * 8),
        }));
        const totalSamples = entries.reduce((sum, entry) => sum + entry.count, 0);
        const totalDuration = entries.reduce((sum, entry) => sum + entry.count * entry.duration, 0);
        expect(totalSamples).toBeGreaterThan(100);
        const overlappingDuration = Math.floor(entries[0]!.duration / 2);
        const finalDuration = totalDuration - (totalSamples - 1) * overlappingDuration;
        expect(overlappingDuration).toBeGreaterThan(0);
        expect(finalDuration).toBeGreaterThan(overlappingDuration);
        if (entryCount === 1) {
          // Windows FFmpeg may use one stts entry; expand the trailing moov box
          // without shifting mdat offsets, then store the equivalent two entries.
          const mdat = boxes(0, bytes.length).find((box) => box.type === 'mdat')!;
          expect(mdat.end).toBeLessThanOrEqual(moov.start);
          bytes = Buffer.concat([bytes.subarray(0, stts.end), Buffer.alloc(8), bytes.subarray(stts.end)]);
          for (const box of [stts, stbl, minf, mdia, audioTrack, moov]) {
            bytes.writeUInt32BE(box.end - box.start + 8, box.start);
          }
        }
        bytes.writeUInt32BE(2, stts.start + 12);
        bytes.writeUInt32BE(totalSamples - 1, stts.start + 16);
        bytes.writeUInt32BE(overlappingDuration, stts.start + 20);
        bytes.writeUInt32BE(1, stts.start + 24);
        bytes.writeUInt32BE(finalDuration, stts.start + 28);
      }
      await writeFile(cache, bytes);
      const inspection = await runProcess(ffprobe!, ['-v', 'error', '-count_frames', '-select_streams', 'a:0',
        '-show_entries', 'stream=nb_frames,nb_read_frames', '-of', 'json', cache]);
      expect(inspection.stderr).toBe('');
      const frames = Number(JSON.parse(inspection.stdout).streams[0].nb_read_frames);
      if (scenario === 'audio-lost') expect(frames).toBe(29);
      else {
        expect(frames).toBeGreaterThan(180);
        const damaged = await probeVideo(cache);
        expect(damaged.audio_duration_seconds).toBeCloseTo(original.audio_duration_seconds!, 2);
        expect(await hasCompleteCfrContent(cache, true)).toBe(false);
      }
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
    ...(['valid', 'all-video', 'partial-video', 'audio', 'audio-lost', 'audio-timing', 'unavailable'] as const).map((scenario) => ['win32', scenario] as const),
    ...((actualPlatform === 'darwin' && process.env.TTCUT_MAC_MEDIA_RUNTIME)
      ? (['valid', 'all-video', 'partial-video', 'audio', 'audio-lost', 'audio-timing', 'unavailable'] as const).map((scenario) => ['darwin', scenario] as const) : []),
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

  it.each([['space', 'DISK_SPACE_LOW'], ['write', 'OUTPUT_DIRECTORY_UNWRITABLE']] as const)(
    'reports %s preflight failure without adopting an existing output', async (fault, code) => {
      const record = await makeHistory('win32', 'valid');
      const recordPath = path.join(root, 'history-win32-valid', 'records', `${record.id}.json`);
      const persistedBefore = await readFile(recordPath);
      const output = path.join(root, `existing-${fault}.mp4`);
      await copyFile(source, output);
      const outputBefore = await readFile(output);
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      state.output = output; state.preflightFault = fault;
      try {
        const taskId = await startExport(window, { analysis_id: record.id, destination: 'prompt',
          selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
          outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
        await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 30_000 });
        expect(events.filter((event) => event.type === 'export-result' || event.type === 'error')).toEqual([
          expect.objectContaining({ type: 'error', taskId, code }),
        ]);
        expect(await readFile(output)).toEqual(outputBefore);
        expect(await readFile(recordPath)).toEqual(persistedBefore);
      } finally { state.preflightFault = ''; state.output = ''; }
    }, 45_000);

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

  it.skipIf(actualPlatform !== 'win32' || !existsSync(windowsCompiler))('cancels a running Windows CFR probe without publishing an output', async () => {
    const record = await makeHistory('win32', 'valid');
    const marker = path.join(root, 'windows-probe-started');
    const helperSource = path.join(root, 'slow-probe.cs');
    const helper = path.join(root, 'slow-probe.exe');
    await writeFile(helperSource, [
      'using System; using System.IO; using System.Threading; using System.Diagnostics;',
      'class SlowProbe { static int Main() {',
      'File.WriteAllText(Environment.GetEnvironmentVariable("TTCUT_TEST_CFR_MARKER"), Process.GetCurrentProcess().Id.ToString());',
      'Thread.Sleep(30000); return 0; } }',
    ].join('\n'));
    execFileSync(windowsCompiler, ['/nologo', '/target:exe', `/out:${helper}`, helperSource], { windowsHide: true });
    state.ffprobe = helper;
    const oldMarker = process.env.TTCUT_TEST_CFR_MARKER;
    process.env.TTCUT_TEST_CFR_MARKER = marker;
    const existing = (await readdir(root)).sort();
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    const pending = startExport(window, { analysis_id: record.id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
      outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
    let helperPid = 0;
    try {
      await vi.waitFor(async () => { await access(marker); }, { timeout: 10_000 });
      helperPid = Number(await readFile(marker, 'utf8'));
      expect(helperPid).toBeGreaterThan(0);
      const taskId = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('startExport still pending')), 500))]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'progress', data: expect.objectContaining({ taskId, stage: 'preparing' }) }));
      await cancelTask(taskId, 'user');
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true), { timeout: 10_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
      ]);
      await vi.waitFor(() => {
        try { process.kill(helperPid, 0); throw new Error('Probe process is still running'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }, { timeout: 10_000 });
      helperPid = 0;
      await rm(marker);
      expect((await readdir(root)).sort()).toEqual(existing);
    } finally {
      for (const task of activeTaskIds()) await cancelTask(task, 'user');
      await pending.catch(() => undefined);
      if (helperPid) { try { process.kill(helperPid); } catch { /* helper already exited */ } }
      if (oldMarker === undefined) delete process.env.TTCUT_TEST_CFR_MARKER;
      else process.env.TTCUT_TEST_CFR_MARKER = oldMarker;
      state.ffprobe = ffprobe!;
    }
  }, 30_000);

  it.skipIf(actualPlatform !== 'darwin' || !process.env.TTCUT_MAC_MEDIA_RUNTIME)(
    'registers a macOS export before probing its CFR cache and cancels the native probe', async () => {
      const record = await makeHistory('darwin', 'valid');
      const runtime = path.join(root, 'slow-native-runtime');
      const worker = path.join(runtime, 'bin', 'TTcutMediaWorker');
      const marker = path.join(root, 'native-probe-pid');
      const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await mkdir(path.dirname(worker), { recursive: true });
      await writeFile(worker, `#!/bin/sh\necho $$ > ${shellQuote(marker)}\nexec /bin/sleep 30\n`);
      await chmod(worker, 0o755);
      state.runtime = runtime;
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
      } finally {
        state.runtime = '';
        const pid = Number(await readFile(marker, 'utf8').catch(() => '0'));
        if (pid > 0) { try { process.kill(-pid, 'SIGKILL'); } catch { /* probe already stopped */ } }
        for (const task of activeTaskIds()) await cancelTask(task, 'user');
        await pending.catch(() => undefined);
      }
    }, 30_000);

  it.skipIf(actualPlatform === 'win32').each(['xml', 'combined', 'both'] as const)(
    'rejects %s fallback if the verified original changes during cache validation', async (scenario) => {
      const input = path.join(root, `changing-${scenario}.mp4`);
      const replacement = path.join(root, `replacement-${scenario}.mp4`);
      await copyFile(source, input);
      await runProcess(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=30:d=4',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', replacement]);
      const record = await makeHistory('win32', 'partial-video', input);
      const marker = path.join(root, `source-scan-${scenario}`);
      const release = path.join(root, `source-release-${scenario}`);
      const wrapper = path.join(root, `source-ffprobe-${scenario}.sh`);
      const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" -count_frames "*) touch ${shellQuote(marker)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done;; esac\nexec ${shellQuote(ffprobe!)} "$@"\n`);
      await chmod(wrapper, 0o755); state.ffprobe = wrapper;
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      try {
        const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
          selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
          outputs: { combined_video: scenario === 'combined', rally_videos: scenario === 'both', premiere_xml: scenario !== 'combined' } });
        await vi.waitFor(async () => { await access(marker); }, { timeout: 10_000 });
        await copyFile(replacement, input); await writeFile(release, 'release');
        await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
        const terminal = events.filter((event) => event.type === 'error' || event.type === 'export-result');
        expect(terminal).toHaveLength(1);
        if (scenario === 'combined') expect(terminal[0]).toMatchObject({ type: 'error', taskId, code: 'HISTORY_SOURCE_CHANGED' });
        else expect(terminal[0]).toMatchObject({ type: 'error', taskId, artifacts: { xmlFailure: { code: 'HISTORY_SOURCE_CHANGED' },
          ...(scenario === 'both' ? { failedRallies: [{ code: 'HISTORY_SOURCE_CHANGED' }] } : {}) } });
      } finally { await writeFile(release, 'release').catch(() => undefined); state.ffprobe = ffprobe!; }
    }, 45_000);

  it('does not publish XML if its source changes while the XML is being written', async () => {
    const input = path.join(root, 'source-change-during-xml.mp4');
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    state.afterXmlWrite = async () => { await writeFile(input, 'source replaced during XML write'); };
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, artifacts: expect.objectContaining({ xmlFailure: expect.objectContaining({ code: 'HISTORY_SOURCE_CHANGED' }) }) }),
      ]);
      expect((await readdir(root)).some((name) => name.startsWith('source-change-during-xml_TTcut_'))).toBe(false);
    } finally { state.afterXmlWrite = null; }
  }, 45_000);

  it('retains published XML when the source changes before video preparation', async () => {
    const input = path.join(root, 'source-change-after-xml.mp4');
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    state.afterXml = async () => { await writeFile(input, 'source replaced after XML'); };
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: false, rally_videos: true, premiere_xml: true } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      const result = events.find((event) => event.type === 'export-result');
      if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(events));
      expect(result.data).toMatchObject({ partialSuccess: true, failedRallies: [{ code: 'HISTORY_SOURCE_CHANGED' }], rallyVideos: [] });
      expect(result.data.premiereXml).not.toBeNull();
      await expect(access(result.data.premiereXml!.outputPath)).resolves.toBeUndefined();
    } finally { state.afterXml = null; }
  }, 45_000);

  it('does not publish a segment when the source changes during rendering', async () => {
    const input = path.join(root, 'source-change-during-render.mp4');
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    state.afterSegment = async () => { await writeFile(input, 'source replaced during render'); };
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: false, rally_videos: true, premiere_xml: false } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, artifacts: expect.objectContaining({ failedRallies: [expect.objectContaining({ code: 'HISTORY_SOURCE_CHANGED' })] }) }),
      ]);
    } finally { state.afterSegment = null; }
  }, 45_000);

  it.skipIf(actualPlatform !== 'darwin' || !process.env.TTCUT_MAC_MEDIA_RUNTIME)(
    'keeps ordinary macOS history opening strict while export defers the cache probe', async () => {
      const record = await makeHistory('darwin', 'valid');
      await writeFile(record.analysis.video.path, 'not media');
      await expect(state.store!.open(record.id)).rejects.toThrow('HISTORY_PROCESSING_MEDIA_CORRUPT');
      await expect(state.store!.open(record.id, { purpose: 'export' })).resolves.toMatchObject({
        analysis: { video: { path: record.analysis.video.path }, processing: { mode: 'normalized_cfr' } },
      });
    });

  it.skipIf(actualPlatform === 'win32')('never retains a failed partial when its source changed during rendering', async () => {
    const input = path.join(root, 'source-change-failed-render.mp4');
    const replacement = path.join(root, 'replacement-failed-render.mp4');
    await copyFile(source, input);
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=30:d=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', replacement]);
    const record = await makeHistory('win32', 'valid', input);
    const wrapper = path.join(root, 'source-change-failed-render.sh');
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(wrapper, `#!/bin/sh\n${shellQuote(ffmpeg!)} "$@" || exit $?\ncp ${shellQuote(replacement)} ${shellQuote(input)}\nexit 1\n`);
    await chmod(wrapper, 0o755); state.ffmpegOverride = wrapper;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: 'HISTORY_SOURCE_CHANGED' }),
      ]);
      expect((await readdir(root)).some((name) => name.includes('source-change-failed-render_TTcut'))).toBe(false);
    } finally { state.ffmpegOverride = ''; }
  }, 45_000);

  it.each([['combined', 2], ['xml', 2], ['rallies', 3], ['both', 5]] as const)(
    'honors cancellation during final source validation for %s', async (scenario, lastCheck) => {
      const input = path.join(root, `cancel-final-${scenario}.mp4`);
      await copyFile(source, input);
      const record = await makeHistory('win32', 'valid', input);
      const storedBefore = await readFile(path.join(root, 'history-win32-valid', 'records', `${record.id}.json`));
      const originalCheck = state.store!.assertExportSource.bind(state.store!);
      let seen = 0; let mark!: () => void; let release!: () => void;
      const reached = new Promise<void>((resolve) => { mark = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      state.store!.assertExportSource = async (value) => { await originalCheck(value); if (++seen === lastCheck) { mark(); await gate; } };
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      try {
        const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
          selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
          outputs: { combined_video: scenario === 'combined', rally_videos: scenario === 'rallies' || scenario === 'both', premiere_xml: scenario === 'xml' || scenario === 'both' } });
        await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('final check not reached')), 10_000))]);
        await cancelTask(taskId, 'user'); release();
        await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
        expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
          expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
        ]);
        expect((await readdir(root)).some((name) => name.startsWith(`cancel-final-${scenario}_TTcut_`))).toBe(false);
        expect(await readFile(path.join(root, 'history-win32-valid', 'records', `${record.id}.json`))).toEqual(storedBefore);
      } finally { release(); }
    }, 45_000);

  it.each(['combined', 'xml', 'rallies'] as const)(
    'cleans %s output when cancellation arrives during the publishing rename', async (scenario) => {
      const input = path.join(root, `cancel-rename-${scenario}.mp4`);
      await copyFile(source, input);
      const record = await makeHistory('win32', 'valid', input);
      const recordPath = path.join(root, 'history-win32-valid', 'records', `${record.id}.json`);
      const storedBefore = await readFile(recordPath);
      let mark!: () => void; let release!: () => void;
      const reached = new Promise<void>((resolve) => { mark = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      state.afterPublishRename = async () => { mark(); await gate; };
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      try {
        const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
          selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
          outputs: { combined_video: scenario === 'combined', rally_videos: scenario === 'rallies', premiere_xml: scenario === 'xml' } });
        await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rename not reached')), 10_000))]);
        await cancelTask(taskId, 'user'); release();
        await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
        expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
          expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
        ]);
        expect((await readdir(root)).some((name) => name.startsWith(`cancel-rename-${scenario}_TTcut_`))).toBe(false);
        expect(await readFile(recordPath)).toEqual(storedBefore);
      } finally { release(); state.afterPublishRename = null; }
    }, 45_000);

  it('retains a committed combined export when cancellation arrives during history writing', async () => {
    const input = path.join(root, 'cancel-after-commit.mp4');
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    const originalMark = state.store!.markVisible.bind(state.store!);
    let mark!: () => void; let release!: () => void;
    const reached = new Promise<void>((resolve) => { mark = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.store!.markVisible = async (...args) => { mark(); await gate; return originalMark(...args); };
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
      await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('history write not reached')), 10_000))]);
      await cancelTask(taskId, 'user'); release();
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      const terminal = events.filter((event) => event.type === 'error' || event.type === 'export-result');
      expect(terminal).toHaveLength(1);
      const result = terminal[0];
      if (result?.type !== 'export-result' || result.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(result));
      await expect(access(result.data.outputPath)).resolves.toBeUndefined();
      const persisted = JSON.parse(await readFile(path.join(root, 'history-win32-valid', 'records', `${record.id}.json`), 'utf8'));
      expect(persisted.output_path).toBe(result.data.outputPath);
    } finally { release(); }
  }, 45_000);

  it('honors cancellation while validating a failed export for recovery', async () => {
    const input = path.join(root, 'cancel-recovery.mp4');
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    const recordPath = path.join(root, 'history-win32-valid', 'records', `${record.id}.json`);
    const storedBefore = await readFile(recordPath);
    let mark!: () => void; let release!: () => void;
    const reached = new Promise<void>((resolve) => { mark = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.injectRenameFailure = true; state.renameFailed = false;
    state.afterRecoveryProbe = async () => { mark(); await gate; };
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
      await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('recovery check not reached')), 10_000))]);
      await cancelTask(taskId, 'user'); release();
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
      ]);
      expect((await readdir(root)).some((name) => name.startsWith('cancel-recovery_TTcut_') || name.includes('cancel-recovery_TTcut_custom.') && name.endsWith('.partial.mp4'))).toBe(false);
      expect(await readFile(recordPath)).toEqual(storedBefore);
    } finally { release(); state.injectRenameFailure = false; state.renameFailed = false; state.afterRecoveryProbe = null; }
  }, 45_000);

  it.each(['source', 'cache'] as const)('does not retain a partial if %s changes during recovery probe', async (changed) => {
    const input = path.join(root, `recovery-${changed}-change.mp4`);
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    state.injectRenameFailure = true; state.renameFailed = false;
    state.afterRecoveryProbe = async () => { await writeFile(changed === 'source' ? input : record.analysis.video.path, 'changed during recovery'); };
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: changed === 'source' ? 'HISTORY_SOURCE_CHANGED' : 'HISTORY_PROCESSING_MEDIA_CORRUPT' }),
      ]);
      expect((await readdir(root)).some((name) => name.includes(`recovery-${changed}-change_TTcut_`))).toBe(false);
    } finally { state.injectRenameFailure = false; state.renameFailed = false; state.afterRecoveryProbe = null; }
  }, 45_000);

  it.each(['rename', 'log'] as const)('honors cancellation during recovery %s before commit', async (stage) => {
    const input = path.join(root, `cancel-recovery-${stage}.mp4`);
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    const recordPath = path.join(root, 'history-win32-valid', 'records', `${record.id}.json`);
    const storedBefore = await readFile(recordPath);
    let mark!: () => void; let release!: () => void;
    const reached = new Promise<void>((resolve) => { mark = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.injectRenameFailure = true; state.renameFailed = false;
    const pause = async () => { mark(); await gate; };
    if (stage === 'rename') state.afterPublishRename = pause;
    else state.afterRecoveryLog = pause;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    try {
      const taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: true, rally_videos: false, premiere_xml: false } });
      await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('recovery stage not reached')), 10_000))]);
      await cancelTask(taskId, 'user'); release();
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error' || event.type === 'export-result')).toBe(true), { timeout: 30_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
      ]);
      expect((await readdir(root)).some((name) => name.includes(`cancel-recovery-${stage}_TTcut_`))).toBe(false);
      expect(await readFile(recordPath)).toEqual(storedBefore);
    } finally { release(); state.injectRenameFailure = false; state.renameFailed = false; state.afterPublishRename = null; state.afterRecoveryLog = null; }
  }, 45_000);

  it('stops a stalled CFR copy immediately on cancellation and cleans its temporary file', async () => {
    const input = path.join(root, 'cancel-copy-source.mp4');
    await copyFile(source, input);
    const record = await makeHistory('win32', 'valid', input);
    let mark!: () => void;
    const reached = new Promise<void>((resolve) => { mark = resolve; });
    let streamDestroyed = false; let started = false;
    state.slowCopySource = record.analysis.video.path;
    state.slowCopyStream = () => new Readable({
      read() { if (!started) { started = true; this.push(Buffer.alloc(65_536)); mark(); } },
      destroy(error, done) { streamDestroyed = true; done(error); },
    });
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    let taskId = '';
    try {
      taskId = await startExport(window, { analysis_id: record.id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 }] },
        outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
      await Promise.race([reached, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('copy not reached')), 10_000))]);
      await cancelTask(taskId, 'user');
      await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true), { timeout: 2_000 });
      expect(events.filter((event) => event.type === 'error' || event.type === 'export-result')).toEqual([
        expect.objectContaining({ type: 'error', taskId, code: 'EXPORT_CANCELLED' }),
      ]);
      expect(streamDestroyed).toBe(true);
      expect((await readdir(root)).some((name) => name.startsWith('cancel-copy-source_TTcut_'))).toBe(false);
    } finally {
      state.slowCopySource = ''; state.slowCopyStream = null;
      if (activeTaskIds().includes(taskId)) await vi.waitFor(() => expect(activeTaskIds()).not.toContain(taskId), { timeout: 10_000 });
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
