import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { protocol } from 'electron';

type RegisteredMedia = { filePath: string; contentType: 'video/mp4' | 'image/jpeg' };

const registered = new Map<string, RegisteredMedia>();

export function registerMediaPath(filePath: string, contentType: RegisteredMedia['contentType'] = 'video/mp4'): string {
  const token = randomUUID();
  registered.set(token, { filePath: path.resolve(filePath), contentType });
  return `ttcut-media://media/${token}`;
}

export function clearMediaPaths(): void {
  registered.clear();
}

function parseRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

export function installMediaProtocol(): void {
  protocol.handle('ttcut-media', async (request) => {
    const url = new URL(request.url);
    const token = url.pathname.replace(/^\//, '');
    const media = registered.get(token);
    if (!media) return new Response('Not found', { status: 404 });
    try {
      const info = await stat(media.filePath);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      const range = parseRange(request.headers.get('range'), info.size);
      if (request.headers.has('range') && !range) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? info.size - 1;
      const stream = createReadStream(media.filePath, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: range ? 206 : 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Type': media.contentType,
          'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
