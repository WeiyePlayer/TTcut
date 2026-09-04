import { nativeEventSchema, type NativeEvent } from '../../shared/native-contracts';

/** Incremental decoder shared by analysis and media subprocesses. */
export class NativeReplyReader {
  private buffer = '';
  private terminal: NativeEvent | null = null;
  constructor(private readonly taskId: string, private readonly progress: (event: NativeEvent) => void = () => {}) {}
  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error('NATIVE_OUTPUT_LIMIT');
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); this.line(line);
    }
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (this.terminal) throw new Error('NATIVE_EVENT_AFTER_TERMINAL');
    const event = nativeEventSchema.parse(JSON.parse(line));
    if (event.taskID !== this.taskId) throw new Error('NATIVE_TASK_MISMATCH');
    if (event.type === 'progress') {
      if (!event.stage || event.current === undefined || event.total === undefined || event.current > event.total) throw new Error('NATIVE_PROGRESS_INVALID');
      this.progress(event);
    } else {
      if (event.type === 'error' && !event.error) throw new Error('NATIVE_ERROR_INVALID');
      this.terminal = event;
    }
  }
  finish(code: number | null, signal: NodeJS.Signals | null): NativeEvent {
    if (this.buffer.trim()) this.line(this.buffer);
    if (this.terminal?.type === 'error') throw Object.assign(new Error(this.terminal.error!.message), { code: this.terminal.error!.code });
    if (code !== 0 || signal !== null || !this.terminal) throw Object.assign(new Error('Native process exited without a successful result'), { code: 'WORKER_EXITED' });
    return this.terminal;
  }
}
