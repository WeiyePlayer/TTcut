import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), segment: vi.fn(), log: vi.fn().mockResolvedValue(undefined) }));
vi.mock('node:child_process', async importOriginal => { const actual = await importOriginal<typeof import('node:child_process')>(); return { ...actual, default: { ...actual, spawn: mocks.spawn }, spawn: mocks.spawn }; });
vi.mock('node:fs', async importOriginal => { const actual = await importOriginal<typeof import('node:fs')>(); return { ...actual, default: { ...actual, existsSync: () => true }, existsSync: () => true }; });
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, BrowserWindow: {}, ipcMain: {}, screen: { getDisplayMatching: () => ({ scaleFactor: 1.75 }) } }));
vi.mock('../src/main/logger', () => ({ logLine: mocks.log }));
vi.mock('../src/main/preview-segments', () => ({ preparePreviewSegment: mocks.segment, PREVIEW_SEGMENT_SECONDS: 6, previewSegmentStart: (time: number) => Math.floor(time / 6) * 6 }));
import { NativePreviewSession } from '../src/main/native-preview';
import { nativePreviewCommandSchema, nativePreviewOpenSchema } from '../src/shared/native-preview';

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); exitCode: number | null = null;
  commands: Array<Record<string, unknown>> = [];
  constructor() {
    super(); this.stdin.on('data', value => this.commands.push(JSON.parse(String(value))));
    this.stdin.on('finish', () => { this.exitCode = 0; this.emit('exit', 0); });
  }
  kill() { this.exitCode = 1; this.emit('exit', 1); }
  event(value: object) { this.stdout.write(JSON.stringify(value) + '\n'); }
}
let session: NativePreviewSession;
let child: FakeChild;
let send: ReturnType<typeof vi.fn>;
const state = (extra = {}) => ({ type: 'state', time: 0, duration: 600, paused: true, seeking: false, ready: true, ended: false, sequence: 0, samples: 1, decoder: 'd3d11va', ...extra });
beforeEach(() => {
  vi.useFakeTimers(); child = new FakeChild(); mocks.spawn.mockReturnValue(child); mocks.segment.mockReset(); send = vi.fn();
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomFactor: () => 1, send });
  const window = Object.assign(new EventEmitter(), { id: 1, webContents: contents, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]) });
  session = new NativePreviewSession(window as unknown as BrowserWindow, 'session', 'D:/original.MOV', { x: 10, y: 20, width: 800, height: 450, visible: true });
  expect(mocks.spawn).toHaveBeenCalled();
});
afterEach(async () => { await session.close(); vi.useRealTimers(); });

describe('native playback session', () => {
  it('opens the original file without any proxy preparation and positions the native child at physical DPI', () => {
    child.event({ type: 'initialized', version: 'test' });
    expect(child.commands).toContainEqual({ op: 'bounds', x: 18, y: 35, width: 1400, height: 788, visible: true });
    expect(child.commands.at(-1)).toMatchObject({ op: 'load', path: 'D:/original.MOV', software: false });
    expect(mocks.segment).not.toHaveBeenCalled();
  });
  it('keeps a terminal failure visible until retry and explicitly reopens the native surface on retry', () => {
    child.event({ type: 'initialized' }); child.event({ type: 'error', message: 'first' }); child.event({ type: 'error', message: 'final' });
    expect(child.exitCode).toBe(1);
    send.mockClear(); child.event(state()); expect(send).not.toHaveBeenCalled();
    child = new FakeChild();mocks.spawn.mockReturnValue(child);
    session.command({ type: 'retry' });
    expect(send).toHaveBeenCalledWith('preview:native-event', expect.objectContaining({ type: 'loading', message: 'software' }));
    child.event({ type: 'initialized' });child.event(state()); expect(send).toHaveBeenLastCalledWith('preview:native-event', expect.objectContaining({ type: 'state', mode: 'software' }));
  });
  it('preserves the latest seek and pause intent issued before the first frame', () => {
    child.event({ type: 'initialized' });
    session.command({ type: 'seek', time: 80, playing: true, exact: true, sequence: 1 });
    session.command({ type: 'seek', time: 210, playing: false, exact: true, sequence: 2 });
    child.event(state());
    expect(child.commands.at(-1)).toMatchObject({ op: 'seek', time: 210, paused: true, sequence: 2 });
    send.mockClear(); child.event(state({ time: 80, sequence: 1 })); expect(send).not.toHaveBeenCalled();
    child.event(state({ time: 210, sequence: 2 }));
    expect(send).toHaveBeenCalledWith('preview:native-event', expect.objectContaining({ type: 'state', time: 210, sequence: 2 }));
  });
  it('recovers a hardware error in software at the same point, and stops after a subsequent decode error', () => {
    session.command({ type: 'pause', paused: false });
    child.event({ type: 'initialized' }); child.event(state({ time: 123, paused: false }));
    child.event({ type: 'error', message: 'hardware decoder failed' });
    expect(child.commands.at(-1)).toMatchObject({ op: 'load', software: true, time: 123, paused: false });
    child.event({ type: 'error', message: 'unreadable media' });
    expect(send).toHaveBeenCalledWith('preview:native-event', expect.objectContaining({ type: 'error', message: 'unreadable media' }));
    expect(mocks.segment).not.toHaveBeenCalled();
  });
  it('bounds loading time and prepares only the target window after hardware and software stalls', async () => {
    mocks.segment.mockResolvedValue({ path: 'D:/cache/120.mp4', start: 120 });
    child.event({ type: 'initialized' });
    session.command({ type: 'seek', time: 123, playing: true, exact: true, sequence: 1 });
    await vi.advanceTimersByTimeAsync(8500);
    expect(child.commands.at(-1)).toMatchObject({ op: 'load', software: true, time: 123 });
    await vi.advanceTimersByTimeAsync(8500);
    expect(mocks.segment).toHaveBeenCalledWith('D:/original.MOV', 123, expect.any(AbortSignal));
    expect(child.commands.at(-1)).toMatchObject({ op: 'load', path: 'D:/cache/120.mp4', time: 3 });
    child.event(state({ duration: 6, time: 3.5, sequence: 1, paused: false }));
    expect(send).toHaveBeenLastCalledWith('preview:native-event', expect.objectContaining({ time: 123.5, mode: 'proxy' }));
    child.event(state({ duration: 6, time: 5.99, sequence: 1, paused: true, ended: false }));
    child.event(state({ duration: 6, time: 5.99, sequence: 1, paused: true, ended: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(child.commands.at(-1)).toMatchObject({ op: 'load', paused: false });
  });
  it('closes the process and suppresses all late events', async () => {
    await session.close(); send.mockClear(); child.event(state());
    expect(child.exitCode).toBe(0); expect(send).not.toHaveBeenCalled();
  });
  it('closes safely after Electron destroys the BrowserWindow webContents getter', async () => {
    Object.defineProperty(session.window, 'webContents', { get() { throw new Error('Object has been destroyed'); } });
    session.window.emit('closed'); await session.close();
    expect(child.exitCode).toBe(0);
  });
  it('preserves stopped intent after the original file reaches EOF', () => {
    child.event({ type: 'initialized' });session.command({ type: 'pause', paused: false });
    child.event(state({ time: 599.99, paused: true, ended: true }));
    session.command({ type: 'retry' });
    expect(child.commands.at(-1)).toMatchObject({ op: 'load', paused: true, time: 599.99 });
  });
});

it('rejects arbitrary commands, paths and unbounded geometry at the IPC boundary', () => {
  expect(nativePreviewCommandSchema.safeParse({ type: 'command', command: ['run', 'evil'] }).success).toBe(false);
  expect(nativePreviewOpenSchema.safeParse({ sessionId: 'id', mediaUrl: 'D:/video.mp4', bounds: {} }).success).toBe(false);
  expect(nativePreviewCommandSchema.safeParse({ type: 'bounds', bounds: { x: 0, y: 0, width: Infinity, height: 100, visible: true } }).success).toBe(false);
});
