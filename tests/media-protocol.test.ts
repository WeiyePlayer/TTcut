// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const handle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ protocol: { handle } }));
import { clearMediaPaths, installMediaProtocol, registeredVideoPath, registerMediaPath, resolveMediaPath, unregisterMediaPath } from '../src/main/media-protocol';

afterEach(() => { clearMediaPaths(); vi.clearAllMocks(); });

describe('registered preview frame URLs', () => {
  it('revokes an obsolete frame without revoking its source video or replacement', async () => {
    installMediaProtocol();
    const request = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;
    const source = registerMediaPath('/source.mov', 'video/quicktime');
    const obsolete = registerMediaPath('/frame-1.jpg', 'image/jpeg');
    const latest = registerMediaPath('/frame-2.jpg', 'image/jpeg');
    unregisterMediaPath(obsolete);
    expect(() => resolveMediaPath(obsolete)).toThrow('MEDIA_NOT_REGISTERED');
    expect((await request(new Request(obsolete))).status).toBe(404);
    expect(registeredVideoPath(source)).toBe(path.resolve('/source.mov'));
    expect(resolveMediaPath(latest)).toBe(path.resolve('/frame-2.jpg'));
    unregisterMediaPath(obsolete);
  });

  it('rejects image tokens, unregistered URLs and external paths as video inputs', () => {
    const frame = registerMediaPath('/frame.jpg', 'image/jpeg');
    expect(() => registeredVideoPath(frame)).toThrow('INVALID_INPUT');
    expect(() => registeredVideoPath('ttcut-media://media/unknown')).toThrow('INVALID_INPUT');
    expect(() => registeredVideoPath('file:///source.mov')).toThrow('INVALID_INPUT');
    expect(() => registeredVideoPath(frame.replace('://media/', '://other/'))).toThrow('INVALID_INPUT');
    expect(() => unregisterMediaPath('https://example.com/frame.jpg')).toThrow('INVALID_INPUT');
  });
});
