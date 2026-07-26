import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import {
  historyRecordSchema,
  type AnalysisResultV1,
  type Calibration,
  type HistoryRecordV1,
  type HistorySource,
} from '../shared/contracts';
import { resolveComponents } from './components';
import { logLine } from './logger';
import { runProcess } from './processes';

const historyIndexSchema = z.object({
  schema_version: z.literal(1),
  entries: z.array(z.object({
    id: z.string().uuid(),
    analyzed_at: z.string().min(1),
  }).strict()),
}).strict();

type HistoryIndex = z.infer<typeof historyIndexSchema>;
type CoverCreator = (sourcePath: string, destination: string) => Promise<void>;

export type StoredHistorySummary = {
  record: HistoryRecordV1;
  coverPath: string | null;
  sourceStatus: 'available' | 'missing' | 'changed';
};

function normalizedIdentityPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function sameSource(left: HistorySource, right: HistorySource): boolean {
  return normalizedIdentityPath(left.path) === normalizedIdentityPath(right.path)
    && left.size === right.size
    && left.modified_time_ms === right.modified_time_ms;
}

export function buildHistoryCoverArgs(sourcePath: string, destination: string): string[] {
  return [
    '-v', 'error', '-i', sourcePath,
    '-map', '0:v:0', '-frames:v', '1',
    '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
    '-q:v', '3', '-update', '1', '-y', destination,
  ];
}

async function defaultCreateCover(sourcePath: string, destination: string): Promise<void> {
  const components = await resolveComponents();
  if (!components.ffmpeg) throw new Error('MEDIA_COMPONENT_MISSING');
  await runProcess(components.ffmpeg, buildHistoryCoverArgs(sourcePath, destination), { timeoutMs: 30_000 });
}

export class HistoryStore {
  constructor(
    private readonly root: string,
    private readonly createCover: CoverCreator = defaultCreateCover,
  ) {}

  private indexPath(): string { return path.join(this.root, 'index.json'); }
  private recordsRoot(): string { return path.join(this.root, 'records'); }
  private coversRoot(): string { return path.join(this.root, 'covers'); }
  private recordPath(id: string): string { return path.join(this.recordsRoot(), `${id}.json`); }
  private coverPath(id: string): string { return path.join(this.coversRoot(), `${id}.jpg`); }

  private async writeJsonAtomic(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }

  private async loadRecord(id: string): Promise<HistoryRecordV1 | null> {
    try {
      return historyRecordSchema.parse(JSON.parse(await readFile(this.recordPath(id), 'utf8')));
    } catch (error) {
      await logLine('history', 'WARN', `Ignoring invalid history record ${id}: ${String(error)}`).catch(() => undefined);
      return null;
    }
  }

  private async rebuildIndex(): Promise<HistoryIndex> {
    const entries: HistoryIndex['entries'] = [];
    const files = await readdir(this.recordsRoot(), { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const id = file.name.slice(0, -5);
      if (!z.string().uuid().safeParse(id).success) continue;
      const record = await this.loadRecord(id);
      if (record) entries.push({ id: record.id, analyzed_at: record.analyzed_at });
    }
    entries.sort((a, b) => b.analyzed_at.localeCompare(a.analyzed_at));
    const rebuilt: HistoryIndex = { schema_version: 1, entries };
    await this.writeJsonAtomic(this.indexPath(), rebuilt);
    return rebuilt;
  }

  private async loadIndex(): Promise<HistoryIndex> {
    try {
      return historyIndexSchema.parse(JSON.parse(await readFile(this.indexPath(), 'utf8')));
    } catch (error) {
      const target = this.indexPath();
      const exists = await stat(target).then((value) => value.isFile()).catch(() => false);
      if (exists) {
        const backup = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        await rename(target, backup).catch(() => undefined);
        await logLine('history', 'WARN', `Backed up an invalid history index to ${backup}: ${String(error)}`).catch(() => undefined);
      }
      return this.rebuildIndex();
    }
  }

  private async saveIndex(entries: HistoryIndex['entries']): Promise<void> {
    entries.sort((a, b) => b.analyzed_at.localeCompare(a.analyzed_at));
    await this.writeJsonAtomic(this.indexPath(), { schema_version: 1, entries });
  }

  private async sourceStatus(source: HistorySource): Promise<StoredHistorySummary['sourceStatus']> {
    const info = await stat(source.path).catch(() => null);
    if (!info?.isFile()) return 'missing';
    return info.size === source.size && info.mtimeMs === source.modified_time_ms ? 'available' : 'changed';
  }

  private async ensureCover(record: HistoryRecordV1): Promise<string | null> {
    const target = this.coverPath(record.id);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size > 0) return target;
    const temporary = path.join(this.coversRoot(), `${record.id}.${randomUUID()}.partial.jpg`);
    try {
      await mkdir(this.coversRoot(), { recursive: true });
      await this.createCover(record.source.path, temporary);
      const generated = await stat(temporary);
      if (!generated.isFile() || generated.size <= 0) throw new Error('HISTORY_COVER_EMPTY');
      await rm(target, { force: true });
      await rename(temporary, target);
      return target;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      await logLine('history', 'WARN', `Could not generate history cover for ${record.id}: ${String(error)}`).catch(() => undefined);
      return null;
    }
  }

  async upsert(analysis: AnalysisResultV1, calibration: Calibration): Promise<HistoryRecordV1 | null> {
    if (analysis.rallies.length === 0) return null;
    const sourceInfo = await stat(analysis.video.path);
    if (!sourceInfo.isFile() || sourceInfo.size <= 0) throw new Error('INPUT_MOVED');
    const source: HistorySource = {
      path: path.resolve(analysis.video.path),
      name: path.basename(analysis.video.path),
      size: sourceInfo.size,
      modified_time_ms: sourceInfo.mtimeMs,
    };
    const index = await this.loadIndex();
    let existing: HistoryRecordV1 | null = null;
    for (const entry of index.entries) {
      const candidate = await this.loadRecord(entry.id);
      if (candidate && sameSource(candidate.source, source)) {
        existing = candidate;
        break;
      }
    }
    const record = historyRecordSchema.parse({
      schema_version: 1,
      id: existing?.id ?? randomUUID(),
      analyzed_at: new Date().toISOString(),
      source,
      calibration,
      analysis,
    });
    await this.writeJsonAtomic(this.recordPath(record.id), record);
    await this.saveIndex([
      { id: record.id, analyzed_at: record.analyzed_at },
      ...index.entries.filter((entry) => entry.id !== record.id),
    ]);
    await rm(this.coverPath(record.id), { force: true }).catch(() => undefined);
    await this.ensureCover(record);
    return record;
  }

  async list(retryMissingCovers = false): Promise<StoredHistorySummary[]> {
    const index = await this.loadIndex();
    const summaries: StoredHistorySummary[] = [];
    for (const entry of index.entries) {
      const record = await this.loadRecord(entry.id);
      if (!record || record.analysis.rallies.length === 0) continue;
      const sourceStatus = await this.sourceStatus(record.source);
      let coverPath = await stat(this.coverPath(record.id)).then((value) => value.isFile() && value.size > 0 ? this.coverPath(record.id) : null).catch(() => null);
      if (!coverPath && retryMissingCovers && sourceStatus === 'available') coverPath = await this.ensureCover(record);
      summaries.push({ record, coverPath, sourceStatus });
    }
    return summaries;
  }

  async open(id: string): Promise<HistoryRecordV1> {
    const parsedId = z.string().uuid().parse(id);
    const record = await this.loadRecord(parsedId);
    if (!record) throw new Error('HISTORY_RECORD_INVALID');
    const status = await this.sourceStatus(record.source);
    if (status === 'missing') throw new Error('HISTORY_SOURCE_MISSING');
    if (status === 'changed') throw new Error('HISTORY_SOURCE_CHANGED');
    return record;
  }

  async delete(id: string): Promise<void> {
    const parsedId = z.string().uuid().parse(id);
    const index = await this.loadIndex();
    await Promise.all([
      rm(this.recordPath(parsedId), { force: true }),
      rm(this.coverPath(parsedId), { force: true }),
    ]);
    await this.saveIndex(index.entries.filter((entry) => entry.id !== parsedId));
  }

  async clear(): Promise<void> {
    await Promise.all([
      rm(this.recordsRoot(), { recursive: true, force: true }),
      rm(this.coversRoot(), { recursive: true, force: true }),
    ]);
    await this.saveIndex([]);
  }
}

let singleton: HistoryStore | null = null;

export function getHistoryStore(): HistoryStore {
  singleton ??= new HistoryStore(path.join(app.getPath('userData'), 'history'));
  return singleton;
}
