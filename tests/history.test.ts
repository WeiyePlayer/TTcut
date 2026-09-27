import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHistoryCoverArgs, HistoryStore } from '../src/main/history';
import type { AnalysisResultV1, Calibration } from '../src/shared/contracts';
import { createCustomClipDraft } from '../src/domain/custom-clips';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'ttcut-history-'));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const calibration: Calibration = {
  video_width: 1280,
  video_height: 720,
  points: {
    top_left: [400, 200],
    top_right: [880, 200],
    bottom_right: [1050, 620],
    bottom_left: [230, 620],
  },
};

function analysis(videoPath: string, rallyCount = 1): AnalysisResultV1 {
  return {
    schema_version: 1,
    video: {
      path: videoPath,
      duration_seconds: 30,
      width: 1280,
      height: 720,
      fps: 60,
      variable_frame_rate: false,
      video_codec: 'h264',
      audio_codec: 'aac',
      container: 'mp4',
    },
    rallies: Array.from({ length: rallyCount }, (_, index) => ({
      id: `rally_${String(index + 1).padStart(3, '0')}`,
      index: index + 1,
      bounce_count: 4,
      start_time_seconds: 2 + index * 5,
      end_time_seconds: 4 + index * 5,
    })),
  };
}

async function storeFixture() {
  const root = await temporaryDirectory();
  const source = path.join(root, '比赛视频.mp4');
  await writeFile(source, 'source-video', 'utf8');
  const store = new HistoryStore(path.join(root, 'history'), async (_input, output) => {
    await writeFile(output, 'jpeg-cover', 'utf8');
  });
  return { root, source, store };
}

describe('analysis history', () => {
  it('preserves every index entry when deferred records are promoted concurrently', async () => {
    const { store, root } = await storeFixture();
    const records = [];
    for (let index = 0; index < 8; index++) {
      const source = path.join(root, `${index}.mp4`);
      await writeFile(source, 'source');
      records.push(await store.upsert(analysis(source), calibration, false));
    }
    await Promise.all(records.map((record) => store.markVisible(record.id, 'analysis')));
    expect((await store.list()).map(({ record }) => record.id).sort()).toEqual(records.map((record) => record.id).sort());
  });

  it('keeps the successful history independent until a pending run completes', async () => {
    const { store, source } = await storeFixture();
    const previous = await store.upsert(analysis(source), calibration);
    const pending = await store.upsert(analysis(source, 2), calibration, false);
    expect(pending.id).not.toBe(previous.id);
    expect((await store.list()).map(({ record }) => record.id)).toEqual([previous.id]);
    expect((await store.open(previous.id)).analysis.rallies).toHaveLength(1);
    await store.delete(pending.id);
    expect((await store.list()).map(({ record }) => record.id)).toEqual([previous.id]);
    const retry = await store.upsert(analysis(source, 2), calibration, false);
    await store.markVisible(retry.id, 'export', `${source}.output.mp4`);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record.id).toBe(retry.id);
    expect(entries[0]?.record.analysis.rallies).toHaveLength(2);
  });

  it('persists editor changes across store instances and concurrent export completion', async () => {
    const { store, root, source } = await storeFixture();
    const record = await store.upsert(analysis(source), calibration);
    const clips = createCustomClipDraft(record.analysis.rallies, 1.5, 0.5, 30, 60);
    clips[0]!.end -= 0.5;
    const draft = { schema_version: 1 as const, clips, playbackMode: 'rallies' as const,
      outputs: { combined_video: false, rally_videos: true, premiere_xml: false } };
    await Promise.all([store.saveCustomEditorDraft(record.id, draft), store.markVisible(record.id, 'export', 'output.mp4')]);
    const reopened = await new HistoryStore(path.join(root, 'history')).open(record.id);
    expect(reopened.custom_editor_draft).toEqual(draft);
    expect(reopened.output_path).toBe('output.mp4');
    await expect(store.saveCustomEditorDraft(record.id, { ...draft, clips: [{ ...clips[0], end: 100 }] })).rejects.toThrow();
    expect((await store.open(record.id)).custom_editor_draft).toEqual(draft);
    await store.saveCustomEditorDraft(record.id, { ...draft, clips: [] });
    expect((await store.open(record.id)).custom_editor_draft?.clips).toEqual([]);
    await store.flush();
    expect(store.hasPendingWrites()).toBe(false);
  });

  it('extracts the first decoded frame without seeking or representative-frame filtering', () => {
    const args = buildHistoryCoverArgs('D:/比赛/输入.mp4', 'D:/缓存/封面.jpg');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args).not.toContain('-ss');
    expect(args.join(' ')).not.toContain('thumbnail');
    expect(args.slice(-2)).toEqual(['-y', 'D:/缓存/封面.jpg']);
  });

  it('replaces the same source fingerprint instead of creating a duplicate', async () => {
    const { store, source } = await storeFixture();
    const first = await store.upsert(analysis(source), calibration);
    const second = await store.upsert(analysis(source, 2), calibration);

    expect(first?.id).toBe(second?.id);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record.analysis.rallies).toHaveLength(2);
    expect(entries[0]?.sourceStatus).toBe('available');
    await expect(readFile(entries[0]!.coverPath!, 'utf8')).resolves.toBe('jpeg-cover');
  });

  it('treats a changed file fingerprint as a new source and disables the stale entry', async () => {
    const { store, source } = await storeFixture();
    const first = await store.upsert(analysis(source), calibration);
    await writeFile(source, 'source-video-replaced', 'utf8');
    const second = await store.upsert(analysis(source), calibration);

    expect(second?.id).not.toBe(first?.id);
    const entries = await store.list();
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.record.id === second?.id)?.sourceStatus).toBe('available');
    expect(entries.find((entry) => entry.record.id === first?.id)?.sourceStatus).toBe('changed');
    await expect(store.open(first!.id)).rejects.toThrow('HISTORY_SOURCE_CHANGED');
  });

  it('persists deferred analysis without showing it until export completes', async () => {
    const { store, source } = await storeFixture();
    const hidden = await store.upsert(analysis(source), calibration, false);
    expect(await store.list()).toEqual([]);
    expect((await store.findBySource(source))?.id).toBe(hidden.id);

    await store.markVisible(hidden.id, 'export', `${source}.output.mp4`);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record).toMatchObject({
      id: hidden.id,
      visible_in_history: true,
      completion_kind: 'export',
      output_path: `${source}.output.mp4`,
    });
  });

  it('stores a zero-rally analysis and never deletes the source file', async () => {
    const { store, source } = await storeFixture();
    const emptyRecord = await store.upsert(analysis(source, 0), calibration);
    expect(emptyRecord?.analysis.rallies).toEqual([]);
    expect(await store.list()).toHaveLength(1);
    await store.delete(emptyRecord!.id);
    expect(await store.list()).toEqual([]);
    await expect(stat(source)).resolves.toMatchObject({ size: 12 });

    const record = await store.upsert(analysis(source), calibration);
    await store.delete(record!.id);
    expect(await store.list()).toEqual([]);
    await expect(stat(source)).resolves.toMatchObject({ size: 12 });

    await store.upsert(analysis(source), calibration);
    await store.clear();
    expect(await store.list()).toEqual([]);
    await expect(stat(source)).resolves.toMatchObject({ size: 12 });
  });

  it('keeps a missing source visible but refuses to activate it', async () => {
    const { store, source } = await storeFixture();
    const record = await store.upsert(analysis(source), calibration);
    await rm(source);
    expect((await store.list())[0]?.sourceStatus).toBe('missing');
    await expect(store.open(record!.id)).rejects.toThrow('HISTORY_SOURCE_MISSING');
  });
});
