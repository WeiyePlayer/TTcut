import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { resolveUsableMediaComponents } from './components';
import { runProcess } from './processes';

export const PREVIEW_SEGMENT_SECONDS = 6;
export function previewSegmentStart(time: number): number {
  return Math.floor(Math.max(0, time) / PREVIEW_SEGMENT_SECONDS) * PREVIEW_SEGMENT_SECONDS;
}
// This cache is a last-resort playback aid. It never enters analysis/export media selection.
export async function preparePreviewSegment(source: string, time: number, signal: AbortSignal): Promise<{ path: string; start: number }> {
  const info = await stat(source);
  const start = previewSegmentStart(time);
  const key = createHash('sha256').update(JSON.stringify([path.resolve(source), info.size, info.mtimeMs, start, '360p30-v1'])).digest('hex');
  const root = path.join(app.getPath('userData'), 'preview-segments', 'v1');
  await mkdir(root, { recursive: true });
  const output = path.join(root, key + '.mp4');
  if ((await stat(output).catch(() => null))?.size) return { path: output, start };
  const temporary = path.join(root, `${key}.${randomUUID()}.partial.mp4`);
  const components = await resolveUsableMediaComponents();
  if (!components.ffmpeg || components.mediaEncoder === 'unavailable') throw new Error('MEDIA_COMPONENT_MISSING');
  try {
    await runProcess(components.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(start), '-i', source,
      '-t', String(PREVIEW_SEGMENT_SECONDS), '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      '-vf', 'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2:out_range=tv,fps=30,setpts=PTS-STARTPTS',
      '-c:v', components.mediaEncoder,
      ...(components.mediaEncoder === 'libx264' ? ['-preset', 'ultrafast', '-crf', '27'] : ['-b:v', '1000000']),
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-af', 'asetpts=PTS-STARTPTS', '-movflags', '+faststart', temporary,
    ], { signal, timeoutMs: 45_000 });
    const current = await stat(source);
    if (current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error('INPUT_CHANGED');
    if (signal.aborted) throw new Error('PREVIEW_CANCELLED');
    await rename(temporary, output).catch(async error => { if (!(await stat(output).catch(() => null))?.size) throw error; });
    // Bound disk use without touching the current or immediately prefetched segment.
    const files = await Promise.all((await readdir(root)).filter(name => /^[a-f0-9]{64}\.mp4$/.test(name)).map(async name => ({ name, info: await stat(path.join(root, name)).catch(() => null) })));
    let bytes = 0;
    for (const file of files.sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))) {
      bytes += file.info?.size ?? 0;
      if (bytes > 512 * 1024 * 1024 && file.name !== path.basename(output) && Date.now() - (file.info?.mtimeMs ?? 0) > 60_000) await rm(path.join(root, file.name), { force: true }).catch(() => undefined);
    }
    return { path: output, start };
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
