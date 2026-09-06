import { constants } from 'node:fs';
import { copyFile, link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { batchExportRequestSchema, type BatchExportRequest, type CutGroup, type VideoMetadata } from '../shared/contracts';
import type { AppEvent } from '../shared/api';
import { IPC } from '../shared/ipc';
import { createCutGroups, SelectionError } from '../domain/segments';
import { getHistoryStore } from './history';
import { resolveUsableMediaComponents } from './components';
import { batchOutputProfile, batchSegmentDuration, buildBatchSegmentArgs } from './batch-media-plan';
import { buildConcatArgs, buildConcatManifest } from './media-plan';
import { assertExportPreconditions, clearExportProgress, runFfmpeg, uniqueOutput, validateExportOutput } from './export';
import { beginTrackedTask, endTrackedTask, markTaskTerminal } from './processes';
import { registerMediaPath } from './media-protocol';
import { logLine } from './logger';

function send(window: BrowserWindow, event: AppEvent): void {
  if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
}

async function executeBatchExport(window: BrowserWindow, taskId: string, request: BatchExportRequest, signal: AbortSignal) {
  let temporaryDirectory: string | null = null;
  let terminal: AppEvent = { type: 'error', taskId, code: 'EXPORT_FAILED', message: 'Batch export did not complete' };
  try {
    const records = await Promise.all(request.items.map((item) => getHistoryStore().open(item.analysis_id)));
    signal.throwIfAborted();
    // Cached analyses from an earlier failed individual export may still be deferred.
    // Retain them as analysis history, without attaching the batch video to each source.
    await Promise.all(records.filter((record) => record.visible_in_history === false)
      .map((record) => getHistoryStore().markVisible(record.id, 'analysis')));
    const skippedAnalysisIds: string[] = [];
    const segments: Array<{ video: VideoMetadata; group: CutGroup }> = [];
    records.forEach((record, index) => {
      let groups: CutGroup[];
      try {
        groups = [...createCutGroups(record.analysis, request.items[index]!.selection)]
          .sort((left, right) => left.start - right.start);
      } catch (error) {
        if (!(error instanceof SelectionError) || !['NO_RALLIES', 'NO_HIGHLIGHTS'].includes(error.code)) throw error;
        groups = [];
      }
      if (!groups.length) skippedAnalysisIds.push(record.id);
      for (const group of groups) segments.push({ video: record.analysis.video, group });
    });
    if (!segments.length) throw new Error('BATCH_EXPORT_EMPTY');
    const components = await resolveUsableMediaComponents();
    if (!components.ffmpeg || !components.ffprobe || components.mediaEncoder === 'unavailable') {
      throw new Error('MEDIA_COMPONENT_MISSING');
    }
    const first = records[0]!;
    const source = first.analysis.source_video?.path ?? first.source.path;
    const profile = batchOutputProfile(first.analysis.video, segments.some((segment) => segment.video.audio_codec !== null));
    const requestedDuration = segments.reduce((sum, segment) => sum + segment.group.end - segment.group.start, 0);
    const durations = segments.map((segment) => batchSegmentDuration(segment.group, profile));
    const duration = durations.reduce((sum, value) => sum + value, 0);
    await assertExportPreconditions(first.analysis.video.path, path.dirname(source), taskId, duration, profile, components.mediaEncoder);
    signal.throwIfAborted();
    temporaryDirectory = await mkdtemp(path.join(path.dirname(source), `.ttcut-batch-${taskId}-`));
    const names: string[] = [];
    let elapsed = 0;
    for (const [index, segment] of segments.entries()) {
      signal.throwIfAborted();
      const name = `segment-${String(index).padStart(6, '0')}.mp4`;
      const segmentPath = path.join(temporaryDirectory, name);
      names.push(name);
      await runFfmpeg(window, taskId, components.ffmpeg,
        buildBatchSegmentArgs(segment.video, profile, segment.group, segmentPath, components.mediaEncoder),
        durations[index]!, 'cutting-and-exporting', { segmentIndex: index + 1 }, {
          startPercent: elapsed / duration * 85,
          endPercent: (elapsed + durations[index]!) / duration * 85,
        });
      await validateExportOutput(segmentPath, { targetSeconds: durations[index]!, segmentCount: 1 }, profile, 'normalized', signal);
      elapsed += durations[index]!;
    }
    const manifest = path.join(temporaryDirectory, 'segments.ffconcat');
    await writeFile(manifest, buildConcatManifest(names, durations), 'utf8');
    const partial = path.join(temporaryDirectory, 'combined.mp4');
    await runFfmpeg(window, taskId, components.ffmpeg, buildConcatArgs(manifest, partial, profile), duration,
      'concatenating', undefined, { startPercent: 85, endPercent: 95 });
    const validation = await validateExportOutput(partial, { targetSeconds: duration, segmentCount: 1 }, profile, 'normalized', signal);
    await validateExportOutput(partial, { targetSeconds: requestedDuration, segmentCount: segments.length }, profile, 'normalized', signal);
    if (Math.abs(validation.metadata.fps - profile.fps) > profile.fps * 0.001) throw new Error('EXPORT_FRAME_RATE_MISMATCH');
    // Decode the entire output, not just its header or first frame, before publishing success.
    await runFfmpeg(window, taskId, components.ffmpeg,
      ['-hide_banner', '-v', 'error', '-xerror', '-i', partial, '-map', '0:v:0', '-map', '0:a?',
        '-f', 'null', '-progress', 'pipe:1', '-nostats', '-'],
      duration, 'validating', undefined, { startPercent: 95, endPercent: 99 });
    signal.throwIfAborted();
    let output: string;
    for (;;) {
      output = await uniqueOutput(source, '合并集锦');
      signal.throwIfAborted();
      try {
        // Both paths are on the output volume. A hard link publishes atomically without
        // overwriting an existing file; non-link filesystems use exclusive copying.
        try { await link(partial, output); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
          await copyFile(partial, output, constants.COPYFILE_EXCL);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (signal.aborted) {
      await rm(output, { force: true });
      signal.throwIfAborted();
    }
    terminal = { type: 'batch-export-result', taskId, data: {
      outputPath: output, mediaUrl: registerMediaPath(output),
      width: profile.width, height: profile.height, skippedAnalysisIds,
    } };
    await logLine(taskId, 'INFO', `Batch export completed: ${output}; segments=${segments.length}; skipped=${skippedAnalysisIds.length}`).catch(() => undefined);
  } catch (error) {
    const message = String(error);
    const code = signal.aborted ? 'EXPORT_CANCELLED'
      : (error as { exportCode?: string }).exportCode ?? (error instanceof Error ? error.message : 'EXPORT_FAILED');
    terminal = { type: 'error', taskId, code, message };
    await logLine(taskId, 'ERROR', `Batch export failed: ${message}`).catch(() => undefined);
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(async (error) => {
      await logLine(taskId, 'WARN', `Could not clean batch temporary files: ${String(error)}`).catch(() => undefined);
    });
    if (signal.aborted && terminal.type === 'batch-export-result') {
      await rm(terminal.data.outputPath, { force: true }).catch(() => undefined);
      terminal = { type: 'error', taskId, code: 'EXPORT_CANCELLED', message: 'Batch export cancelled' };
    }
    clearExportProgress(taskId);
    markTaskTerminal(taskId);
    endTrackedTask(taskId);
  }
  send(window, terminal);
}

export async function startBatchExport(window: BrowserWindow, rawRequest: unknown): Promise<string> {
  const request = batchExportRequestSchema.parse(rawRequest);
  const taskId = randomUUID();
  // Reserve the task slot before asynchronous history/component reads.
  const controller = beginTrackedTask(taskId);
  setImmediate(() => { void executeBatchExport(window, taskId, request, controller.signal); });
  return taskId;
}
