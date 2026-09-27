import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { app, BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { nativePreviewCommandSchema, nativePreviewOpenSchema, type NativePreviewCommand, type NativePreviewEvent, type PreviewBounds, type PreviewScoreboard } from '../shared/native-preview';
import { IPC } from '../shared/ipc';
import { registeredVideoPath } from './media-protocol';
import { logLine } from './logger';
import { preparePreviewSegment, PREVIEW_SEGMENT_SECONDS, previewSegmentStart } from './preview-segments';

type State = Extract<NativePreviewEvent, { type: 'state' }>;
const sessions = new Map<number, NativePreviewSession>();

export class NativePreviewSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  private failed = false;
  private initialized = false;
  private startedAt = Date.now();
  private lastProgress = Date.now();
  private lastTime = 0;
  private slowSince = 0;
  private performanceTime = 0;
  private duration = 0;
  private offset = 0;
  private sequence = 0;
  private paused = true;
  private target = 0;
  private mode: 'direct' | 'software' | 'proxy' = 'direct';
  private bounds: PreviewBounds;
  private scoreboard: PreviewScoreboard | null = null;
  private pendingSeek: Extract<NativePreviewCommand, { type: 'seek' }> | null = null;
  private segmentController: AbortController | null = null;
  private segmentLoading = false;
  private prefetched: Promise<{ path: string; start: number }> | null = null;
  private prefetchStart = -1;
  private monitor: ReturnType<typeof setInterval>;
  private state: State | null = null;
  private shutdown: Promise<void> | null = null;
  private readonly contents: WebContents;
  constructor(readonly window: BrowserWindow, readonly id: string, readonly source: string, bounds: PreviewBounds) {
    this.contents = window.webContents;
    this.bounds = bounds;
    this.monitor = setInterval(() => this.watchdog(), 500);
    this.window.on('resize', this.updateBounds);
    this.window.on('move', this.updateBounds);
    this.window.on('minimize', this.updateBounds);
    this.window.on('restore', this.updateBounds);
    this.window.on('hide', this.updateBounds);
    this.window.on('show', this.updateBounds);
    this.window.once('closed', this.onClosed);
    this.contents.once('render-process-gone', this.onClosed);
    this.startHost();
  }
  private onClosed = () => { void this.close(); };
  private publish(event: Omit<NativePreviewEvent, 'sessionId'>) {
    if (!this.closed && !this.window.isDestroyed() && !this.contents.isDestroyed()) this.contents.send(IPC.nativePreviewEvent, { ...event, sessionId: this.id });
  }
  private fail(message: string) {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.segmentController?.abort(); this.segmentLoading = false;
    this.publish({ type: 'error', message } as NativePreviewEvent);
    this.send({ op: 'bounds', x: 0, y: 0, width: 1, height: 1, visible: false });
    this.send({ op: 'pause', paused: true });
    clearInterval(this.monitor);
    // A wedged video driver may stop processing HWND commands too. Terminate
    // the isolated host so its child window cannot cover the retry/error UI.
    this.child?.kill();
    void logLine('preview', 'ERROR', `libmpv: ${message}`).catch(() => undefined);
  }
  private send(value: object) {
    if (!this.closed && this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private startHost() {
    const directory = app.isPackaged ? path.join(process.resourcesPath, 'libmpv') : path.join(app.getAppPath(), '.runtime/libmpv');
    const executable = path.join(directory, 'ttcut-preview.exe');
    if (!existsSync(executable) || !existsSync(path.join(directory, 'libmpv-2.dll'))) { this.fail('MPV_RUNTIME_MISSING'); return; }
    const handle = this.window.getNativeWindowHandle();
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    this.child = spawn(executable, [hwnd], { cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.child;
    child.stdin.on('error', () => undefined);
    child.once('error', error => this.fail(error.message));
    child.once('exit', (code) => { if (!this.closed && this.child === child) this.fail(`MPV_PROCESS_EXIT:${code}`); });
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.closed || this.child !== child || line.length > 65536) return;
      try { this.receive(JSON.parse(line) as Record<string, unknown>); } catch (error) { this.fail(String(error)); }
    });
    let diagnostics = '';
    child.stderr.on('data', chunk => {
      diagnostics += String(chunk);
      if (diagnostics.length > 8192 || diagnostics.includes('\n')) {
        void logLine('preview', 'WARN', diagnostics.slice(-8192)).catch(() => undefined); diagnostics = '';
      }
    });
    this.publish({ type: 'loading', message: 'opening' } as NativePreviewEvent);
  }
  private load(file = this.source, localTime = this.target) {
    this.startedAt = this.lastProgress = Date.now(); this.slowSince = 0;
    this.state = null;
    this.send({ op: 'load', path: file, time: localTime, paused: this.paused, software: this.mode !== 'direct', sequence: this.sequence });
  }
  private receive(value: Record<string, unknown>) {
    if (this.failed) return;
    if (value.type === 'initialized') {
      this.initialized = true; this.updateBounds(); this.load();
      if (this.scoreboard) this.send({ op: 'overlay', scoreboard: this.scoreboard });
      void logLine('preview', 'INFO', `libmpv ${String(value.version)} opened ${path.basename(this.source)} without full conversion`).catch(() => undefined);
    } else if (value.type === 'state') {
      if (!this.initialized || this.segmentLoading) return;
      const time = Number(value.time) + this.offset;
      if (!Number.isFinite(time) || !Number.isFinite(Number(value.duration))) return;
      if (this.mode !== 'proxy' && Number(value.duration) > 0) this.duration = Number(value.duration);
      const state: State = { sessionId: this.id, type: 'state', time, duration: this.duration, paused: Boolean(value.paused), seeking: Boolean(value.seeking), ended: Boolean(value.ended), ready: Boolean(value.ready), sequence: this.sequence, samples: Number(value.samples), decoder: String(value.decoder), mode: this.mode };
      if (this.pendingSeek && state.ready && !state.seeking) {
        this.state = state; const pending = this.pendingSeek; this.pendingSeek = null; this.command(pending); return;
      }
      if (Number(value.sequence) !== this.sequence) return;
      this.state = state;
      if (state.ready && !state.seeking) {
        this.target = state.time;
        // keep-open can report pause before eof-reached. Preserve the user's
        // transport intent so a proxy boundary still advances to the next file.
        if (state.ended && (this.mode !== 'proxy' || this.duration <= this.offset + PREVIEW_SEGMENT_SECONDS + .05)) this.paused = true;
        if (state.paused || state.time !== this.lastTime) { this.lastProgress = Date.now(); this.lastTime = state.time; }
        if (this.mode === 'proxy') {
          const next = this.offset + PREVIEW_SEGMENT_SECONDS;
          if (this.duration > next + .05 && this.prefetchStart !== next) {
            this.prefetchStart = next;
            this.prefetched = preparePreviewSegment(this.source, next, this.segmentController!.signal);
            void this.prefetched.catch(() => undefined);
          }
          if (state.ended && !this.paused && this.duration > next + .05) { void this.loadSegment(next); return; }
          state.ended = state.ended && this.duration <= next + .05;
        }
      }
      this.publish(state);
    } else if (value.type === 'error') {
      if (this.mode === 'direct' && this.initialized) this.recoverSoftware();
      else this.fail(String(value.message));
    } else if (value.type === 'pointer' || value.type === 'key') {
      this.publish(value as NativePreviewEvent);
    }
  }
  private recoverSoftware() {
    this.mode = 'software'; this.pendingSeek = null; this.load();
    this.publish({ type: 'loading', message: 'software' } as NativePreviewEvent);
  }
  private watchdog() {
    if (this.closed || this.segmentLoading) return;
    const state = this.state;
    const loading = !state?.ready || state.seeking;
    if ((loading && Date.now() - this.startedAt > 8000) || (!loading && !this.paused && Date.now() - this.lastProgress > 4000)) {
      if (this.mode === 'direct' && this.initialized) this.recoverSoftware();
      else if (this.mode === 'software') { this.mode = 'proxy'; void this.loadSegment(this.target); }
      else this.fail('MPV_PLAYBACK_TIMEOUT');
      return;
    }
    if (!loading && !this.paused && this.mode !== 'proxy') {
      if (!this.slowSince) { this.slowSince = Date.now(); this.performanceTime = state!.time; }
      else if (Date.now() - this.slowSince >= 4000) {
        const ratio = (state!.time - this.performanceTime) / ((Date.now() - this.slowSince) / 1000);
        this.slowSince = 0;
        if (ratio >= 0 && ratio < .65) {
          if (this.mode === 'direct') this.recoverSoftware();
          else { this.mode = 'proxy'; void this.loadSegment(this.target); }
        }
      }
    } else this.slowSince = 0;
  }
  private async loadSegment(time: number) {
    this.segmentLoading = true;
    const generation = this.sequence;
    const start = previewSegmentStart(time);
    const reuse = this.prefetchStart === start ? this.prefetched : null;
    if (!reuse) { this.segmentController?.abort(); this.segmentController = new AbortController(); }
    this.segmentController ??= new AbortController();
    const controller = this.segmentController;
    this.send({ op: 'pause', paused: true });
    this.publish({ type: 'loading', message: 'segment' } as NativePreviewEvent);
    try {
      const result = await (reuse ?? preparePreviewSegment(this.source, time, controller.signal));
      if (this.closed || controller.signal.aborted || generation !== this.sequence) return;
      this.offset = result.start; this.prefetched = null; this.prefetchStart = -1;
      this.segmentLoading = false; this.load(result.path, Math.max(0, time - this.offset));
    } catch (error) {
      if (!this.closed && !controller.signal.aborted && generation === this.sequence) { this.segmentLoading = false; this.fail(`MPV_SEGMENT_FAILED:${String(error)}`); }
    }
  }
  private updateBounds = () => {
    if (this.window.isDestroyed()) return;
    const factor = screen.getDisplayMatching(this.window.getBounds()).scaleFactor * this.contents.getZoomFactor();
    this.send({ op: 'bounds', x: Math.round(this.bounds.x * factor), y: Math.round(this.bounds.y * factor), width: Math.round(this.bounds.width * factor), height: Math.round(this.bounds.height * factor), visible: this.bounds.visible && this.window.isVisible() && !this.window.isMinimized() });
  };
  command(command: NativePreviewCommand) {
    if (this.closed) return;
    if (command.type === 'bounds') { this.bounds = command.bounds; this.updateBounds(); }
    else if (command.type === 'scoreboard') { this.scoreboard = command.scoreboard; this.send({ op: 'overlay', scoreboard: command.scoreboard }); }
    else if (command.type === 'pause') { this.paused = command.paused; this.send({ op: 'pause', paused: command.paused }); }
    else if (command.type === 'seek') {
      this.target = this.duration > 0 ? Math.min(command.time, this.duration) : command.time;
      this.paused = !command.playing; this.sequence = command.sequence; this.startedAt = this.lastProgress = Date.now(); this.slowSince = 0;
      if (this.mode === 'proxy' && (this.segmentLoading || previewSegmentStart(this.target) !== this.offset)) { void this.loadSegment(this.target); return; }
      if (!this.state?.ready) { this.pendingSeek = command; return; }
      this.send({ op: 'seek', time: Math.max(0, this.target - this.offset), paused: this.paused, exact: command.exact, sequence: command.sequence });
    } else if (command.type === 'retry') {
      // One explicit user retry is a new attempt; automatic recovery remains bounded.
      this.failed = false; this.mode = 'software'; this.state = null; this.offset = 0;
      this.segmentController?.abort(); this.segmentLoading = false; this.prefetched = null; this.prefetchStart = -1; this.pendingSeek = null;
      this.publish({ type: 'loading', message: 'software' } as NativePreviewEvent);
      clearInterval(this.monitor); this.monitor = setInterval(() => this.watchdog(), 500);
      if (!this.child || this.child.killed || this.child.exitCode !== null) { this.initialized = false; this.startHost(); } else { this.updateBounds(); this.load(); }
    }
  }
  captureFrame(filePath: string): void { this.send({ op: 'screenshot', path: filePath }); }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.send({ op: 'quit' }); this.closed = true;
    if (sessions.get(this.window.id) === this) sessions.delete(this.window.id);
    clearInterval(this.monitor); this.segmentController?.abort();
    this.window.removeListener('resize', this.updateBounds);
    this.window.removeListener('move', this.updateBounds);
    this.window.removeListener('minimize', this.updateBounds);
    this.window.removeListener('restore', this.updateBounds);
    this.window.removeListener('hide', this.updateBounds);
    this.window.removeListener('show', this.updateBounds);
    this.window.removeListener('closed', this.onClosed);
    this.contents.removeListener('render-process-gone', this.onClosed);
    const child = this.child;
    this.shutdown = !child || child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
    return this.shutdown;
  }
}

function owner(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (process.platform !== 'win32' || !window || event.senderFrame !== event.sender.mainFrame) throw new Error('INVALID_PREVIEW_OWNER');
  return window;
}
export function registerNativePreviewIpc(): void {
  ipcMain.handle(IPC.nativePreviewOpen, async (event, raw: unknown) => {
    const window = owner(event); const input = nativePreviewOpenSchema.parse(raw);
    const source = registeredVideoPath(input.mediaUrl);
    const previous = sessions.get(window.id); if (previous) void previous.close();
    sessions.set(window.id, new NativePreviewSession(window, input.sessionId, source, input.bounds));
  });
  ipcMain.handle(IPC.nativePreviewCommand, (event, id: unknown, raw: unknown) => {
    const session = sessions.get(owner(event).id);
    const command = nativePreviewCommandSchema.parse(raw);
    if (session && session.id === id) session.command(command);
  });
  ipcMain.handle(IPC.nativePreviewClose, async (event, id: unknown) => {
    const window = owner(event); const session = sessions.get(window.id);
    if (session && session.id === id) { sessions.delete(window.id); await session.close(); }
  });
}
export async function closeNativePreviews(): Promise<void> {
  const active = [...sessions.values()]; sessions.clear(); await Promise.all(active.map(session => session.close()));
}
// Main-only diagnostics; no renderer IPC exposes filesystem destinations.
export function captureNativePreviewFrame(windowId: number, filePath: string): void {
  sessions.get(windowId)?.captureFrame(filePath);
}
