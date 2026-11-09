import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeTaskIds,
  beginExternalTask,
  beginTrackedTask,
  cancelAllTasks,
  cancelAllTasksAndWait,
  cancelTask,
  classifyProcessExit,
  configureTaskSuspensionBlocker,
  endExternalTask,
  endTrackedTask,
  getTaskController,
  hasActiveTasks,
  hasPreemptibleTasks,
  markTaskTerminal,
  PREEMPTIBLE_RESUME_DELAY_MS,
  runPreemptibleTask,
  runProcess,
  spawnTracked,
  type TaskController,
} from '../src/main/processes';

const suspensionBlocker = {
  start: vi.fn(() => 73),
  stop: vi.fn(),
};

beforeEach(() => {
  suspensionBlocker.start.mockClear();
  suspensionBlocker.stop.mockClear();
  configureTaskSuspensionBlocker(suspensionBlocker);
});

afterEach(async () => {
  await cancelAllTasks('app-exit');
  for (const taskId of activeTaskIds()) {
    endExternalTask(taskId);
    endTrackedTask(taskId);
  }
  configureTaskSuspensionBlocker(null);
});

describe('tracked task lifecycle', () => {
  it('lets a user-started task preempt a running preview instead of reporting TASK_BUSY', async () => {
    let preview!: TaskController;
    let closed!: Promise<unknown>;
    const result = runPreemptibleTask('preview', async (controller) => {
      preview = controller;
      const child = spawnTracked('preview', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      closed = once(child, 'close');
      await closed;
      throw new Error('PROCESS_CANCELLED');
    });
    expect(hasActiveTasks()).toBe(false);
    expect(hasPreemptibleTasks()).toBe(true);
    expect(() => beginTrackedTask('analysis')).not.toThrow();
    expect(preview.signal.aborted).toBe(true);
    expect(preview.cancelReason).toBe('preempted');
    await closed;
    expect(activeTaskIds()).toEqual(['analysis']);
    await cancelTask('preview');
    await expect(result).rejects.toThrow('CANCELLED');
  });

  it('keeps a preview request waiting in main while a user task runs, then starts it after the task ends', async () => {
    vi.useFakeTimers();
    try {
      beginTrackedTask('export');
      const run = vi.fn(async () => 'proxy-url');
      const result = runPreemptibleTask('preview', run);
      expect(run).not.toHaveBeenCalled();
      expect(hasPreemptibleTasks()).toBe(true);
      endTrackedTask('export');
      // Not synchronously at task end: the terminal event and any navigation reach the renderer first.
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(PREEMPTIBLE_RESUME_DELAY_MS);
      expect(run).toHaveBeenCalledOnce();
      await expect(result).resolves.toBe('proxy-url');
      expect(hasPreemptibleTasks()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('re-runs a preempted preview once the user task ends, settling only with its final result', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const result = runPreemptibleTask('preview', async (controller) => {
        attempts++;
        if (attempts === 1) {
          await new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('PROCESS_CANCELLED'))));
        }
        return `proxy-${attempts}`;
      });
      beginTrackedTask('analysis');
      await vi.advanceTimersByTimeAsync(PREEMPTIBLE_RESUME_DELAY_MS * 2);
      expect(attempts).toBe(1);
      expect(hasPreemptibleTasks()).toBe(true);
      endTrackedTask('analysis');
      await vi.advanceTimersByTimeAsync(PREEMPTIBLE_RESUME_DELAY_MS);
      await expect(result).resolves.toBe('proxy-2');
      expect(attempts).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('waits for a cancelled preview that is still unwinding instead of reporting TASK_BUSY', async () => {
    vi.useFakeTimers();
    try {
      let unwind!: () => void;
      const old = runPreemptibleTask('old-page', (controller) => new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => { unwind = () => reject(new Error('PROCESS_CANCELLED')); });
      }));
      const oldSettled = expect(old).rejects.toThrow('CANCELLED');
      await cancelTask('old-page');
      const run = vi.fn(async () => 'new-proxy');
      const next = runPreemptibleTask('new-page', run);
      await vi.advanceTimersByTimeAsync(PREEMPTIBLE_RESUME_DELAY_MS * 2);
      expect(run).not.toHaveBeenCalled();
      unwind();
      await oldSettled;
      await vi.advanceTimersByTimeAsync(PREEMPTIBLE_RESUME_DELAY_MS);
      await expect(next).resolves.toBe('new-proxy');
    } finally { vi.useRealTimers(); }
  });

  it('rejects a waiting preview with CANCELLED when its own task is cancelled, and never runs it', async () => {
    vi.useFakeTimers();
    try {
      beginTrackedTask('export');
      const run = vi.fn(async () => 'proxy');
      const result = runPreemptibleTask('preview', run);
      const settled = expect(result).rejects.toThrow('CANCELLED');
      await cancelTask('preview');
      await settled;
      expect(hasPreemptibleTasks()).toBe(false);
      endTrackedTask('export');
      await vi.advanceTimersByTimeAsync(PREEMPTIBLE_RESUME_DELAY_MS * 2);
      expect(run).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('cancels running and waiting previews on app exit', async () => {
    let running!: TaskController;
    const first = runPreemptibleTask('preview', (controller) => {
      running = controller;
      return new Promise<string>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('PROCESS_CANCELLED'))));
    });
    const waitingRun = vi.fn(async () => 'proxy');
    const waiting = runPreemptibleTask('waiting', waitingRun);
    const settled = Promise.all([expect(first).rejects.toThrow('CANCELLED'), expect(waiting).rejects.toThrow('CANCELLED')]);
    expect(hasPreemptibleTasks()).toBe(true);
    await cancelAllTasksAndWait('app-exit');
    await settled;
    expect(running.cancelReason).toBe('app-exit');
    expect(waitingRun).not.toHaveBeenCalled();
    expect(hasPreemptibleTasks()).toBe(false);
  });

  it('does not keep the Mac awake for a silent preview', async () => {
    let finish!: () => void;
    const result = runPreemptibleTask('preview', () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(suspensionBlocker.start).not.toHaveBeenCalled();
    beginTrackedTask('export');
    expect(suspensionBlocker.start).toHaveBeenCalledOnce();
    finish();
    await result;
  });

  it('keeps an explicit task registered after one child exits', async () => {
    beginTrackedTask('normal');
    const child = spawnTracked('normal', process.execPath, ['-e', 'process.exit(0)']);
    const [code, signal] = await once(child, 'close');
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(getTaskController('normal')).toMatchObject({
      cancelRequested: false,
      currentProcess: null,
    });
  });

  it('prevents app suspension for the full explicit task instead of each child process', async () => {
    beginTrackedTask('power');
    expect(suspensionBlocker.start).toHaveBeenCalledOnce();
    expect(suspensionBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');

    const child = spawnTracked('power', process.execPath, ['-e', 'process.exit(0)']);
    await once(child, 'close');

    expect(suspensionBlocker.start).toHaveBeenCalledOnce();
    expect(suspensionBlocker.stop).not.toHaveBeenCalled();

    endTrackedTask('power');
    expect(suspensionBlocker.stop).toHaveBeenCalledOnce();
    expect(suspensionBlocker.stop).toHaveBeenCalledWith(73);
  });

  it('prevents app suspension while an external task is active', () => {
    beginExternalTask('external', vi.fn());
    expect(suspensionBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(suspensionBlocker.stop).not.toHaveBeenCalled();

    endExternalTask('external');
    expect(suspensionBlocker.stop).toHaveBeenCalledWith(73);
  });

  it('records user cancellation while no child process is running', async () => {
    beginTrackedTask('gap');
    await cancelTask('gap', 'user');
    expect(getTaskController('gap')).toMatchObject({
      cancelRequested: true,
      cancelReason: 'user',
      currentProcess: null,
    });
    expect(() => spawnTracked('gap', process.execPath, ['-e', 'process.exit(0)']))
      .toThrow('EXPORT_CANCELLED');
  });

  it('classifies cancellation, external termination and real nonzero exits distinctly', () => {
    expect(classifyProcessExit(1, null, { requested: true, reason: 'user' })).toEqual({
      kind: 'cancelled', code: 'EXPORT_CANCELLED', exitCode: 1, signal: null, cancelReason: 'user',
    });
    expect(classifyProcessExit(null, 'SIGTERM', { requested: false, reason: null })).toEqual({
      kind: 'terminated', code: 'EXPORT_TERMINATED', exitCode: null, signal: 'SIGTERM', cancelReason: null,
    });
    expect(classifyProcessExit(7, null, { requested: false, reason: null })).toEqual({
      kind: 'failed', code: 'EXPORT_FAILED', exitCode: 7, signal: null, cancelReason: null,
    });
    expect(classifyProcessExit(0, null, { requested: false, reason: null })).toEqual({
      kind: 'success', code: null, exitCode: 0, signal: null, cancelReason: null,
    });
  });

  it('allows a task terminal state to be recorded only once', () => {
    beginTrackedTask('cancelled');
    expect(markTaskTerminal('cancelled')).toBe(true);
    expect(markTaskTerminal('cancelled')).toBe(false);
    expect(getTaskController('cancelled')?.terminal).toBe(true);
  });

  it('cancels a process without requiring a timeout', async () => {
    const controller = new AbortController();
    const result = runProcess(process.execPath, [
      '-e',
      'setTimeout(() => process.exit(0), 1500); setInterval(() => {}, 1000);',
    ], { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    await expect(result).rejects.toMatchObject({
      name: 'AbortError',
      message: 'PROCESS_CANCELLED',
    });
  });

  it('preserves stdout, stderr and exit code for a failed process', async () => {
    const result = runProcess(process.execPath, [
      '-e',
      "process.stdout.write('diagnostics'); process.stderr.write('failure'); process.exit(7);",
    ]);

    await expect(result).rejects.toMatchObject({
      name: 'ProcessExecutionError',
      stdout: 'diagnostics',
      stderr: 'failure',
      exitCode: 7,
      signal: null,
    });
  });

  it('bounds diagnostics when requested while streaming stdout, retaining the first failure details', async () => {
    const chunks: string[] = [];
    const result = runProcess(process.execPath, [
      '-e',
      "process.stdout.write('frame'); process.stderr.write('first failure: ' + 'x'.repeat(2_000_000), () => process.exit(7));",
    ], { onStdout: (chunk) => chunks.push(chunk), stderrMaxChars: 1024 });

    try {
      await result;
      throw new Error('Expected process failure');
    } catch (error) {
      expect(error).toMatchObject({ name: 'ProcessExecutionError', exitCode: 7 });
      const stderr = (error as { stderr: string }).stderr;
      expect(stderr).toHaveLength(1024);
      expect(stderr.startsWith('first failure: ')).toBe(true);
      expect(chunks.join('')).toBe('frame');
    }
  });

  it('aborts the signal exposed by a tracked task when cancelled', async () => {
    beginTrackedTask('signal');
    const signal = getTaskController('signal')?.signal;
    expect(signal?.aborted).toBe(false);

    await cancelTask('signal', 'user');

    expect(signal?.aborted).toBe(true);
  });
});
