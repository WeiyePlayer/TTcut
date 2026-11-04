import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { VideoMetadata } from '../shared/contracts';
import { resolveUsableMediaComponents } from './components';
import { probeVideo } from './probe';
import { runProcess } from './processes';
import { previewToneFilter } from './preview-media';
import { logLine } from './logger';

type FrameRequest = {
  seconds: number;
  controller: AbortController;
  resolve: (filePath: string) => void;
  reject: (error: unknown) => void;
};
type SourceFrames = {
  active: FrameRequest | null;
  queued: FrameRequest | null;
  work: Promise<void> | null;
  metadata?: { key: string; value: VideoMetadata };
  output?: string;
};

const sources = new Map<string, SourceFrames>();
let directory: Promise<string> | null = null;
let closing = false;

export function buildPreviewFrameArgs(input: string, output: string, seconds: number, metadata: VideoMetadata): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(seconds), '-i', input,
    '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
    // Keep FFmpeg's default autorotate: calibration uses displayed dimensions.
    '-vf', `${previewToneFilter(metadata)}scale=1280:720:force_original_aspect_ratio=decrease:out_range=tv`,
    '-q:v', '3', '-update', '1', output,
  ];
}

function checkCancelled(signal: AbortSignal): void {
  if (closing || signal.aborted) throw new Error('PREVIEW_CANCELLED');
}

async function extract(filePath: string, state: SourceFrames, request: FrameRequest): Promise<string> {
  const started = Date.now();
  const { signal } = request.controller;
  let output: string | undefined;
  try {
    checkCancelled(signal);
    const source = await stat(filePath);
    if (!source.isFile()) throw new Error('INVALID_INPUT');
    checkCancelled(signal);
    const key = JSON.stringify([filePath, source.size, source.mtimeMs]);
    const components = await resolveUsableMediaComponents();
    if (!components.ffmpeg) throw new Error('MEDIA_COMPONENT_MISSING');
    checkCancelled(signal);
    if (state.metadata?.key !== key) {
      const value = await probeVideo(filePath, signal, 'interactive');
      checkCancelled(signal);
      state.metadata = { key, value };
    }
    const metadata = state.metadata.value;
    // Seeking to the exact duration can succeed without writing any frame.
    const duration = metadata.video_duration_seconds && metadata.video_duration_seconds > 0
      ? Math.min(metadata.duration_seconds, metadata.video_duration_seconds) : metadata.duration_seconds;
    const seconds = Math.min(request.seconds, Math.max(0, duration - 1 / metadata.fps));
    directory ??= mkdtemp(path.join(app.getPath('temp'), 'ttcut-frame-')).catch((error: unknown) => {
      directory = null;
      throw error;
    });
    const root = await directory;
    checkCancelled(signal);
    output = path.join(root, `${randomUUID()}.jpg`);
    await runProcess(components.ffmpeg, buildPreviewFrameArgs(filePath, output, seconds, metadata), {
      signal, timeoutMs: 30_000,
    });
    checkCancelled(signal);
    const frame = await stat(output);
    if (!frame.isFile() || frame.size === 0) throw new Error('PREVIEW_FRAME_EMPTY');
    const current = await stat(filePath);
    if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error('INPUT_CHANGED');
    checkCancelled(signal);
    if (state.output) await rm(state.output, { force: true });
    await logLine('preview', 'INFO', `Frame ready for ${path.basename(filePath)} at ${seconds}s (${Date.now() - started}ms)`).catch(() => undefined);
    checkCancelled(signal);
    state.output = output;
    return output;
  } catch (error) {
    if (output) await rm(output, { force: true }).catch(() => undefined);
    const reason = closing || signal.aborted ? new Error('PREVIEW_CANCELLED') : error;
    await logLine('preview', 'WARN', `Frame failed for ${path.basename(filePath)} at ${request.seconds}s (${Date.now() - started}ms): ${String(reason)}`).catch(() => undefined);
    throw reason;
  }
}

function startNext(filePath: string, state: SourceFrames): void {
  const request = state.queued;
  if (!request || closing) return;
  state.queued = null;
  state.active = request;
  state.work = extract(filePath, state, request).then(request.resolve, request.reject).finally(() => {
    state.active = null;
    state.work = null;
    startNext(filePath, state);
  });
}

export function extractPreviewFrame(filePath: string, seconds: number): Promise<string> {
  if (closing) return Promise.reject(new Error('PREVIEW_CANCELLED'));
  if (!Number.isFinite(seconds) || seconds < 0) return Promise.reject(new Error('INVALID_INPUT'));
  const source = path.resolve(filePath);
  let state = sources.get(source);
  if (!state) {
    state = { active: null, queued: null, work: null };
    sources.set(source, state);
  }
  const current = state;
  return new Promise((resolve, reject) => {
    current.queued?.reject(new Error('PREVIEW_CANCELLED'));
    current.queued = { seconds, controller: new AbortController(), resolve, reject };
    // Wait for the aborted process to exit before starting the latest request.
    // There is at most one process and one pending request per source.
    current.active?.controller.abort();
    if (!current.work) startNext(source, current);
  });
}

export function hasPreviewFrames(): boolean {
  return directory !== null || [...sources.values()].some((state) => state.work !== null);
}

export async function disposePreviewFrames(): Promise<void> {
  closing = true;
  for (const state of sources.values()) {
    state.queued?.reject(new Error('PREVIEW_CANCELLED'));
    state.queued = null;
    state.active?.controller.abort();
  }
  await Promise.allSettled([...sources.values()].map((state) => state.work));
  const root = await directory?.catch(() => null);
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch((error: unknown) => {
    void logLine('preview', 'WARN', `Could not remove frame cache: ${String(error)}`).catch(() => undefined);
  });
  sources.clear();
  directory = null;
}
