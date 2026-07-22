import { access, open, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { AppEvent } from '../shared/api';
import { cutSelectionSchema, type CutGroup, type CutSelectionV1, type VideoMetadata } from '../shared/contracts';
import { IPC } from '../shared/ipc';
import { createCutGroups } from '../domain/segments';
import { resolveComponents, validateMediaComponent } from './components';
import { getLatestAnalysis } from './analysis';
import { logLine } from './logger';
import {
  buildReencodeArgs,
  buildStreamCopyArgs,
  canUseStreamCopy,
  expectedOutputDuration,
} from './media-plan';
import { registerMediaPath } from './media-protocol';
import { probeAudioPacketBoundaries, probeKeyframes, probeVideo } from './probe';
import { hasActiveTasks, spawnTracked } from './processes';
import { isExportDurationWithinTolerance } from '../domain/export-duration';

function send(window: BrowserWindow, event: AppEvent): void {
  if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
}

async function available(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function chooseOutput(input: string): Promise<string> {
  const directory = path.dirname(input);
  const extension = path.extname(input);
  const base = path.basename(input, extension);
  let suffix = 1;
  while (true) {
    const name = suffix === 1 ? `${base}_ttcut${extension}` : `${base}_ttcut_${suffix}${extension}`;
    const candidate = path.join(directory, name);
    if (!(await available(candidate))) return candidate;
    suffix += 1;
  }
}

async function assertExportPreconditions(
  input: string,
  outputDirectory: string,
  taskId: string,
  duration: number,
  metadata: VideoMetadata,
): Promise<void> {
  const inputInfo = await stat(input).catch(() => null);
  if (!inputInfo?.isFile() || inputInfo.size <= 0) throw new Error('INPUT_MOVED');

  const writeProbe = path.join(outputDirectory, `.ttcut-${taskId}.write-test`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(writeProbe, 'wx');
  } catch {
    throw new Error('OUTPUT_DIRECTORY_UNWRITABLE');
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(writeProbe, { force: true }).catch(() => undefined);
  }

  try {
    const filesystem = await statfs(outputDirectory, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    const bitsPerSecond = BigInt(
      Math.max(1, (metadata.average_bitrate ?? 8_000_000) + (metadata.audio_bitrate ?? 192_000)),
    );
    const payloadBytes = bitsPerSecond * BigInt(Math.ceil(duration)) / 8n;
    const requiredBytes = payloadBytes * 2n + 64n * 1024n * 1024n;
    if (availableBytes < requiredBytes) throw new Error('DISK_SPACE_LOW');
  } catch (error) {
    if (error instanceof Error && error.message === 'DISK_SPACE_LOW') throw error;
    // Some filesystems do not expose statfs on Windows; the write probe remains authoritative.
  }
}

async function runFfmpeg(
  window: BrowserWindow,
  taskId: string,
  executable: string,
  args: string[],
  totalDuration: number,
  stage: string,
): Promise<void> {
  await logLine(taskId, 'INFO', `FFmpeg arguments: ${JSON.stringify(args)}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawnTracked(taskId, executable, args);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdoutBuffer = '';
    let stderrTail = '';
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const [key, raw] = line.split('=', 2);
        if ((key === 'out_time_us' || key === 'out_time_ms') && raw) {
          const seconds = Number(raw) / 1_000_000;
          if (Number.isFinite(seconds)) {
            send(window, {
              type: 'progress',
              data: {
                taskId,
                kind: 'export',
                stage,
                percent: Math.max(0, Math.min(99.5, seconds / totalDuration * 100)),
              },
            });
          }
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-16_384);
      void logLine(taskId, 'FFMPEG', chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code ?? -1}: ${stderrTail.trim()}`));
    });
    child.stdin.end();
  });
}

function comparable(value: string | null | undefined): string | null {
  return value && value !== 'unknown' && value !== 'N/A' ? value : null;
}

export async function validateExportOutput(
  output: string,
  wantedDuration: number,
  source: VideoMetadata,
): Promise<VideoMetadata> {
  const info = await stat(output);
  if (!info.isFile() || info.size < 1024) throw new Error('EXPORT_INVALID');
  const metadata = await probeVideo(output);
  if (!isExportDurationWithinTolerance(metadata.duration_seconds, wantedDuration)) {
    throw new Error('EXPORT_DURATION_MISMATCH');
  }
  if (metadata.width !== source.width || metadata.height !== source.height) {
    throw new Error('EXPORT_RESOLUTION_MISMATCH');
  }
  if (metadata.video_codec !== 'h264') throw new Error('EXPORT_CODEC_UNSUPPORTED');
  if ((source.audio_codec !== null) !== (metadata.audio_codec !== null)) {
    throw new Error('EXPORT_AUDIO_MISSING');
  }
  if (source.audio_codec !== null && metadata.audio_codec !== 'aac') {
    throw new Error('EXPORT_AUDIO_CODEC_UNSUPPORTED');
  }
  if (metadata.video_duration_seconds !== null && metadata.video_duration_seconds !== undefined
    && metadata.audio_duration_seconds !== null && metadata.audio_duration_seconds !== undefined
    && Math.abs(metadata.video_duration_seconds - metadata.audio_duration_seconds) > 0.1) {
    throw new Error('EXPORT_AV_SYNC_MISMATCH');
  }
  if (Math.abs(metadata.video_start_time_seconds ?? 0) > 1 / metadata.fps + 0.001) {
    throw new Error('EXPORT_TIMESTAMP_INVALID');
  }
  const fields: Array<keyof Pick<VideoMetadata,
    'sample_aspect_ratio' | 'color_range' | 'color_space' | 'color_transfer' | 'color_primaries'>> = [
      'sample_aspect_ratio', 'color_range', 'color_space', 'color_transfer', 'color_primaries',
    ];
  for (const field of fields) {
    const expected = comparable(source[field]);
    if (expected && comparable(metadata[field]) !== expected) throw new Error(`EXPORT_METADATA_MISMATCH:${field}`);
  }
  if (source.rotation !== null && source.rotation !== undefined
    && metadata.rotation !== source.rotation) throw new Error('EXPORT_ROTATION_MISMATCH');
  return metadata;
}

async function streamCopyEligibility(
  videoPath: string,
  groups: readonly CutGroup[],
  metadata: VideoMetadata,
): Promise<boolean> {
  try {
    const [keyframes, audioBoundaries] = await Promise.all([
      probeKeyframes(videoPath),
      metadata.audio_codec === null ? Promise.resolve([]) : probeAudioPacketBoundaries(videoPath),
    ]);
    return canUseStreamCopy(groups, keyframes, audioBoundaries, metadata);
  } catch {
    return false;
  }
}

export async function startExport(window: BrowserWindow, rawSelection: CutSelectionV1): Promise<string> {
  const selection = cutSelectionSchema.parse(rawSelection);
  const analysis = getLatestAnalysis();
  if (!analysis) throw new Error('NO_ANALYSIS');
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  const groups = createCutGroups(analysis, selection);
  if (!groups.length) throw new Error('NO_RALLIES');
  const components = await resolveComponents();
  if (!components.ffmpeg || !components.ffprobe) throw new Error('MEDIA_COMPONENT_MISSING');
  await validateMediaComponent(components.ffmpeg, components.ffprobe);
  const taskId = randomUUID();
  const output = await chooseOutput(analysis.video.path);
  const partial = path.join(path.dirname(output), `.${path.basename(output, '.mp4')}.${taskId}.partial.mp4`);
  const duration = expectedOutputDuration(groups);
  send(window, { type: 'progress', data: { taskId, kind: 'export', stage: 'preparing', percent: 0 } });
  await logLine(taskId, 'INFO', `Export target: ${output}`);
  try {
    await assertExportPreconditions(analysis.video.path, path.dirname(output), taskId, duration, analysis.video);
    const canCopy = await streamCopyEligibility(analysis.video.path, groups, analysis.video);
    if (canCopy) {
      try {
        await runFfmpeg(
          window,
          taskId,
          components.ffmpeg,
          buildStreamCopyArgs(analysis.video.path, partial, groups[0]!),
          duration,
          'cutting',
        );
        await validateExportOutput(partial, duration, analysis.video);
      } catch (error) {
        await logLine(taskId, 'WARN', `Stream copy rejected; accurate encode follows: ${String(error)}`);
        await rm(partial, { force: true });
        await runFfmpeg(
          window,
          taskId,
          components.ffmpeg,
          buildReencodeArgs(analysis.video.path, partial, groups, analysis.video),
          duration,
          'cutting-and-exporting',
        );
        await validateExportOutput(partial, duration, analysis.video);
      }
    } else {
      await runFfmpeg(
        window,
        taskId,
        components.ffmpeg,
        buildReencodeArgs(analysis.video.path, partial, groups, analysis.video),
        duration,
        'cutting-and-exporting',
      );
      await validateExportOutput(partial, duration, analysis.video);
    }
    if (await available(output)) throw new Error('OUTPUT_COLLISION');
    await rename(partial, output);
    const result = {
      taskId,
      outputPath: output,
      outputName: path.basename(output),
      mediaUrl: registerMediaPath(output),
    };
    send(window, { type: 'progress', data: { taskId, kind: 'export', stage: 'complete', percent: 100 } });
    send(window, { type: 'export-result', taskId, data: result });
    return taskId;
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await logLine(taskId, 'ERROR', message);
    send(window, { type: 'error', taskId, code: 'EXPORT_FAILED', message });
    return taskId;
  }
}
