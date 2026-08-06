import { access, mkdir, open, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, type BrowserWindow } from 'electron';
import type { AppEvent } from '../shared/api';
import {
  exportRequestSchema,
  type CutGroup,
  type ExportRequest,
  type ExportTimingInfo,
  type VideoMetadata,
} from '../shared/contracts';
import { IPC } from '../shared/ipc';
import {
  assessFastConcatDuration,
  assessExportDuration,
  type ExportTimingAssessment,
} from '../domain/export-duration';
import { createCutGroups } from '../domain/segments';
import { InvalidCustomSegmentsError, validateAndBuildCustomCutGroups } from '../domain/custom-clips';
import { normalizedVideoRotation } from '../domain/video-input';
import { resolveUsableMediaComponents, type MediaEncoder } from './components';
import { logLine } from './logger';
import { getHistoryStore } from './history';
import {
  buildConcatArgs,
  buildConcatManifest,
  buildSegmentReencodeArgs,
  buildStreamCopyArgs,
  canUseStreamCopy,
  expectedOutputDuration,
  selectSeekStart,
} from './media-plan';
import { registerMediaPath } from './media-protocol';
import {
  probeAudioPacketBoundaries,
  probeKeyframes,
  probeStreamSignature,
  probeVideo,
  sameStreamSignature,
  type StreamSignature,
} from './probe';
import {
  beginTrackedTask,
  classifyProcessExit,
  endTrackedTask,
  getTaskController,
  hasActiveTasks,
  markTaskTerminal,
  spawnTracked,
} from './processes';

const lastExportProgress = new Map<string, number>();
const AV_SYNC_TOLERANCE_SECONDS = 0.1;

type ExportTimingExpectation = {
  targetSeconds: number;
  segmentCount: number;
};

type ExportValidationResult = {
  metadata: VideoMetadata;
  timing: ExportTimingAssessment;
};

class ExportDurationMismatchError extends Error {
  readonly exportCode = 'EXPORT_DURATION_MISMATCH';

  constructor(readonly timing: ExportTimingAssessment) {
    super(
      `EXPORT_DURATION_MISMATCH: target=${timing.targetSeconds.toFixed(6)}`
      + ` actual=${timing.actualSeconds.toFixed(6)}`
      + ` drift=${timing.driftSeconds.toFixed(6)}`
      + ` allowed=${timing.allowedDriftSeconds.toFixed(6)}`
      + ` segments=${timing.segmentCount}`,
    );
    this.name = 'ExportDurationMismatchError';
  }
}

class ExportAvSyncMismatchError extends Error {
  readonly exportCode = 'EXPORT_AV_SYNC_MISMATCH';

  constructor(videoSeconds: number, audioSeconds: number) {
    const deltaSeconds = Math.abs(videoSeconds - audioSeconds);
    super(
      `EXPORT_AV_SYNC_MISMATCH: video=${videoSeconds.toFixed(6)}`
      + ` audio=${audioSeconds.toFixed(6)}`
      + ` delta=${deltaSeconds.toFixed(6)}`
      + ` allowed=${AV_SYNC_TOLERANCE_SECONDS.toFixed(6)}`,
    );
    this.name = 'ExportAvSyncMismatchError';
  }
}

function timingInfo(timing: ExportTimingAssessment): ExportTimingInfo {
  return {
    targetSeconds: timing.targetSeconds,
    actualSeconds: timing.actualSeconds,
    driftSeconds: timing.driftSeconds,
    allowedDriftSeconds: timing.allowedDriftSeconds,
    segmentCount: timing.segmentCount,
  };
}

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

export async function uniqueOutput(input: string, suffixLabel: string): Promise<string> {
  const directory = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let suffix = 1;
  while (true) {
    const stem = `${base}_TTcut_${suffixLabel}`;
    const name = suffix === 1 ? `${stem}.mp4` : `${stem}_${suffix}.mp4`;
    const candidate = path.join(directory, name);
    if (!(await available(candidate))) return candidate;
    suffix += 1;
  }
}

async function uniqueWarningOutput(output: string): Promise<string> {
  const directory = path.dirname(output);
  const base = path.basename(output, path.extname(output));
  let suffix = 1;
  while (true) {
    const stem = `${base}_with_warning`;
    const candidate = path.join(directory, suffix === 1 ? `${stem}.mp4` : `${stem}_${suffix}.mp4`);
    if (!(await available(candidate))) return candidate;
    suffix += 1;
  }
}

export async function retainUsableExportOutput(
  partial: string,
  output: string,
  isUsable: (candidate: string) => Promise<boolean>,
): Promise<{ path: string; renamed: boolean } | null> {
  if (await available(partial)) {
    if (!(await isUsable(partial))) return null;
    const candidate = await available(output) ? await uniqueWarningOutput(output) : output;
    try {
      await rename(partial, candidate);
      return { path: candidate, renamed: true };
    } catch (error) {
      if (await available(partial)) return { path: partial, renamed: false };
      throw error;
    }
  }
  if (await available(output) && await isUsable(output)) return { path: output, renamed: false };
  return null;
}

async function chooseOutput(window: BrowserWindow, input: string, request: ExportRequest): Promise<string> {
  const base = path.basename(input, path.extname(input));
  const label = (request.mode_label ?? request.selection.mode).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (request.destination === 'source') return uniqueOutput(input, label || request.selection.mode);
  const result = await dialog.showSaveDialog(window, {
    title: 'Save TTcut video',
    defaultPath: path.join(path.dirname(input), `${base}_TTcut.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (result.canceled || !result.filePath) throw new Error('EXPORT_CANCELLED');
  return path.extname(result.filePath).toLowerCase() === '.mp4' ? result.filePath : `${result.filePath}.mp4`;
}

async function assertExportPreconditions(
  input: string,
  outputDirectory: string,
  taskId: string,
  duration: number,
  metadata: VideoMetadata,
  encoder: MediaEncoder,
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
    const sourceVideoBitrate = metadata.average_bitrate ?? 8_000_000;
    const estimatedVideoBitrate = encoder === 'libx264'
      ? Math.max(sourceVideoBitrate * 2, metadata.width * metadata.height * metadata.fps * 0.08)
      : sourceVideoBitrate;
    const bitsPerSecond = BigInt(Math.ceil(
      Math.max(1, estimatedVideoBitrate + (metadata.audio_bitrate ?? 192_000)),
    ));
    const payloadBytes = bitsPerSecond * BigInt(Math.ceil(duration)) / 8n;
    const requiredBytes = encoder === 'libx264'
      ? payloadBytes * 2n + 256n * 1024n * 1024n
      : payloadBytes * 2n + 64n * 1024n * 1024n;
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
  detail?: { segmentIndex?: number; seekStart?: number },
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
            const candidate = Math.max(0, Math.min(99.5, seconds / totalDuration * 100));
            const percent = Math.max(lastExportProgress.get(taskId) ?? 0, candidate);
            lastExportProgress.set(taskId, percent);
            send(window, {
              type: 'progress',
              data: {
                taskId,
                kind: 'export',
                stage,
                percent,
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
    child.once('error', (error) => reject(error));
    child.once('close', (code, signal) => {
      const controller = getTaskController(taskId);
      const cancellation = {
        requested: controller?.cancelRequested ?? false,
        reason: controller?.cancelReason ?? null,
      };
      const classification = classifyProcessExit(code, signal, cancellation);
      void logLine(
        taskId,
        classification.kind === 'success' ? 'INFO' : 'ERROR',
        `FFmpeg close: code=${String(code)} signal=${String(signal)} cancelReason=${String(cancellation.reason)}`
          + (detail?.segmentIndex === undefined ? '' : ` segment=${detail.segmentIndex}`)
          + (detail?.seekStart === undefined ? '' : ` seekStart=${detail.seekStart.toFixed(6)}`),
      );
      if (classification.kind === 'success') {
        resolve();
      } else {
        const error = new Error(
          `${classification.code}: exitCode=${String(code)} signal=${String(signal)}`
          + (detail?.segmentIndex === undefined ? '' : ` segment=${detail.segmentIndex}`)
          + (stderrTail.trim() ? `: ${stderrTail.trim()}` : ''),
        );
        (error as Error & {
          exportCode?: string;
          exitCode?: number | null;
          signal?: NodeJS.Signals | null;
          stderrTail?: string;
        }).exportCode = classification.code ?? 'EXPORT_FAILED';
        Object.assign(error, {
          exitCode: code,
          signal,
          stderrTail,
          segmentIndex: detail?.segmentIndex,
        });
        reject(error);
      }
    });
    child.stdin.end();
  });
}

function comparable(value: string | null | undefined): string | null {
  return value && value !== 'unknown' && value !== 'N/A' ? value : null;
}

function timeBaseSeconds(value: string | null | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator) return 0;
  return Math.abs(numerator! / denominator!);
}

function exportTimestampTolerance(metadata: VideoMetadata): number {
  const videoFrameTolerance = metadata.fps > 0 ? 2 / metadata.fps : 0;
  const aacFrameTolerance = metadata.audio_sample_rate
    ? 1024 / metadata.audio_sample_rate
    : 0;
  return Math.max(
    videoFrameTolerance,
    aacFrameTolerance,
    timeBaseSeconds(metadata.video_time_base),
    timeBaseSeconds(metadata.audio_time_base),
  ) + 0.001;
}

export async function validateExportOutput(
  output: string,
  expectation: ExportTimingExpectation,
  source: VideoMetadata,
  orientation: 'preserved' | 'normalized' = 'preserved',
): Promise<ExportValidationResult> {
  const info = await stat(output);
  if (!info.isFile() || info.size < 1024) throw new Error('EXPORT_INVALID');
  const metadata = await probeVideo(output);
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
    && Math.abs(metadata.video_duration_seconds - metadata.audio_duration_seconds)
      > AV_SYNC_TOLERANCE_SECONDS) {
    throw new ExportAvSyncMismatchError(
      metadata.video_duration_seconds,
      metadata.audio_duration_seconds,
    );
  }
  const timestampTolerance = exportTimestampTolerance(metadata);
  const startTimes = [
    metadata.video_start_time_seconds,
    ...(metadata.audio_codec !== null ? [metadata.audio_start_time_seconds] : []),
  ];
  if (startTimes.some(
    (startTime) => startTime !== null
      && startTime !== undefined
      && Math.abs(startTime) > timestampTolerance,
  )) {
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
  const expectedRotation = orientation === 'normalized' ? 0 : normalizedVideoRotation(source.rotation);
  if (Math.abs(normalizedVideoRotation(metadata.rotation) - expectedRotation) > 0.001) {
    throw new Error('EXPORT_ROTATION_MISMATCH');
  }
  const timing = assessExportDuration(
    metadata.duration_seconds,
    expectation.targetSeconds,
    expectation.segmentCount,
    source,
  );
  if (!timing.withinTolerance) throw new ExportDurationMismatchError(timing);
  return { metadata, timing };
}

async function logExportTiming(
  taskId: string,
  label: string,
  timing: ExportTimingAssessment,
  source: VideoMetadata,
): Promise<void> {
  await logLine(
    taskId,
    timing.absoluteDriftSeconds > 0.1 ? 'WARN' : 'INFO',
    `${label}: target=${timing.targetSeconds.toFixed(6)}`
      + ` actual=${timing.actualSeconds.toFixed(6)}`
      + ` drift=${timing.driftSeconds.toFixed(6)}`
      + ` allowed=${timing.allowedDriftSeconds.toFixed(6)}`
      + ` quantum=${timing.quantumSeconds.toFixed(6)}`
      + ` segments=${timing.segmentCount}`
      + ` fps=${source.fps.toFixed(6)}`
      + ` nominalFps=${source.nominal_fps?.toFixed(6) ?? 'null'}`
      + ` vfr=${source.variable_frame_rate}`
      + ` audioSampleRate=${source.audio_sample_rate ?? 'null'}`,
  );
}

async function streamCopyEligibility(
  videoPath: string,
  groups: readonly CutGroup[],
  metadata: VideoMetadata,
  ffprobe: string,
): Promise<boolean> {
  if (groups.length !== 1) return false;
  try {
    const [keyframes, audioBoundaries] = await Promise.all([
      probeKeyframes(videoPath, ffprobe),
      metadata.audio_codec === null ? Promise.resolve([]) : probeAudioPacketBoundaries(videoPath, ffprobe),
    ]);
    return canUseStreamCopy(groups, keyframes, audioBoundaries, metadata);
  } catch {
    return false;
  }
}

function assertExportNotCancelled(taskId: string): void {
  if (getTaskController(taskId)?.cancelRequested) {
    const error = new Error('EXPORT_CANCELLED');
    Object.assign(error, { exportCode: 'EXPORT_CANCELLED' });
    throw error;
  }
}

function exportCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { exportCode?: unknown }).exportCode;
  return typeof code === 'string' ? code : (/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : null);
}

function wrapExportError(error: unknown, code: string): Error {
  const current = exportCode(error);
  if (
    current === 'EXPORT_CANCELLED'
    || current === 'EXPORT_TERMINATED'
    || current === 'EXPORT_SEGMENT_INCOMPATIBLE'
  ) return error instanceof Error ? error : new Error(current);
  const wrapped = new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
  Object.assign(wrapped, { exportCode: code, cause: error });
  return wrapped;
}

async function executeFastSegmented(
  window: BrowserWindow,
  taskId: string,
  components: { ffmpeg: string; ffprobe: string; mediaEncoder: MediaEncoder },
  analysisVideo: VideoMetadata,
  groups: readonly CutGroup[],
  partial: string,
  tempDirectory: string,
): Promise<number[]> {
  const keyframes = await probeKeyframes(analysisVideo.path, components.ffprobe);
  assertExportNotCancelled(taskId);
  const signatures: StreamSignature[] = [];
  const segmentNames: string[] = [];
  const encodedSegmentDurations: number[] = [];
  for (const [index, group] of groups.entries()) {
    assertExportNotCancelled(taskId);
    const seekStart = selectSeekStart(group.start, keyframes);
    const segmentName = `segment-${String(index + 1).padStart(6, '0')}.mp4`;
    const segmentPath = path.join(tempDirectory, segmentName);
    segmentNames.push(segmentName);
    await logLine(
      taskId,
      'INFO',
      `Fast segment ${index + 1}/${groups.length}: range=${group.start.toFixed(6)}-${group.end.toFixed(6)}`
        + ` seekStart=${seekStart.toFixed(6)} encoder=${components.mediaEncoder}`,
    );
    try {
      await runFfmpeg(
        window,
        taskId,
        components.ffmpeg,
        buildSegmentReencodeArgs(
          analysisVideo.path,
          segmentPath,
          group,
          seekStart,
          analysisVideo,
          components.mediaEncoder,
        ),
        group.end - group.start,
        'cutting-and-exporting',
        { segmentIndex: index + 1, seekStart },
      );
      const validation = await validateExportOutput(
        segmentPath,
        { targetSeconds: group.end - group.start, segmentCount: 1 },
        analysisVideo,
        'normalized',
      );
      encodedSegmentDurations.push(
        analysisVideo.audio_codec === null
          ? group.end - group.start
          : validation.metadata.duration_seconds,
      );
      await logExportTiming(taskId, `Fast segment ${index + 1} timing`, validation.timing, analysisVideo);
      const signature = await probeStreamSignature(segmentPath, components.ffprobe);
      if (!signature.video.extradataHash) throw new Error('EXPORT_SEGMENT_FAILED');
      if (signatures.length > 0 && !sameStreamSignature(signatures[0]!, signature)) {
        throw new Error('EXPORT_SEGMENT_INCOMPATIBLE');
      }
      signatures.push(signature);
    } catch (error) {
      throw wrapExportError(error, 'EXPORT_SEGMENT_FAILED');
    }
  }
  assertExportNotCancelled(taskId);
  const manifest = path.join(tempDirectory, 'segments.ffconcat');
  const durationGuardSeconds = Math.max(
    timeBaseSeconds(signatures[0]?.video.timeBase),
    0.000_001,
  );
  await writeFile(
    manifest,
    buildConcatManifest(segmentNames, encodedSegmentDurations, durationGuardSeconds),
    'utf8',
  );
  try {
    await runFfmpeg(
      window,
      taskId,
      components.ffmpeg,
      buildConcatArgs(manifest, partial, analysisVideo),
      expectedOutputDuration(groups),
      'concatenating',
    );
  } catch (error) {
    throw wrapExportError(error, 'EXPORT_CONCAT_FAILED');
  }
  return encodedSegmentDurations;
}

async function executeFastSingle(
  window: BrowserWindow,
  taskId: string,
  components: { ffmpeg: string; ffprobe: string; mediaEncoder: MediaEncoder },
  analysisVideo: VideoMetadata,
  group: CutGroup,
  partial: string,
): Promise<ExportValidationResult> {
  const keyframes = await probeKeyframes(analysisVideo.path, components.ffprobe);
  assertExportNotCancelled(taskId);
  const seekStart = selectSeekStart(group.start, keyframes);
  await logLine(
    taskId,
    'INFO',
    `Fast single segment: range=${group.start.toFixed(6)}-${group.end.toFixed(6)}`
      + ` seekStart=${seekStart.toFixed(6)} encoder=${components.mediaEncoder}`,
  );
  try {
    await runFfmpeg(
      window,
      taskId,
      components.ffmpeg,
      buildSegmentReencodeArgs(
        analysisVideo.path,
        partial,
        group,
        seekStart,
        analysisVideo,
        components.mediaEncoder,
      ),
      group.end - group.start,
      'cutting-and-exporting',
      { segmentIndex: 1, seekStart },
    );
  } catch (error) {
    throw wrapExportError(error, 'EXPORT_SEGMENT_FAILED');
  }
  const validation = await validateExportOutput(
    partial,
    { targetSeconds: group.end - group.start, segmentCount: 1 },
    analysisVideo,
    'normalized',
  );
  await logExportTiming(taskId, 'Fast single timing', validation.timing, analysisVideo);
  return validation;
}

async function executeExport(
  window: BrowserWindow,
  taskId: string,
  request: ExportRequest,
  record: Awaited<ReturnType<ReturnType<typeof getHistoryStore>['open']>>,
  components: { ffmpeg: string; ffprobe: string; mediaEncoder: MediaEncoder },
  groups: readonly CutGroup[],
  output: string,
  partial: string,
  duration: number,
): Promise<void> {
  const analysis = record.analysis;
  const highResolution = analysis.video.width > 4096 || analysis.video.height > 2160;
  const tempDirectory = path.join(path.dirname(output), `.ttcut-${taskId}-segments`);
  let terminalSent = false;
  let finalTiming: ExportTimingAssessment | null = null;
  const sendError = async (code: string, message: string): Promise<void> => {
    if (terminalSent || !markTaskTerminal(taskId)) return;
    terminalSent = true;
    send(window, { type: 'error', taskId, code, message });
  };
  try {
    await mkdir(tempDirectory, { recursive: true });
    const requestedBudget = assessExportDuration(duration, duration, groups.length, analysis.video);
    await logExportTiming(taskId, 'Export timing budget (fast segmented)', requestedBudget, analysis.video);
    const canCopy = await streamCopyEligibility(
      analysis.video.path,
      groups,
      analysis.video,
      components.ffprobe,
    );
    assertExportNotCancelled(taskId);
    if (!canCopy && highResolution && components.mediaEncoder !== 'libx264') {
      throw new Error('X264_COMPONENT_REQUIRED_FOR_HIGH_RESOLUTION');
    }
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
        const validation = await validateExportOutput(
          partial,
          { targetSeconds: duration, segmentCount: 1 },
          analysis.video,
        );
        finalTiming = validation.timing;
        await logExportTiming(taskId, 'Stream-copy final timing', validation.timing, analysis.video);
      } catch (error) {
        const code = exportCode(error);
        if (code === 'EXPORT_CANCELLED' || code === 'EXPORT_TERMINATED') throw error;
        await logLine(taskId, 'WARN', `Stream copy rejected; accurate encode follows: ${String(error)}`);
        await rm(partial, { force: true });
        const validation = await executeFastSingle(
          window,
          taskId,
          components,
          analysis.video,
          groups[0]!,
          partial,
        );
        finalTiming = validation.timing;
      }
    } else if (groups.length > 1) {
      const encodedSegmentDurations = await executeFastSegmented(
        window,
        taskId,
        components,
        analysis.video,
        groups,
        partial,
        tempDirectory,
      );
      const encodedSegmentDuration = encodedSegmentDurations.reduce(
        (total, segmentDuration) => total + segmentDuration,
        0,
      );
      const concatValidation = await validateExportOutput(
        partial,
        {
          targetSeconds: encodedSegmentDuration,
          segmentCount: 1,
        },
        analysis.video,
        'normalized',
      );
      await logExportTiming(taskId, 'Fast concat timing', concatValidation.timing, analysis.video);
      const requestedTiming = assessFastConcatDuration(
        concatValidation.metadata.duration_seconds,
        encodedSegmentDurations,
        duration,
        analysis.video,
      ).requestedClips;
      if (!requestedTiming.withinTolerance) throw new ExportDurationMismatchError(requestedTiming);
      finalTiming = requestedTiming;
      await logExportTiming(taskId, 'Fast final requested timing', requestedTiming, analysis.video);
    } else {
      const validation = await executeFastSingle(
        window,
        taskId,
        components,
        analysis.video,
        groups[0]!,
        partial,
      );
      finalTiming = validation.timing;
    }
    if (!finalTiming) throw new Error('EXPORT_INVALID');
    if (await available(output)) throw new Error('OUTPUT_COLLISION');
    await rename(partial, output);
    const result = {
      taskId,
      analysisId: record.id,
      outputPath: output,
      outputName: path.basename(output),
      mediaUrl: registerMediaPath(output),
      timing: timingInfo(finalTiming),
    };
    send(window, { type: 'progress', data: { taskId, kind: 'export', stage: 'complete', percent: 100 } });
    lastExportProgress.set(taskId, 100);
    await getHistoryStore().markVisible(record.id, 'export', output);
    if (!terminalSent && markTaskTerminal(taskId)) {
      terminalSent = true;
      send(window, { type: 'export-result', taskId, data: result });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = exportCode(error) ?? 'EXPORT_FAILED';
    const controller = getTaskController(taskId);
    const cancelledForExit = code === 'EXPORT_CANCELLED' && controller?.cancelReason === 'app-exit';
    await logLine(taskId, cancelledForExit ? 'INFO' : 'ERROR', `${code}: ${message}`);

    if (code !== 'EXPORT_CANCELLED') {
      try {
        const retained = await retainUsableExportOutput(partial, output, async (candidate) => {
          try {
            await probeVideo(candidate);
            return true;
          } catch (probeError) {
            await logLine(taskId, 'WARN', `Generated output is not playable and will not be retained: ${String(probeError)}`);
            return false;
          }
        });
        if (retained) {
          const recoveredMetadata = await probeVideo(retained.path);
          const recoveredTiming = error instanceof ExportDurationMismatchError
            ? error.timing
            : finalTiming ?? assessExportDuration(
              recoveredMetadata.duration_seconds,
              duration,
              groups.length,
              analysis.video,
            );
          if (!retained.renamed && retained.path === partial) {
            await logLine(taskId, 'WARN', 'Could not rename usable warning output; original partial retained');
          }
          await logLine(taskId, 'WARN', `Retained usable output after ${code}: ${retained.path}`);
          await getHistoryStore().markVisible(record.id, 'export', retained.path).catch(async (historyError) => {
            await logLine(taskId, 'WARN', `Could not update export history after recovery: ${String(historyError)}`);
          });
          const result = {
            taskId,
            analysisId: record.id,
            outputPath: retained.path,
            outputName: path.basename(retained.path),
            mediaUrl: registerMediaPath(retained.path),
            timing: timingInfo(recoveredTiming),
            warning: { code, message },
          };
          send(window, { type: 'progress', data: { taskId, kind: 'export', stage: 'complete', percent: 100 } });
          lastExportProgress.set(taskId, 100);
          if (!terminalSent && markTaskTerminal(taskId)) {
            terminalSent = true;
            send(window, { type: 'export-result', taskId, data: result });
          }
          return;
        }
      } catch (recoveryError) {
        await logLine(taskId, 'WARN', `Could not retain usable warning output: ${String(recoveryError)}`);
      }
    }

    await rm(partial, { force: true }).catch(() => undefined);
    if (!cancelledForExit) {
      await sendError(code, message);
    } else {
      markTaskTerminal(taskId);
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    lastExportProgress.delete(taskId);
    endTrackedTask(taskId);
  }
}

export async function startExport(window: BrowserWindow, rawRequest: ExportRequest): Promise<string> {
  const parsedRequest = exportRequestSchema.safeParse(rawRequest);
  if (!parsedRequest.success) {
    if ((rawRequest as { selection?: { mode?: unknown } })?.selection?.mode === 'custom') {
      throw new InvalidCustomSegmentsError();
    }
    throw parsedRequest.error;
  }
  const request = parsedRequest.data;
  const selection = request.selection;
  const record = await getHistoryStore().open(request.analysis_id);
  const analysis = record.analysis;
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  const groups = selection.mode === 'custom'
    ? validateAndBuildCustomCutGroups(analysis, selection.segments)
    : [...createCutGroups(analysis, selection)].sort((left, right) => left.start - right.start);
  if (!groups.length) throw new Error('NO_RALLIES');
  const components = await resolveUsableMediaComponents();
  if (!components.ffmpeg || !components.ffprobe || components.mediaEncoder === 'unavailable') throw new Error('MEDIA_COMPONENT_MISSING');
  const taskId = randomUUID();
  const output = await chooseOutput(window, analysis.video.path, request);
  const partial = path.join(path.dirname(output), `.${path.basename(output, '.mp4')}.${taskId}.partial.mp4`);
  const duration = expectedOutputDuration(groups);
  beginTrackedTask(taskId);
  try {
    await assertExportPreconditions(analysis.video.path, path.dirname(output), taskId, duration, analysis.video, components.mediaEncoder);
    send(window, { type: 'progress', data: { taskId, kind: 'export', stage: 'preparing', percent: 0 } });
    await logLine(taskId, 'INFO', `Export target: ${output}`);
    await logLine(taskId, 'INFO', 'Export strategy: fast segmented');
    await logLine(taskId, 'INFO', `Active media encoder: ${components.mediaEncoder}`);
    void executeExport(
      window,
      taskId,
      request,
      record,
      { ffmpeg: components.ffmpeg!, ffprobe: components.ffprobe!, mediaEncoder: components.mediaEncoder },
      groups,
      output,
      partial,
      duration,
    );
    return taskId;
  } catch (error) {
    endTrackedTask(taskId);
    throw error;
  }
}
