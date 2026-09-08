import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { VideoMetadata } from '../shared/contracts';
import { resolveUsableMediaComponents, type MediaEncoder } from './components';
import { probeVideo } from './probe';
import { runProcess } from './processes';
import { logLine } from './logger';

// These files are playback proxies only. Analysis, calibration and exports keep
// their original media identity, dimensions and timestamps.
let directory: Promise<string> | null = null;
const prepared = new Map<string, Promise<string>>();
const controllers = new Set<AbortController>();
let closing = false;

export function buildPreviewArgs(input: string, output: string, metadata: VideoMetadata, encoder: MediaEncoder): string[] {
  const fps = Math.min(60, metadata.nominal_fps || metadata.fps);
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', `scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${fps}`,
    ...(encoder === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']
      : ['-c:v', 'libopenh264', '-b:v', '5000000']),
    '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level:v', '4.2',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output,
  ];
}

export async function preparePreviewMedia(filePath: string): Promise<string> {
  if (closing) throw new Error('PREVIEW_CANCELLED');
  const source = await stat(filePath);
  if (closing) throw new Error('PREVIEW_CANCELLED');
  if (!source.isFile()) throw new Error('INVALID_INPUT');
  const key = createHash('sha256').update(JSON.stringify([
    path.resolve(filePath), source.size, source.mtimeMs,
  ])).digest('hex');
  const existing = prepared.get(key);
  if (existing) return existing;
  const controller = new AbortController();
  controllers.add(controller);
  const work = (async () => {
    let temporary: string | null = null;
    try {
      directory ??= mkdtemp(path.join(app.getPath('temp'), 'ttcut-preview-')).catch((error: unknown) => {
        directory = null;
        throw error;
      });
      const root = await directory;
      const output = path.join(root, `${key}.mp4`);
      temporary = path.join(root, `${key}.partial.mp4`);
      const metadata = await probeVideo(filePath, controller.signal);
      const components = await resolveUsableMediaComponents();
      if (!components.ffmpeg || components.mediaEncoder === 'unavailable') throw new Error('MEDIA_COMPONENT_MISSING');
      await logLine('preview', 'INFO', `Preparing compatible preview for ${path.basename(filePath)}`).catch(() => undefined);
      await runProcess(components.ffmpeg, buildPreviewArgs(filePath, temporary, metadata, components.mediaEncoder), {
        signal: controller.signal,
      });
      const preview = await probeVideo(temporary, controller.signal);
      if (preview.video_codec !== 'h264' || preview.pixel_format !== 'yuv420p'
        || Math.abs(preview.duration_seconds - metadata.duration_seconds) > 0.25) {
        throw new Error('PREVIEW_VALIDATION_FAILED');
      }
      const current = await stat(filePath);
      if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error('INPUT_CHANGED');
      if (controller.signal.aborted) throw new Error('PREVIEW_CANCELLED');
      await rename(temporary, output);
      await logLine('preview', 'INFO', `Compatible preview ready for ${path.basename(filePath)}`).catch(() => undefined);
      return output;
    } catch (error) {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      await logLine('preview', 'ERROR', `Compatible preview failed: ${String(error)}`).catch(() => undefined);
      throw error;
    } finally {
      controllers.delete(controller);
    }
  })();
  prepared.set(key, work);
  void work.catch(() => { if (prepared.get(key) === work) prepared.delete(key); });
  return work;
}

export function hasPreviewMedia(): boolean {
  return directory !== null || controllers.size > 0;
}

export async function disposePreviewMedia(): Promise<void> {
  closing = true;
  for (const controller of controllers) controller.abort();
  await Promise.allSettled([...prepared.values()]);
  const root = await directory?.catch(() => null);
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch((error: unknown) => {
    void logLine('preview', 'WARN', `Could not remove preview cache: ${String(error)}`).catch(() => undefined);
  });
  prepared.clear();
  directory = null;
}
