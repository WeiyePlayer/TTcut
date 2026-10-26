// @vitest-environment node
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CutGroup, HistoryRecordV1, VideoMetadata } from '../src/shared/contracts';
import type { AppEvent } from '../src/shared/api';
import type { BrowserWindow } from 'electron';

const historyState = vi.hoisted(() => ({ record: null as HistoryRecordV1 | null, denyXmlWrite: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: (...args: Parameters<typeof actual.writeFile>) => {
    if (historyState.denyXmlWrite && String(args[0]).endsWith('.xml')) {
      return Promise.reject(Object.assign(new Error('permission denied writing XML'), { code: 'EACCES' }));
    }
    return actual.writeFile(...args);
  } };
});
vi.mock('../src/main/history', () => ({ getHistoryStore: () => ({ open: async () => historyState.record, markVisible: vi.fn().mockResolvedValue(undefined) }) }));

vi.mock('electron', () => ({ dialog: {}, app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() } }));
vi.mock('../src/main/logger', () => ({ logLine: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => ({
  ffmpeg: process.env.TTCUT_FFMPEG_INTEGRATION, ffprobe: process.env.TTCUT_FFPROBE_INTEGRATION, mediaEncoder: 'libx264',
}) }));
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

describe.skipIf(!enabled)('real FFmpeg Windows export fidelity', () => {
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

  it('detects real frame-carried HDR10+ and rejects video export before metadata can be lost', async () => {
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
    expect(() => buildSegmentReencodeArgs(source, path.join(root, 'rejected.mp4'), group(0, 1), 0, video)).toThrow('DYNAMIC_HDR_UNSUPPORTED');
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
    expect(xml).toContain(original.path);
    expect(xml).not.toContain('_TTcut_CFR.mp4');
    expect(await readFile(oldCache, 'utf8')).toBe('stale SDR cache that must never be copied');
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
    await decode(result.data.rallyVideos[0]!.outputPath);
  }, 60_000);
});
