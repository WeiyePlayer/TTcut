import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHistoryCoverArgs, HistoryStore } from '../src/main/history';
import type { AnalysisResultV1, Calibration } from '../src/shared/contracts';

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

  it('does not store an empty analysis and never deletes the source file', async () => {
    const { store, source } = await storeFixture();
    await expect(store.upsert(analysis(source, 0), calibration)).resolves.toBeNull();
    expect(await store.list()).toEqual([]);

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
