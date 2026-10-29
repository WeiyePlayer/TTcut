// @vitest-environment node
import { access, chmod, copyFile, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CutGroup, HistoryRecordV1, VideoMetadata } from '../src/shared/contracts';
import type { AppEvent } from '../src/shared/api';
import type { BrowserWindow } from 'electron';

const historyState = vi.hoisted(() => ({ record: null as HistoryRecordV1 | null, denyXmlWrite: false, historyFailure: false,
  denyCfrCopy: false, probeUnavailable: false, logFailure: false, ffmpegOverride: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: (...args: Parameters<typeof actual.writeFile>) => {
    if (historyState.denyXmlWrite && String(args[0]).endsWith('.xml')) {
      return Promise.reject(Object.assign(new Error('permission denied writing XML'), { code: 'EACCES' }));
    }
    return actual.writeFile(...args);
  } };
});
vi.mock('../src/main/export-copy', async (original) => {
  const real = await original<typeof import('../src/main/export-copy')>();
  return { ...real, copyExportCfr: async (...args: Parameters<typeof real.copyExportCfr>) => {
    if (historyState.denyCfrCopy) throw Object.assign(new Error('cache unreadable'), { code: 'EACCES' });
    return real.copyExportCfr(...args);
  } };
});
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ open: async () => historyState.record, assertExportSource: async () => {}, markVisible: async () => {
  if (historyState.historyFailure) throw new Error('HISTORY_WRITE_FAILED');
} }) }));

vi.mock('electron', () => ({ dialog: {}, app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() } }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn(async () => { if (historyState.logFailure) throw new Error('LOG_WRITE_FAILED'); }) }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => {
  if (historyState.probeUnavailable) throw new Error('MEDIA_COMPONENT_MISSING');
  return { ffmpeg: historyState.ffmpegOverride ?? process.env.TTCUT_FFMPEG_INTEGRATION, ffprobe: process.env.TTCUT_FFPROBE_INTEGRATION, mediaEncoder: 'libx264' };
} }));
import { runProcess } from '../src/main/processes';
import { probeVideo } from '../src/main/probe';
import { buildConcatArgs, buildConcatManifest, buildCfrNormalizationArgs, buildReencodeArgs, buildSegmentReencodeArgs } from '../src/main/media-plan';
import { batchOutputProfile, buildBatchSegmentArgs } from '../src/main/batch-media-plan';
import { startExport, validateExportOutput } from '../src/main/export';

const ffmpeg = process.env.TTCUT_FFMPEG_INTEGRATION;
const ffprobe = process.env.TTCUT_FFPROBE_INTEGRATION;
const platform = process.platform;
const enabled = Boolean(ffmpeg && ffprobe);
const group = (start: number, end: number): CutGroup => ({ start, end, rawStart: start, rawEnd: end, rallyIds: ['rally_001'] });
async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function xmlReferencedPath(xml: string): string {
  const match = /<pathurl>([^<]+)<\/pathurl>/.exec(xml);
  if (!match) throw new Error('XML source path is missing');
  return fileURLToPath(match[1]!);
}

describe.skipIf(!enabled)(`real FFmpeg Windows export arguments on ${platform}`, () => {
  let root: string;
  const videos = new Map<string, VideoMetadata>();
  beforeAll(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    root = await mkdtemp(path.join(process.env.TTCUT_FIDELITY_TEST_ROOT ?? os.tmpdir(), 'ttcut-fidelity-'));
    for (const kind of ['sdr-avc', 'sdr-hevc', 'hlg', 'hdr10', 'vfr-hlg']) {
      const hdr = ['hlg', 'hdr10', 'vfr-hlg'].includes(kind);
      const file = path.join(root, `${kind}.mp4`);
      const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2'];
      if (kind === 'vfr-hlg') args.push('-vf', "select='not(mod(n,2))+not(mod(n,5))'", '-fps_mode', 'vfr');
      args.push('-c:v', kind === 'sdr-avc' ? 'libx264' : 'libx265', '-preset', 'ultrafast', '-pix_fmt', hdr ? 'yuv420p10le' : 'yuv420p');
      if (kind !== 'sdr-avc') {
        const transfer = kind === 'hdr10' ? 'smpte2084' : hdr ? 'arib-std-b67' : 'bt709';
        args.push('-tag:v', 'hvc1', '-color_primaries', hdr ? 'bt2020' : 'bt709', '-color_trc', transfer,
          '-colorspace', hdr ? 'bt2020nc' : 'bt709', '-color_range', 'tv', '-x265-params',
          `pools=2:frame-threads=2:log-level=error:colorprim=${hdr ? 'bt2020' : 'bt709'}:colormatrix=${hdr ? 'bt2020nc' : 'bt709'}:transfer=${transfer}`
          + (kind === 'hdr10' ? ':hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400' : ''));
      } else args.push('-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
      args.push('-c:a', 'aac', '-b:a', '128000', '-shortest', file);
      await runProcess(ffmpeg!, args, { timeoutMs: 60_000 });
      videos.set(kind, await probeVideo(file));
    }
  }, 120_000);
  afterAll(async () => {
    Object.defineProperty(process, 'platform', { value: platform });
    if (root && !process.env.TTCUT_FIDELITY_TEST_ROOT) await rm(root, { recursive: true, force: true });
  });
  async function rawProbe(file: string) {
    return JSON.parse((await runProcess(ffprobe!, ['-v', 'error', '-show_streams', '-of', 'json', file])).stdout).streams[0];
  }
  async function decode(file: string) {
    await runProcess(ffmpeg!, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeoutMs: 60_000 });
  }

  for (const [kind, compatibility] of [['DV81', 1], ['DV84', 4]] as const) {
    const source = process.env[`TTCUT_${kind}_INTEGRATION`];
    it.skipIf(!source)(`automatically converts a real Dolby Vision ${kind} compatible base layer`, async () => {
      const originalHash = await fileHash(source!);
      const video = await probeVideo(source!);
      expect(video.media_fidelity).toMatchObject({ hdr: 'dolbyVision',
        dolby_vision: { profile: 8, base_layer_present: true, signal_compatibility_id: compatibility } });
      const output = path.join(root, `${kind}-sdr.mp4`);
      const id = '11111111-1111-4111-8111-111111111111';
      historyState.record = { id, analysis: { schema_version: 1, video,
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 15, end_time_seconds: 16.5 }] } } as HistoryRecordV1;
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      const ranges = kind === 'DV84' ? [[15, 15.5], [16, 16.5]] : [[15, 16]];
      await startExport(window, { analysis_id: id, destination: 'source', selection: { mode: 'custom',
        segments: ranges.map(([start, end], index) => ({ source: 'detected', rally_id: 'rally_001',
          clip_id: `part_${index}`, display_index: index + 1, start_time_seconds: start!, end_time_seconds: end! })) } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
      const terminal = events.find((event) => event.type === 'export-result' || event.type === 'error');
      if (terminal?.type !== 'export-result' || terminal.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(terminal));
      await copyFile(terminal.data.outputPath, output);
      await rm(terminal.data.outputPath);
      const checked = await validateExportOutput(output, { targetSeconds: 1, segmentCount: 1 }, video, 'normalized');
      expect(checked.metadata).toMatchObject({ video_codec: 'h264', pixel_format: 'yuv420p',
        color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', color_range: 'tv',
        media_fidelity: { hdr: 'sdr', bit_depth: 8, chroma: '420', mastering_display: null, max_cll: null } });
      const frames = JSON.parse((await runProcess(ffprobe!, ['-v', 'error', '-show_frames', '-of', 'json', output])).stdout).frames;
      expect(frames.some((frame: { side_data_list?: Array<{ side_data_type?: string }> }) =>
        frame.side_data_list?.some((side) => /DOVI|Dolby Vision|HDR|Mastering display|Content light/i.test(side.side_data_type ?? '')))).toBe(false);
      const image = path.join(root, `${kind}-sdr.rgb`);
      await runProcess(ffmpeg!, ['-v', 'error', '-y', '-i', output, '-vf', 'scale=320:180,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', image]);
      const pixels = await readFile(image);
      expect(pixels.reduce((sum, value) => sum + value, 0) / pixels.length).toBeGreaterThan(5);
      expect(pixels.reduce((max, value) => Math.max(max, value), 0)).toBeGreaterThan(180);
      let coloredPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 3) {
        if (Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!)
          - Math.min(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!) > 40) coloredPixels += 1;
      }
      expect(coloredPixels / (pixels.length / 3)).toBeGreaterThan(0.05);
      const retagged = path.join(root, `${kind}-retagged.rgb`);
      await runProcess(ffmpeg!, ['-v', 'error', '-y', '-i', source!, '-ss', '15',
        '-vf', 'scale=320:180,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,format=rgb24',
        '-frames:v', '1', '-f', 'rawvideo', retagged], { timeoutMs: 60_000 });
      const wrongPixels = await readFile(retagged);
      const difference = pixels.reduce((sum, value, index) => sum + Math.abs(value - wrongPixels[index]!), 0) / pixels.length;
      expect(difference).toBeGreaterThan(5);
      await decode(output);
      expect(await fileHash(source!)).toBe(originalHash);
    }, 60_000);
  }

  it.skipIf(platform !== 'darwin' || !process.env.TTCUT_DV81_INTEGRATION)('retries a missing PPS seek once from source start', async () => {
    const source = path.join(root, 'retry-dv81.mp4');
    await link(process.env.TTCUT_DV81_INTEGRATION!, source);
    const video = await probeVideo(source);
    const script = path.join(root, 'ffmpeg-retry.sh');
    const calls = path.join(root, 'retry-calls.txt');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(calls)}\ncase "$*" in *'-ss 0.000000'*) exec ${quote(ffmpeg!)} "$@";; esac\necho 'non-existing PPS 0 referenced' >&2\nexit 1\n`);
    await chmod(script, 0o755);
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = { id, analysis: { schema_version: 1, video,
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 15, end_time_seconds: 16 }] } } as HistoryRecordV1;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    historyState.ffmpegOverride = script;
    try {
      await startExport(window, { analysis_id: id, destination: 'source', selection: { mode: 'custom', segments: [
        { rally_id: 'rally_001', start_time_seconds: 15, end_time_seconds: 16 },
      ] } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    } finally { historyState.ffmpegOverride = null; }
    const terminal = events.find((event) => event.type === 'export-result' || event.type === 'error');
    if (terminal?.type !== 'export-result' || terminal.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(terminal));
    const invocations = (await readFile(calls, 'utf8')).trim().split('\n');
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).not.toContain('-ss 0.000000');
    expect(invocations[1]).toContain('-ss 0.000000');
    expect(invocations[1]).toContain('tonemap=');
    await decode(terminal.data.outputPath);
  }, 90_000);

  it.skipIf(!process.env.TTCUT_HDR10PLUS_INTEGRATION)('exports a real HDR10+ scene as decoded SDR video', async () => {
    const source = path.join(root, 'real-hdr10plus.mp4');
    await link(process.env.TTCUT_HDR10PLUS_INTEGRATION!, source);
    const sceneStart = Number(process.env.TTCUT_HDR10PLUS_START ?? '16');
    expect(Number.isFinite(sceneStart) && sceneStart >= 0).toBe(true);
    const beforeHash = await fileHash(source);
    const video = await probeVideo(source);
    expect(video.media_fidelity?.hdr).toBe('hdr10Plus');
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = { id, analysis: { schema_version: 1, video,
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: sceneStart, end_time_seconds: sceneStart + 0.5 }] } } as HistoryRecordV1;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    await startExport(window, { analysis_id: id, destination: 'source', selection: { mode: 'custom', segments: [
      { rally_id: 'rally_001', start_time_seconds: sceneStart, end_time_seconds: sceneStart + 0.5 },
    ] } });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 120_000 });
    const result = events.find((event) => event.type === 'export-result' || event.type === 'error');
    if (result?.type !== 'export-result' || result.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(result));
    expect(result.data.outputColor).toMatchObject({ video_codec: 'h264', pixel_format: 'yuv420p',
      color_range: 'tv', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709',
      media_fidelity: { hdr: 'sdr', bit_depth: 8, chroma: '420' } });
    await decode(result.data.outputPath);
    const frames = JSON.parse((await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-of', 'json', result.data.outputPath])).stdout).frames;
    expect(frames.some((frame: { side_data_list?: Array<{ side_data_type?: string }> }) =>
      frame.side_data_list?.some((side) => /DOVI|Dolby Vision|HDR|Mastering display|Content light/i.test(side.side_data_type ?? '')))).toBe(false);
    const rgb = path.join(root, 'real-hdr10plus.rgb');
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-i', result.data.outputPath, '-vf', 'scale=320:180,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', rgb]);
    const pixels = await readFile(rgb);
    expect(pixels.reduce((sum, value) => sum + value, 0) / pixels.length).toBeGreaterThan(5);
    expect(pixels.reduce((max, value) => Math.max(max, value), 0)).toBeGreaterThan(150);
    const retagged = path.join(root, 'real-hdr10plus-retagged.rgb');
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-i', source, '-ss', String(sceneStart), '-vf',
      'scale=320:180,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,format=rgb24',
      '-frames:v', '1', '-f', 'rawvideo', retagged], { timeoutMs: 60_000 });
    const baseline = await readFile(retagged);
    expect(baseline.length).toBe(pixels.length);
    const delta = pixels.reduce((sum, value, index) => sum + Math.abs(value - baseline[index]!), 0) / pixels.length;
    expect(delta).toBeGreaterThan(5);
    console.log(`real HDR10+ SDR vs retag-only mean RGB delta: ${delta.toFixed(3)}`);
    expect(await fileHash(source)).toBe(beforeHash);
  }, 180_000);

  it.each(['sdr-avc', 'sdr-hevc', 'hlg', 'hdr10', 'vfr-hlg'])('preserves %s through independent cuts, concatenation and validation', async (kind) => {
    const video = videos.get(kind)!;
    const original = await readFile(video.path);
    const groups = [group(0.125, 0.875), group(1.125, 1.875)];
    const names: string[] = [], durations: number[] = [];
    for (const [index, cut] of groups.entries()) {
      const name = `${kind}-segment-${index}.mp4`, segment = path.join(root, name);
      names.push(name);
      await runProcess(ffmpeg!, buildSegmentReencodeArgs(video.path, segment, cut, 0, video), { timeoutMs: 60_000 });
      const checked = await validateExportOutput(segment, { targetSeconds: 0.75, segmentCount: 1 }, video, 'normalized');
      durations.push(checked.metadata.duration_seconds);
    }
    const manifest = path.join(root, `${kind}.ffconcat`), output = path.join(root, `${kind}-merged.mp4`);
    await writeFile(manifest, buildConcatManifest(names, durations, 0.000_001));
    await runProcess(ffmpeg!, buildConcatArgs(manifest, output, video), { timeoutMs: 60_000 });
    const checked = await validateExportOutput(output, { targetSeconds: 1.5, segmentCount: 2 }, video, 'normalized');
    expect(checked.metadata.media_fidelity).toEqual(video.media_fidelity);
    const raw = await rawProbe(output);
    expect(raw.codec_name).toBe(kind === 'sdr-avc' ? 'h264' : 'hevc');
    if (raw.codec_name === 'hevc') expect(raw.codec_tag_string).toBe('hvc1');
    if (kind === 'hdr10') expect(checked.metadata.media_fidelity).toMatchObject({ max_cll: '1000,400', mastering_display: expect.stringContaining('G(13250,34500)') });
    await decode(output);
    expect(await readFile(video.path)).toEqual(original);
  }, 120_000);

  it('retains HDR metadata through CFR normalization, compatibility encoding and merged batches', async () => {
    for (const kind of ['hlg', 'hdr10']) {
      const video = videos.get(kind)!;
      for (const route of ['cfr', 'compatible', 'batch']) {
        const output = path.join(root, `${kind}-${route}.mp4`);
        const profile = batchOutputProfile(video, true);
        const args = route === 'cfr' ? buildCfrNormalizationArgs(video.path, output, video, '24/1', 'libx264')
          : route === 'batch' ? buildBatchSegmentArgs(video, profile, group(0, 2), output, 'libx264')
            : buildReencodeArgs(video.path, output, [group(0, 2)], video);
        await runProcess(ffmpeg!, args, { timeoutMs: 60_000 });
        const checked = await validateExportOutput(output, { targetSeconds: 2, segmentCount: 1 }, route === 'batch' ? profile : video, 'normalized');
        expect(checked.metadata.media_fidelity).toEqual(video.media_fidelity);
        await decode(output);
      }
    }
  }, 120_000);

  it('keeps VFR timestamps instead of duplicating frames to the encoder reference rate', async () => {
    const video = videos.get('vfr-hlg')!;
    expect(video.variable_frame_rate).toBe(true);
    const output = path.join(root, 'vfr-preserved.mp4');
    await runProcess(ffmpeg!, buildSegmentReencodeArgs(video.path, output, group(0, 2), 0, video), { timeoutMs: 60_000 });
    const actual = await probeVideo(output);
    expect(actual.variable_frame_rate).toBe(true);
    expect(actual.frame_count).toBe(video.frame_count);
    const frames = async (file: string) => JSON.parse((await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file])).stdout).frames.map((v: { best_effort_timestamp_time: string }) => Number(v.best_effort_timestamp_time)) as number[];
    const expected = await frames(video.path), exported = await frames(output);
    await writeFile(path.join(root, 'vfr-timestamps.json'), JSON.stringify({ expected, exported, video, actual }, null, 2));
    expect(exported.length).toBe(expected.length);
    expected.forEach((time, i) => expect(exported[i]! - exported[0]!).toBeCloseTo(time - expected[0]!, 5));
  }, 60_000);

  it('uses the same nominal rate for the CFR filter, encoder and container', async () => {
    const source = videos.get('vfr-hlg')!;
    const output = path.join(root, 'vfr-to-cfr.mp4');
    await runProcess(ffmpeg!, buildCfrNormalizationArgs(source.path, output, source, '24/1', 'libx264'), { timeoutMs: 60_000 });
    const result = await probeVideo(output);
    expect(result.variable_frame_rate).toBe(false);
    expect(result.fps).toBe(24);
    expect(result.nominal_fps).toBe(24);
    expect(result.media_fidelity).toEqual(source.media_fidelity);
    await decode(output);
  }, 60_000);

  it('does not inflate a 4K60 VFR H.264 stream to Level 6.2', async () => {
    const source = path.join(root, '4k60.mp4');
    await runProcess(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=s=3840x2160:r=60000/1001',
      '-frames:v', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', source], { timeoutMs: 60_000 });
    const video = { ...await probeVideo(source), variable_frame_rate: true };
    const output = path.join(root, '4k60-cut.mp4');
    const args = buildSegmentReencodeArgs(source, output, group(0, video.duration_seconds), 0, video);
    const encoded = await runProcess(ffmpeg!, args, { timeoutMs: 60_000 });
    expect(encoded.stderr).not.toContain('MB rate');
    const stream = await rawProbe(output);
    expect(stream.level).toBe(52);
    expect(stream.nb_frames).toBe('12');
    await decode(output);
  }, 60_000);

  it('detects real frame-carried HDR10+ and exports tone-mapped SDR pixels without HDR metadata', async () => {
    const raw = path.join(root, 'hdr10plus.hevc');
    await runProcess(ffmpeg!, ['-hide_banner', '-y', '-i', videos.get('hdr10')!.path, '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', raw]);
    const bytes = await readFile(raw), starts: Array<{ start: number; header: number }> = [];
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) { starts.push({ start: i, header: i + 3 }); i += 2; }
      else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) { starts.push({ start: i, header: i + 4 }); i += 3; }
    }
    // A valid registered T.35 payload serialized with av_dynamic_hdr_plus_to_t35.
    const payload = Buffer.from('b5003c0001040140001f404e202710138804e207189c400000', 'hex');
    const sei = Buffer.concat([Buffer.from([4, payload.length]), payload, Buffer.from([0x80])]);
    const escaped: number[] = []; let zeros = 0;
    for (const byte of sei) { if (zeros >= 2 && byte <= 3) { escaped.push(3); zeros = 0; } escaped.push(byte); zeros = byte === 0 ? zeros + 1 : 0; }
    const prefix = Buffer.from([0, 0, 0, 1]), parts: Buffer[] = [];
    starts.forEach((nal, index) => {
      if (((bytes[nal.header]! >> 1) & 63) <= 31) parts.push(prefix, Buffer.from([0x4e, 1]), Buffer.from(escaped));
      parts.push(prefix, bytes.subarray(nal.header, starts[index + 1]?.start ?? bytes.length));
    });
    await writeFile(raw, Buffer.concat(parts));
    const source = path.join(root, 'hdr10plus.mp4');
    await runProcess(ffmpeg!, ['-hide_banner', '-y', '-r', '24', '-i', raw, '-c', 'copy', '-tag:v', 'hvc1', source]);
    const video = await probeVideo(source);
    expect(video.media_fidelity?.hdr).toBe('hdr10Plus');
    const output = path.join(root, 'hdr10plus-sdr.mp4');
    const original = await readFile(source);
    await runProcess(ffmpeg!, buildSegmentReencodeArgs(source, output, group(0, 1), 0, video), { timeoutMs: 60_000 });
    const checked = await validateExportOutput(output, { targetSeconds: 1, segmentCount: 1 }, video, 'normalized');
    expect(checked.metadata).toMatchObject({ video_codec: 'h264', pixel_format: 'yuv420p',
      color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', color_range: 'tv',
      media_fidelity: { hdr: 'sdr', bit_depth: 8, chroma: '420', mastering_display: null, max_cll: null } });
    const decoded = JSON.parse((await runProcess(ffprobe!, ['-v', 'error', '-show_frames', '-of', 'json', output])).stdout);
    expect(decoded.frames.some((frame: { side_data_list?: Array<{ side_data_type?: string }> }) =>
      frame.side_data_list?.some((side) => /DOVI|Dolby Vision|HDR|Mastering display|Content light/i.test(side.side_data_type ?? '')))).toBe(false);
    const mapped = path.join(root, 'hdr10plus-sdr.rgb'), retagged = path.join(root, 'hdr10plus-retagged.rgb');
    for (const [input, destination, filters] of [[output, mapped, 'format=rgb24'],
      [source, retagged, 'format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,format=rgb24']]) {
      await runProcess(ffmpeg!, ['-v', 'error', '-y', '-i', input!, '-vf', filters!, '-frames:v', '1', '-f', 'rawvideo', destination!]);
    }
    const pixels = await readFile(mapped), wrongPixels = await readFile(retagged);
    expect(pixels.length).toBe(320 * 180 * 3);
    const difference = pixels.reduce((sum, value, index) => sum + Math.abs(value - wrongPixels[index]!), 0) / pixels.length;
    expect(difference).toBeGreaterThan(12);
    expect(pixels.reduce((max, value) => Math.max(max, value), 0)).toBeGreaterThan(180);
    expect(pixels.reduce((min, value) => Math.min(min, value), 255)).toBeLessThan(40);
    await decode(output);
    expect(await readFile(source)).toEqual(original);
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = { id, analysis: { schema_version: 1, video,
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.125, end_time_seconds: 1.75 }] } } as HistoryRecordV1;
    for (const independent of [false, true]) {
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      await startExport(window, { analysis_id: id, destination: 'source', selection: { mode: 'custom', segments: [
        { source: 'detected', display_index: 1, rally_id: 'rally_001', clip_id: 'first', start_time_seconds: 0.125, end_time_seconds: 0.75 },
        { source: 'detected', display_index: 2, rally_id: 'rally_001', clip_id: 'second', start_time_seconds: 1.125, end_time_seconds: 1.75 },
      ] }, ...(independent ? { outputs: { combined_video: false, rally_videos: true, premiere_xml: true } } : {}) });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
      const terminal = events.find((event) => event.type === 'export-result' || event.type === 'error');
      if (terminal?.type !== 'export-result') throw new Error(JSON.stringify(terminal));
      if (terminal.data.kind === 'custom-artifacts') {
        expect(terminal.data.rallyVideos).toHaveLength(2);
        expect(terminal.data.failedRallies).toEqual([]);
        expect(terminal.data.premiereXml).not.toBeNull();
        for (const rally of terminal.data.rallyVideos) {
          expect((await probeVideo(rally.outputPath)).media_fidelity?.hdr).toBe('sdr');
          await decode(rally.outputPath);
        }
      } else {
        expect(terminal.data.outputMediaFidelity?.hdr).toBe('sdr');
        await decode(terminal.data.outputPath);
      }
    }
  }, 60_000);

  it('rejects residual HDR metadata on an output frame outside the normal probe samples', async () => {
    const raw = path.join(root, 'late-hdr-sei.h264');
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', '-g', '120', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-f', 'h264', raw]);
    const bytes = await readFile(raw), frames: number[] = [];
    for (let i = 0; i < bytes.length - 5;) {
      const prefix = bytes[i] === 0 && bytes[i + 1] === 0
        ? (bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0) : 0;
      if (!prefix) { i++; continue; }
      if ([1, 5].includes(bytes[i + prefix]! & 0x1f)) frames.push(i);
      i += prefix + 1;
    }
    expect(frames.length).toBeGreaterThan(60);
    const sei = Buffer.from('0000000106891833c286c41d4c0bb884d03e803d134042009896800000030032900403e8019080', 'hex');
    await writeFile(raw, Buffer.concat([bytes.subarray(0, frames[60]), sei, bytes.subarray(frames[60])]));
    const output = path.join(root, 'late-hdr-sei.mp4');
    await runProcess(ffmpeg!, ['-v', 'error', '-y', '-r', '12', '-i', raw, '-c', 'copy',
      '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0', output]);
    const actual = await probeVideo(output);
    expect(actual.media_fidelity?.mastering_display).toBeNull();
    const allFrames = await runProcess(ffprobe!, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
      '-show_entries', 'frame=:frame_side_data=side_data_type', '-of', 'compact=p=0:nk=1', output]);
    expect(allFrames.stdout).toContain('Mastering display metadata');
    const source: VideoMetadata = { ...actual, video_codec: 'hevc', pixel_format: 'yuv420p10le',
      color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc',
      media_fidelity: { hdr: 'hdr10Plus', bit_depth: 10, chroma: '420', mastering_display: null, max_cll: null } };
    await expect(validateExportOutput(output, { targetSeconds: 8, segmentCount: 1 }, source, 'normalized')).rejects.toThrow('EXPORT_HDR_MISMATCH');
  }, 60_000);

  it('rejects a readable HEVC output when static HDR metadata has been stripped', async () => {
    const source = videos.get('hdr10')!;
    const output = path.join(root, 'hdr10-stripped.mp4');
    const raw = path.join(root, 'hdr10-stripped.hevc');
    // Strip both in-band SEI and the MP4's separate mastering/content-light boxes.
    await runProcess(ffmpeg!, ['-hide_banner', '-y', '-i', source.path, '-map', '0:v:0',
      '-c', 'copy', '-bsf:v', 'hevc_mp4toannexb,filter_units=remove_types=39|40', '-f', 'hevc', raw]);
    await runProcess(ffmpeg!, ['-hide_banner', '-y', '-r', '24', '-i', raw, '-i', source.path,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-tag:v', 'hvc1', '-map_metadata', '-1', output]);
    await decode(output);
    const actual = await probeVideo(output);
    expect(actual.media_fidelity?.hdr).toBe('hdr10');
    expect(actual.media_fidelity?.mastering_display).toBeNull();
    await expect(validateExportOutput(output, { targetSeconds: source.duration_seconds, segmentCount: 1 }, source)).rejects.toThrow('EXPORT_HDR_METADATA_LOST');
  }, 60_000);

  it('exports the original HDR video when an old Windows CFR cache is missing', async () => {
    const original = videos.get('vfr-hlg')!;
    const originalBytes = await readFile(original.path);
    const cache = path.join(root, 'missing-legacy-cfr.mp4');
    await expect(access(cache)).rejects.toThrow();
    const { media_fidelity: _fidelity, ...legacyVideo } = original;
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = {
      id, source: { path: original.path, name: 'original.mp4', size: originalBytes.length, modified_time_ms: 1 },
      analysis: { schema_version: 1,
        video: { ...legacyVideo, path: cache, variable_frame_rate: false, video_codec: 'h264', pixel_format: 'yuv420p' },
        source_video: legacyVideo,
        processing: { mode: 'normalized_cfr', target_fps_ratio: '24/1', encoder: 'libx264', warning_code: null },
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.25, end_time_seconds: 1.75 }] },
    } as HistoryRecordV1;
    const savedAnalysis = structuredClone(historyState.record.analysis);
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    await startExport(window, { analysis_id: id, destination: 'source',
      selection: { mode: 'all', pre_roll_seconds: 1.5, post_roll_seconds: 0.5 } });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    const result = events.find((event) => event.type === 'export-result' || event.type === 'error');
    if (result?.type !== 'export-result' || result.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(result));
    const output = await probeVideo(result.data.outputPath);
    expect(output.video_codec).toBe('hevc');
    expect(output.media_fidelity).toEqual(original.media_fidelity);
    expect(output.frame_count).toBe(original.frame_count);
    expect(historyState.record.analysis).toEqual(savedAnalysis);
    expect(await readFile(original.path)).toEqual(originalBytes);
    await expect(access(cache)).rejects.toThrow();
    await decode(result.data.outputPath);
  }, 60_000);

  it('returns a validated video with a warning when history cannot be updated', async () => {
    const video = videos.get('sdr-avc')!;
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = { id, analysis: { schema_version: 1, video,
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.25, end_time_seconds: 1.5 }] } } as HistoryRecordV1;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    historyState.historyFailure = true;
    try {
      await startExport(window, { analysis_id: id, destination: 'source', selection: { mode: 'custom', segments: [
        { rally_id: 'rally_001', start_time_seconds: 0.25, end_time_seconds: 1.5 },
      ] } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    } finally { historyState.historyFailure = false; }
    const terminal = events.filter((event) => event.type === 'export-result' || event.type === 'error');
    expect(terminal).toHaveLength(1);
    const result = terminal[0];
    if (result?.type !== 'export-result' || result.data.kind === 'custom-artifacts') throw new Error(JSON.stringify(result));
    expect(result.data.warning?.code).toBe('EXPORT_HISTORY_UPDATE_FAILED');
    expect(result.data.outputColor).toMatchObject({ video_codec: 'h264', pixel_format: 'yuv420p',
      color_primaries: null, color_transfer: null, color_space: 'bt709', color_range: 'tv',
      media_fidelity: { hdr: 'sdr', bit_depth: 8, chroma: '420' } });
    await decode(result.data.outputPath);
  }, 60_000);

  it('references the original HDR video without rebuilding an old Windows CFR XML sidecar', async () => {
    const original = videos.get('vfr-hlg')!;
    const oldCache = path.join(root, 'legacy-cfr.mp4');
    await writeFile(oldCache, 'stale SDR cache that must never be copied');
    const { media_fidelity: _fidelity, ...legacyVideo } = original;
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = {
      id, source: { path: original.path, name: 'original.mp4', size: 1, modified_time_ms: 1 },
      analysis: { schema_version: 1, video: { ...legacyVideo, path: oldCache, variable_frame_rate: false, video_codec: 'h264', pixel_format: 'yuv420p' },
        source_video: original,
        processing: { mode: 'normalized_cfr', target_fps_ratio: '24/1', encoder: 'libx264', warning_code: null },
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.5, end_time_seconds: 0.75 }] },
    } as HistoryRecordV1;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    await startExport(window, { analysis_id: id, destination: 'source',
      selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 0.25, end_time_seconds: 1 }] },
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
    await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    const result = events.find((event) => event.type === 'export-result' || event.type === 'error');
    if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
    expect(result.data.xmlFailure).toBeNull();
    const cfr = path.join(result.data.outputDirectory, `${path.basename(original.path, '.mp4')}_TTcut_CFR.mp4`);
    await expect(access(cfr)).rejects.toThrow();
    expect(result.data.premiereXml!.quantizedForVfr).toBe(true);
    const xml = await readFile(result.data.premiereXml!.outputPath, 'utf8');
    expect(xmlReferencedPath(xml)).toBe(original.path);
    expect(xml).not.toContain('_TTcut_CFR.mp4');
    expect(await readFile(oldCache, 'utf8')).toBe('stale SDR cache that must never be copied');
  }, 60_000);

  it.each(['valid', 'corrupt', 'mismatch', 'probe-unavailable', 'copy-failure'] as const)(
    'references a CFR cache for XML only when it is validated and readable (%s)', async (scenario) => {
      const source = videos.get('sdr-avc')!;
      const cache = path.join(root, `cache-${scenario}.mp4`);
      if (scenario === 'corrupt') await writeFile(cache, 'not a video');
      else await copyFile(source.path, cache);
      const expected = { ...source, path: cache, variable_frame_rate: false,
        ...(scenario === 'mismatch' ? { width: source.width + 2 } : {}) };
      const id = '11111111-1111-4111-8111-111111111111';
      historyState.record = { id, source: { path: source.path, name: 'source.mp4', size: 1, modified_time_ms: 1 },
        analysis: { schema_version: 1, video: expected, source_video: { ...source, variable_frame_rate: true },
          processing: { mode: 'normalized_cfr', target_fps_ratio: '24/1', encoder: 'libx264', warning_code: null },
          rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.5, end_time_seconds: 0.75 }] } } as HistoryRecordV1;
      const events: AppEvent[] = [];
      const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
      historyState.denyCfrCopy = scenario === 'copy-failure';
      historyState.probeUnavailable = scenario === 'probe-unavailable';
      try {
        await startExport(window, { analysis_id: id, destination: 'source',
          selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 0.25, end_time_seconds: 1 }] },
          outputs: { combined_video: false, rally_videos: false, premiere_xml: true } });
        await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
      } finally { historyState.denyCfrCopy = false; historyState.probeUnavailable = false; }
      const terminal = events.filter((event) => event.type === 'export-result' || event.type === 'error');
      expect(terminal).toHaveLength(1);
      const result = terminal[0];
      if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
      const xml = await readFile(result.data.premiereXml!.outputPath, 'utf8');
      expect(xml.includes('_TTcut_CFR.mp4')).toBe(scenario === 'valid');
      if (scenario !== 'valid') expect(xmlReferencedPath(xml)).toBe(source.path);
      expect(result.data.premiereXml!.quantizedForVfr).toBe(scenario !== 'valid');
    }, 60_000);

  it('retains a decoded rally video when writing XML fails', async () => {
    const source = videos.get('sdr-avc')!;
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = { id,
      source: { path: source.path, name: 'source.mp4', size: 1, modified_time_ms: 1 },
      analysis: { schema_version: 1, video: source,
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.5, end_time_seconds: 0.75 }] },
    } as HistoryRecordV1;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    historyState.denyXmlWrite = true;
    try {
      await startExport(window, { analysis_id: id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 0.25, end_time_seconds: 1 }] },
        outputs: { combined_video: false, rally_videos: true, premiere_xml: true } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    } finally {
      historyState.denyXmlWrite = false;
    }
    const result = events.find((event) => event.type === 'export-result' || event.type === 'error');
    if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
    expect(result.data).toMatchObject({ partialSuccess: true, premiereXml: null,
      xmlFailure: { code: 'OUTPUT_DIRECTORY_UNWRITABLE' }, failedRallies: [] });
    expect(result.data.rallyVideos).toHaveLength(1);
    expect(result.data.rallyVideos[0]?.outputColor).toMatchObject({ video_codec: 'h264', pixel_format: 'yuv420p',
      color_primaries: null, color_transfer: null, color_space: 'bt709', color_range: 'tv',
      media_fidelity: { hdr: 'sdr', bit_depth: 8, chroma: '420' } });
    await decode(result.data.rallyVideos[0]!.outputPath);
  }, 60_000);

  it('exports video and XML despite failing synchronous and FFmpeg process logging', async () => {
    const video = videos.get('sdr-avc')!;
    const id = '11111111-1111-4111-8111-111111111111';
    historyState.record = { id, analysis: { schema_version: 1, video,
      rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 0.25, end_time_seconds: 1 }] } } as HistoryRecordV1;
    const events: AppEvent[] = [];
    const window = { isDestroyed: () => false, webContents: { send: (_channel: string, event: AppEvent) => events.push(event) } } as unknown as BrowserWindow;
    historyState.logFailure = true;
    try {
      await startExport(window, { analysis_id: id, destination: 'source',
        selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 0.25, end_time_seconds: 1 }] },
        outputs: { combined_video: false, rally_videos: true, premiere_xml: true } });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'export-result' || event.type === 'error')).toBe(true), { timeout: 60_000 });
    } finally { historyState.logFailure = false; }
    const terminal = events.filter((event) => event.type === 'export-result' || event.type === 'error');
    expect(terminal).toHaveLength(1);
    const result = terminal[0];
    if (result?.type !== 'export-result' || result.data.kind !== 'custom-artifacts') throw new Error(JSON.stringify(result));
    expect(result.data.partialSuccess).toBe(false);
    expect(result.data.failedRallies).toEqual([]);
    expect(await readFile(result.data.premiereXml!.outputPath, 'utf8')).toContain('sdr-avc.mp4');
    await decode(result.data.rallyVideos[0]!.outputPath);
  }, 60_000);
});
