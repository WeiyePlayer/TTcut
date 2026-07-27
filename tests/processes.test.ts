import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginTrackedTask,
  cancelAllTasks,
  cancelTask,
  classifyProcessExit,
  endTrackedTask,
  getTaskController,
  markTaskTerminal,
  spawnTracked,
} from '../src/main/processes';

afterEach(async () => {
  await cancelAllTasks('app-exit');
  for (const taskId of ['normal', 'gap', 'cancelled']) endTrackedTask(taskId);
});

describe('tracked task lifecycle', () => {
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
});
