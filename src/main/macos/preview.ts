import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';
import { beginTrackedTask, endTrackedTask } from '../processes';
import { resolveMediaPath, registerMediaPath } from '../media-protocol';
import { probeMacVideo, renderMacMedia } from './client';
import { IPC } from '../../shared/ipc';
import { validatePreview } from '../../domain/preview-validation';
import { logLine } from '../logger';

export async function prepareMacPreview(window: BrowserWindow, mediaUrl: string, taskId: string): Promise<string> {
  const source = resolveMediaPath(mediaUrl);
  const controller = beginTrackedTask(taskId);
  try {
    const info = await stat(source);
    const key = createHash('sha256').update(JSON.stringify([source, info.size, info.mtimeMs, 'sdr-preview-v3-limited-video-timeline'])).digest('hex');
    const root = path.join(app.getPath('userData'), 'preview'); await mkdir(root, { recursive: true });
    const destination = path.join(root, `${key}.mp4`);
    const sourceVideo = await probeMacVideo(source, controller.signal);
    const cached = await probeMacVideo(destination, controller.signal).catch(() => null);
    let validCache = false;
    if (cached && cached.native_video?.hdr === 'sdr') {
      try { validatePreview(sourceVideo, cached); validCache = true; } catch { /* Rebuild invalid previews. */ }
    }
    if (!validCache) {
      if (controller.signal.aborted) throw new Error('PROCESS_CANCELLED');
      await rm(destination, { force: true });
      const rendered = await renderMacMedia(taskId, 'preview', source, destination, [], (percent) => {
        if (!window.isDestroyed()) window.webContents.send(IPC.previewProgress, { taskId, percent });
      });
      if (!rendered) throw new Error('PREVIEW_RESULT_MISSING');
      validatePreview(sourceVideo, rendered);
      await logLine(taskId, 'INFO', `Native preview validated: ${JSON.stringify({
        sourceVideoDuration: sourceVideo.video_duration_seconds, previewVideoDuration: rendered.video_duration_seconds,
        sourceDuration: sourceVideo.duration_seconds, previewDuration: rendered.duration_seconds,
        pixelFormat: rendered.pixel_format, colorRange: rendered.color_range,
      })}`).catch(() => undefined);
    }
    // Only preview cache files participate in eviction; keep the current and previous proxy.
    const files = await Promise.all((await readdir(root)).filter((name) => /^[a-f0-9]{64}\.mp4$/.test(name) && name !== `${key}.mp4`).map(async (name) => ({ name, modified: (await stat(path.join(root, name))).mtimeMs })));
    for (const file of files.sort((a, b) => b.modified - a.modified).slice(1)) await rm(path.join(root, file.name), { force: true });
    return registerMediaPath(destination);
  } finally { endTrackedTask(taskId); }
}
