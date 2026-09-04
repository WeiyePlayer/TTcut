import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, access } from 'node:fs/promises';
import { nativeVideoSchema, type NativeEvent } from '../../shared/native-contracts';
import { type VideoMetadata, videoMetadataSchema } from '../../shared/contracts';
import { getTaskController, spawnTracked, terminateChild, trackBackgroundProcess } from '../processes';
import { logLine } from '../logger';
import { macRuntimeRoot, verifyMacRuntime } from './runtime';
import { NativeReplyReader } from './protocol';

export async function callNative(worker: 'TTcutWorker' | 'TTcutMediaWorker', request: Record<string, unknown>, options: {
  taskId?: string; signal?: AbortSignal | undefined; onProgress?: (event: NativeEvent) => void;
} = {}): Promise<NativeEvent> {
  await verifyMacRuntime();
  const taskId = options.taskId ?? randomUUID();
  const controller = options.taskId ? getTaskController(options.taskId) : undefined;
  const signal = options.signal ?? controller?.signal;
  if (signal?.aborted) throw Object.assign(new Error('PROCESS_CANCELLED'), { code: 'PROCESS_CANCELLED' });
  const executable = path.join(macRuntimeRoot(), 'bin', worker);
  return new Promise((resolve, reject) => {
    const child = controller ? spawnTracked(taskId, executable, []) : spawn(executable, [], { detached: process.platform === 'darwin', stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    if (!controller) trackBackgroundProcess(child);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const reader = new NativeReplyReader(taskId, options.onProgress);
    let failure: unknown;
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void terminateChild(child); } };
    const timeout = setTimeout(() => { failure = Object.assign(new Error('Native process timed out'), { code: 'WORKER_TIMEOUT' }); stop(); }, 12 * 60 * 60 * 1000);
    timeout.unref();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', (chunk: string) => { if (failure) return; try { reader.feed(chunk); } catch (error) { failure = error; stop(); } });
    child.stderr.on('data', (chunk: string) => { void logLine(taskId, 'NATIVE', chunk.slice(-65536)).catch(() => undefined); });
    child.stdin.on('error', (error) => { failure ??= error; stop(); });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) { reject(Object.assign(new Error('PROCESS_CANCELLED'), { code: 'PROCESS_CANCELLED' })); return; }
      if (failure) { reject(failure); return; }
      try { resolve(reader.finish(code, exitSignal)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...request, schemaVersion: 1, taskID: taskId, runtimeDirectory: macRuntimeRoot(), modelsDirectory: path.join(macRuntimeRoot(), 'Models') }) + '\n');
  });
}
export function fromNativeVideo(value: unknown): VideoMetadata {
  const v = nativeVideoSchema.parse(value);
  return videoMetadataSchema.parse({
    path: v.path, width: v.width, height: v.height, duration_seconds: v.duration, fps: v.fps, nominal_fps: v.nominalFPS,
    average_fps_ratio: v.frameRate, nominal_fps_ratio: null, variable_frame_rate: v.variableFrameRate,
    video_codec: v.videoCodec, audio_codec: v.audioCodec ?? null, container: path.extname(v.path).slice(1).toLowerCase() || 'unknown',
    frame_count: v.frameCount ?? null, average_bitrate: v.bitrate || null, audio_bitrate: v.audioBitrate || null,
    pixel_format: v.pixelFormat, audio_sample_rate: v.audioCodec ? v.audioSampleRate : null, audio_channels: v.audioChannels || null,
    video_duration_seconds: v.videoDuration ?? null, audio_duration_seconds: v.audioDuration ?? null,
    video_start_time_seconds: v.videoStart, audio_start_time_seconds: v.audioStart,
    video_time_base: v.videoTimeBase, audio_time_base: v.audioTimeBase, rotation: v.rotation, sample_aspect_ratio: v.sar,
    color_range: v.colorRange ?? null, color_space: v.colorSpace ?? null, color_transfer: v.colorTransfer ?? null, color_primaries: v.colorPrimaries ?? null,
    native_video: v,
  });
}
export async function probeMacVideo(sourcePath: string, signal?: AbortSignal): Promise<VideoMetadata> {
  const result = await callNative('TTcutMediaWorker', { operation: 'probe', sourcePath }, { signal });
  return fromNativeVideo(result.video);
}
export async function renderMacMedia(taskId: string, operation: 'export' | 'normalize' | 'preview' | 'cover', sourcePath: string, destination: string, ranges: readonly { start: number; end: number }[] = [], onProgress: (percent: number) => void = () => {}): Promise<VideoMetadata | null> {
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), `.ttcut-native-${taskId}-`));
  const partial = path.join(staging, path.basename(destination));
  try {
    const result = await callNative('TTcutMediaWorker', { operation, sourcePath, destination: partial, ranges: ranges.map(({ start, end }) => ({ start, end, clipIDs: [] })), strategy: 'fastSegmented' }, {
      taskId, onProgress: (event) => onProgress(event.total ? event.current! / event.total * 100 : 0),
    });
    if (result.outputPath !== partial) throw new Error('NATIVE_DESTINATION_MISMATCH');
    if (getTaskController(taskId)?.signal.aborted) throw new Error('PROCESS_CANCELLED');
    if (await access(destination).then(() => true, () => false)) throw new Error('OUTPUT_COLLISION');
    await rename(partial, destination);
    return result.video ? fromNativeVideo({ ...result.video, path: destination }) : null;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
