import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisResultV1, VideoMetadata } from '../shared/contracts';
import { buildCfrNormalizationArgs, normalizedSar } from './media-plan';
import { managedComponentsRoot, type MediaEncoder } from './components';
import { getTaskController, spawnTracked } from './processes';
import { probeVideo } from './probe';

const PROCESSING_MEDIA_VERSION = 'v1';
const CFR_CACHE_SCHEMA_VERSION = 1;
const CFR_STRATEGY_VERSION = 1;
const AV_SYNC_TOLERANCE_SECONDS = 0.1;

export type ProcessingMediaMode = 'source_cfr' | 'normalized_cfr' | 'original_vfr' | 'vfr_fallback';

export type ProcessingMediaOutcome = {
  metadata: VideoMetadata;
  mode: ProcessingMediaMode;
  targetFpsRatio: string | null;
  encoder: MediaEncoder | null;
  warningCode: string | null;
  cachePath: string | null;
  cacheKey: string | null;
  cacheCreated: boolean;
};

export class CfrNormalizationError extends Error {
  readonly code: string;
  readonly cancelled: boolean;

  constructor(code: string, message = code, cancelled = false) {
    super(message);
    this.name = 'CfrNormalizationError';
    this.code = code;
    this.cancelled = cancelled;
  }
}

export type SourceIdentity = {
  path: string;
  size: number;
  modified_time_ms: number;
};

type CacheManifest = {
  schema_version: number;
  strategy_version: number;
  cache_key: string;
  source: SourceIdentity;
  target_fps_ratio: string;
  encoder: MediaEncoder;
  media_filename: 'media.mp4';
};

function processingMediaRoot(): string {
  return path.join(path.dirname(managedComponentsRoot()), 'processing-media', PROCESSING_MEDIA_VERSION);
}

function normalizedIdentityPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return normalizedIdentityPath(left.path) === normalizedIdentityPath(right.path)
    && left.size === right.size
    && left.modified_time_ms === right.modified_time_ms;
}

function validRatio(value: string | null | undefined): boolean {
  if (!value || !/^\d+\/\d+$/.test(value)) return false;
  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
    && numerator > 0 && denominator > 0;
}

function decimalRatio(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new CfrNormalizationError('CFR_TARGET_FPS_INVALID');
  const fixed = value.toFixed(6);
  const [whole, fraction = ''] = fixed.split('.');
  const denominator = 10 ** fraction.length;
  const numerator = Number(`${whole}${fraction}`);
  const gcd = (left: number, right: number): number => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b) {
      const next = a % b;
      a = b;
      b = next;
    }
    return a || 1;
  };
  const divisor = gcd(numerator, denominator);
  return `${numerator / divisor}/${denominator / divisor}`;
}

export function targetFrameRateRatio(metadata: VideoMetadata): string {
  if (validRatio(metadata.nominal_fps_ratio)) return metadata.nominal_fps_ratio!;
  if (validRatio(metadata.average_fps_ratio)) return metadata.average_fps_ratio!;
  return decimalRatio(metadata.nominal_fps ?? metadata.fps);
}

async function sourceIdentity(metadata: VideoMetadata): Promise<SourceIdentity> {
  const source = await stat(metadata.path).catch(() => null);
  if (!source?.isFile() || source.size <= 0) throw new CfrNormalizationError('INPUT_MOVED');
  return {
    path: path.resolve(metadata.path),
    size: source.size,
    modified_time_ms: source.mtimeMs,
  };
}

export function processingMediaCacheKey(source: SourceIdentity, targetFpsRatio: string, encoder: MediaEncoder): string {
  return createHash('sha256').update(JSON.stringify({
    version: PROCESSING_MEDIA_VERSION,
    strategy_version: CFR_STRATEGY_VERSION,
    source: {
      ...source,
      path: normalizedIdentityPath(source.path),
    },
    target_fps_ratio: targetFpsRatio,
    encoder,
  })).digest('hex');
}

const cacheKey = processingMediaCacheKey;

function cacheDirectory(key: string): string {
  return path.join(processingMediaRoot(), key);
}

function cacheMediaPath(key: string): string {
  return path.join(cacheDirectory(key), 'media.mp4');
}

async function availableBytes(directory: string): Promise<bigint | null> {
  try {
    const filesystem = await statfs(directory, { bigint: true });
    return filesystem.bavail * filesystem.bsize;
  } catch {
    return null;
  }
}

async function ensureProcessingSpace(root: string, metadata: VideoMetadata): Promise<void> {
  await mkdir(root, { recursive: true });
  const available = await availableBytes(root);
  if (available === null) return;
  const bitrate = BigInt(Math.max(1_000_000, metadata.average_bitrate ?? 8_000_000));
  const duration = BigInt(Math.max(1, Math.ceil(metadata.duration_seconds)));
  const estimated = bitrate * duration / 8n * 2n + 256n * 1024n * 1024n;
  if (available < estimated) throw new CfrNormalizationError('CFR_SPACE_INSUFFICIENT');
}

async function runNormalizationProcess(
  taskId: string,
  executable: string,
  args: string[],
  durationSeconds: number,
  abortSignal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true));
      return;
    }
    const child = spawnTracked(taskId, executable, args);
    const abort = () => { if (!child.killed) child.kill('SIGTERM'); };
    abortSignal.addEventListener('abort', abort, { once: true });
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
          if (Number.isFinite(seconds) && durationSeconds > 0) {
            onProgress(Math.max(0, Math.min(100, seconds / durationSeconds * 100)));
          }
        }
      }
    });
    child.stderr.on('data', (chunk: string) => { stderrTail = `${stderrTail}${chunk}`.slice(-16_384); });
    child.once('error', (error) => {
      abortSignal.removeEventListener('abort', abort);
      reject(abortSignal.aborted
        ? new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true)
        : new CfrNormalizationError('CFR_TRANSCODE_FAILED', error.message));
    });
    child.once('close', (code, exitSignal) => {
      abortSignal.removeEventListener('abort', abort);
      const controller = getTaskController(taskId);
      if (controller?.cancelRequested || abortSignal.aborted) {
        reject(new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true));
      } else if (code === 0 && exitSignal === null) {
        onProgress(100);
        resolve();
      } else {
        const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : '';
        reject(new CfrNormalizationError('CFR_TRANSCODE_FAILED', `FFmpeg exited with ${String(code)}${detail}`));
      }
    });
    child.stdin.end();
  });
}

async function validateCfrMedia(
  outputPath: string,
  source: VideoMetadata,
  targetFpsRatio: string,
  signal: AbortSignal,
): Promise<VideoMetadata> {
  const output = await stat(outputPath).catch(() => null);
  if (!output?.isFile() || output.size < 1024) throw new CfrNormalizationError('CFR_OUTPUT_INVALID');
  const metadata = await probeVideo(outputPath, signal);
  if (metadata.variable_frame_rate) throw new CfrNormalizationError('CFR_OUTPUT_NOT_CONSTANT');
  if (Math.abs(metadata.duration_seconds - source.duration_seconds) > AV_SYNC_TOLERANCE_SECONDS) {
    throw new CfrNormalizationError('CFR_DURATION_MISMATCH');
  }
  const startTimes = [
    metadata.video_start_time_seconds,
    ...(metadata.audio_codec !== null ? [metadata.audio_start_time_seconds] : []),
  ].filter((value): value is number => value !== null && value !== undefined);
  if (startTimes.some((value) => Math.abs(value) > 0.05)) {
    throw new CfrNormalizationError('CFR_TIMESTAMP_INVALID');
  }
  if (metadata.width !== source.width || metadata.height !== source.height) {
    throw new CfrNormalizationError('CFR_RESOLUTION_MISMATCH');
  }
  if (metadata.rotation != null && Math.abs(metadata.rotation) > 0.5) {
    throw new CfrNormalizationError('CFR_ROTATION_MISMATCH');
  }
  if (normalizedSar(metadata.sample_aspect_ratio) !== normalizedSar(source.sample_aspect_ratio)) {
    throw new CfrNormalizationError('CFR_SAR_MISMATCH');
  }
  for (const [sourceColor, outputColor] of [
    [source.color_range, metadata.color_range],
    [source.color_space, metadata.color_space],
    [source.color_transfer, metadata.color_transfer],
    [source.color_primaries, metadata.color_primaries],
  ] as Array<[string | null | undefined, string | null | undefined]>) {
    if (sourceColor && sourceColor !== 'unknown' && outputColor !== sourceColor) {
      throw new CfrNormalizationError('CFR_COLOR_METADATA_MISMATCH');
    }
  }
  if (metadata.video_codec !== 'h264') throw new CfrNormalizationError('CFR_CODEC_UNSUPPORTED');
  if ((source.audio_codec !== null) !== (metadata.audio_codec !== null)) {
    throw new CfrNormalizationError('CFR_AUDIO_MISSING');
  }
  if (source.audio_codec !== null && metadata.audio_codec !== 'aac') {
    throw new CfrNormalizationError('CFR_AUDIO_CODEC_UNSUPPORTED');
  }
  const [numerator, denominator] = targetFpsRatio.split('/').map(Number);
  const targetFps = (numerator ?? 0) / (denominator ?? 1);
  if (!Number.isFinite(targetFps) || targetFps <= 0 || Math.abs(metadata.fps - targetFps) / targetFps > 0.001) {
    throw new CfrNormalizationError('CFR_FRAME_RATE_MISMATCH');
  }
  if (metadata.video_duration_seconds != null && metadata.audio_duration_seconds != null
    && Math.abs(metadata.video_duration_seconds - metadata.audio_duration_seconds) > AV_SYNC_TOLERANCE_SECONDS) {
    throw new CfrNormalizationError('CFR_AV_SYNC_MISMATCH');
  }
  return metadata;
}

async function readValidCache(
  source: SourceIdentity,
  sourceMetadata: VideoMetadata,
  targetFpsRatio: string,
  encoder: MediaEncoder,
  signal: AbortSignal,
): Promise<{ key: string; path: string; metadata: VideoMetadata } | null> {
  const key = cacheKey(source, targetFpsRatio, encoder);
  const directory = cacheDirectory(key);
  const mediaPath = cacheMediaPath(key);
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as CacheManifest;
    if (manifest.schema_version !== CFR_CACHE_SCHEMA_VERSION
      || manifest.strategy_version !== CFR_STRATEGY_VERSION
      || manifest.cache_key !== key
      || manifest.target_fps_ratio !== targetFpsRatio
      || manifest.encoder !== encoder
      || manifest.media_filename !== 'media.mp4'
      || !sameSource(manifest.source, source)) return null;
    const metadata = await validateCfrMedia(mediaPath, sourceMetadata, targetFpsRatio, signal).catch(() => null);
    if (!metadata) return null;
    return { key, path: mediaPath, metadata };
  } catch {
    return null;
  }
}

function safeIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function processingCachePath(analysis: AnalysisResultV1): string | null {
  if (analysis.processing?.mode !== 'normalized_cfr') return null;
  const mediaPath = path.resolve(analysis.video.path);
  let root: string;
  try {
    root = processingMediaRoot();
  } catch {
    return null;
  }
  return safeIsInside(root, mediaPath) && path.basename(mediaPath).toLowerCase() === 'media.mp4'
    ? path.dirname(mediaPath)
    : null;
}

export async function removeProcessingCache(analysis: AnalysisResultV1): Promise<void> {
  const directory = processingCachePath(analysis);
  if (directory) await rm(directory, { recursive: true, force: true });
}

export async function clearProcessingMediaCache(): Promise<void> {
  let root: string;
  try {
    root = processingMediaRoot();
  } catch {
    return;
  }
  await rm(root, { recursive: true, force: true });
}

export function retainOriginalVfrMedia(source: VideoMetadata): ProcessingMediaOutcome {
  return {
    metadata: source,
    mode: 'original_vfr',
    targetFpsRatio: null,
    encoder: null,
    warningCode: null,
    cachePath: null,
    cacheKey: null,
    cacheCreated: false,
  };
}

export async function prepareProcessingMedia(
  taskId: string,
  source: VideoMetadata,
  encoder: MediaEncoder,
  ffmpeg: string,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
): Promise<ProcessingMediaOutcome> {
  if (signal.aborted) {
    throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
  }
  if (!source.variable_frame_rate) {
    return {
      metadata: source,
      mode: 'source_cfr',
      targetFpsRatio: source.nominal_fps_ratio ?? source.average_fps_ratio ?? null,
      encoder: null,
      warningCode: null,
      cachePath: null,
      cacheKey: null,
      cacheCreated: false,
    };
  }
  const targetFpsRatio = targetFrameRateRatio(source);
  const identity = await sourceIdentity(source);
  const root = processingMediaRoot();
  const cached = await readValidCache(identity, source, targetFpsRatio, encoder, signal);
  if (signal.aborted) {
    throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
  }
  if (cached) {
    onProgress(100);
    return {
      metadata: cached.metadata,
      mode: 'normalized_cfr',
      targetFpsRatio,
      encoder,
      warningCode: null,
      cachePath: cached.path,
      cacheKey: cached.key,
      cacheCreated: false,
    };
  }

  const key = cacheKey(identity, targetFpsRatio, encoder);
  const directory = cacheDirectory(key);
  const stagingDirectory = path.join(root, `.${key}.${taskId}.partial`);
  const partialPath = path.join(stagingDirectory, 'media.mp4');
  const mediaPath = cacheMediaPath(key);
  const backupDirectory = path.join(root, `.${key}.${taskId}.backup`);
  let existingDirectoryMoved = false;
  try {
    await ensureProcessingSpace(root, source);
    if (signal.aborted) {
      throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(backupDirectory, { recursive: true, force: true });
    await mkdir(stagingDirectory, { recursive: true });
    await runNormalizationProcess(
      taskId,
      ffmpeg,
      buildCfrNormalizationArgs(source.path, partialPath, source, targetFpsRatio, encoder),
      source.duration_seconds,
      signal,
      onProgress,
    );
    const metadata = await validateCfrMedia(partialPath, source, targetFpsRatio, signal);
    if (signal.aborted) {
      throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
    }
    const manifest: CacheManifest = {
      schema_version: CFR_CACHE_SCHEMA_VERSION,
      strategy_version: CFR_STRATEGY_VERSION,
      cache_key: key,
      source: identity,
      target_fps_ratio: targetFpsRatio,
      encoder,
      media_filename: 'media.mp4',
    };
    const manifestPath = path.join(stagingDirectory, 'manifest.json');
    const manifestPartialPath = path.join(stagingDirectory, `.${taskId}.partial.json`);
    await writeFile(manifestPartialPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(manifestPartialPath, manifestPath);
    const existingDirectory = await stat(directory).catch(() => null);
    if (existingDirectory) {
      await rename(directory, backupDirectory);
      existingDirectoryMoved = true;
    }
    try {
      await rename(stagingDirectory, directory);
    } catch (error) {
      if (existingDirectoryMoved) {
        await rename(backupDirectory, directory).catch(() => undefined);
        existingDirectoryMoved = false;
      }
      throw error;
    }
    if (existingDirectoryMoved) {
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
      existingDirectoryMoved = false;
    }
    return {
      metadata,
      mode: 'normalized_cfr',
      targetFpsRatio,
      encoder,
      warningCode: null,
      cachePath: mediaPath,
      cacheKey: key,
      cacheCreated: true,
    };
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (existingDirectoryMoved) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      await rename(backupDirectory, directory).catch(() => undefined);
    }
    if (error instanceof CfrNormalizationError) throw error;
    throw new CfrNormalizationError('CFR_TRANSCODE_FAILED', error instanceof Error ? error.message : String(error));
  }
}
