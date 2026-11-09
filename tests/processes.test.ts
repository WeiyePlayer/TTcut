import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeTaskIds,
  beginExternalTask,
  beginTrackedTask,
  cancelAllTasks,
  cancelTask,
  classifyProcessExit,
  configureTaskSuspensionBlocker,
  endExternalTask,
  endTrackedTask,
  getTaskController,
  hasActiveTasks,
  hasPreemptibleTasks,
  markTaskTerminal,
  onTasksIdle,
  runProcess,
  spawnTracked,
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
  it('lets a user-started task preempt a disposable preview instead of reporting TASK_BUSY', async () => {
    const preview = beginTrackedTask('preview', { preemptible: true });
    const child = spawnTracked('preview', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const closed = once(child, 'close');
    expect(hasActiveTasks()).toBe(false);
    expect(hasPreemptibleTasks()).toBe(true);

    expect(() => beginTrackedTask('analysis')).not.toThrow();
    expect(preview.signal.aborted).toBe(true);
    expect(preview.cancelRequested).toBe(true);
    await closed;
    endTrackedTask('preview');
    expect(hasPreemptibleTasks()).toBe(false);
    expect(activeTaskIds()).toEqual(['analysis']);
  });

  it('keeps a preview waiting while a user-started task is active', () => {
    beginTrackedTask('export');
    expect(() => beginTrackedTask('preview', { preemptible: true })).toThrow('TASK_BUSY');
    expect(hasPreemptibleTasks()).toBe(false);
  });

  it('still cancels a running preview on app exit', async () => {
    const preview = beginTrackedTask('preview', { preemptible: true });
    await cancelAllTasks('app-exit');
    expect(preview.signal.aborted).toBe(true);
    endTrackedTask('preview');
  });

  it('announces once when the last user-started task ends, but not for preview-only changes', async () => {
    const idle = vi.fn();
    const off = onTasksIdle(idle);
    beginTrackedTask('preview', { preemptible: true });
    endTrackedTask('preview');
    expect(idle).not.toHaveBeenCalled();

    beginTrackedTask('analysis');
    expect(() => beginTrackedTask('preview', { preemptible: true })).toThrow('TASK_BUSY');
    expect(idle).not.toHaveBeenCalled();
    endTrackedTask('analysis');
    expect(idle).toHaveBeenCalledTimes(1);

    beginExternalTask('native-export', () => undefined);
    endExternalTask('native-export');
    expect(idle).toHaveBeenCalledTimes(2);

    beginTrackedTask('export');
    await cancelTask('export');
    expect(idle).toHaveBeenCalledTimes(2);
    endTrackedTask('export');
    expect(idle).toHaveBeenCalledTimes(3);

    const child = spawnTracked('implicit', process.execPath, ['-e', 'process.exit(0)']);
    await once(child, 'close');
    expect(idle).toHaveBeenCalledTimes(4);

    beginExternalTask('external-cancel', () => undefined);
    await cancelTask('external-cancel');
    expect(idle).toHaveBeenCalledTimes(5);

    off();
    beginTrackedTask('after-off');
    endTrackedTask('after-off');
    expect(idle).toHaveBeenCalledTimes(5);
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
