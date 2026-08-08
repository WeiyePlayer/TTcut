import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ProcessResult = { stdout: string; stderr: string; code: number };
export type TaskCancellationReason = 'user' | 'app-exit';
export type ProcessExitClassification = {
  kind: 'success' | 'cancelled' | 'terminated' | 'failed';
  code: 'EXPORT_CANCELLED' | 'EXPORT_TERMINATED' | 'EXPORT_FAILED' | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelReason: TaskCancellationReason | null;
};

export type TaskController = {
  taskId: string;
  abortController: AbortController;
  signal: AbortSignal;
  currentProcess: ChildProcessWithoutNullStreams | null;
  cancelRequested: boolean;
  cancelReason: TaskCancellationReason | null;
  terminal: boolean;
  explicit: boolean;
};

const controllers = new Map<string, TaskController>();
const externalTasks = new Map<string, () => void | Promise<void>>();
const taskCompletions = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function registerCompletion(taskId: string): void {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  taskCompletions.set(taskId, { promise, resolve });
}

function completeTask(taskId: string): void {
  taskCompletions.get(taskId)?.resolve();
  taskCompletions.delete(taskId);
}

function assertTaskSlotAvailable(taskId: string): void {
  if (controllers.has(taskId) || externalTasks.has(taskId)) throw new Error(`Task ${taskId} is already active.`);
  if (controllers.size > 0 || externalTasks.size > 0) throw new Error('TASK_BUSY');
}

export function beginTrackedTask(taskId: string): TaskController {
  assertTaskSlotAvailable(taskId);
  const abortController = new AbortController();
  const controller: TaskController = {
    taskId,
    abortController,
    signal: abortController.signal,
    currentProcess: null,
    cancelRequested: false,
    cancelReason: null,
    terminal: false,
    explicit: true,
  };
  controllers.set(taskId, controller);
  registerCompletion(taskId);
  return controller;
}

export function getTaskController(taskId: string): TaskController | undefined {
  return controllers.get(taskId);
}

export function endTrackedTask(taskId: string): void {
  controllers.delete(taskId);
  completeTask(taskId);
}

export function markTaskTerminal(taskId: string): boolean {
  const controller = controllers.get(taskId);
  if (!controller || controller.terminal) return false;
  controller.terminal = true;
  return true;
}

export function beginExternalTask(taskId: string, cancel: () => void | Promise<void>): void {
  assertTaskSlotAvailable(taskId);
  externalTasks.set(taskId, cancel);
}

export function endExternalTask(taskId: string): void {
  externalTasks.delete(taskId);
}

export function spawnTracked(taskId: string, executable: string, args: readonly string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ChildProcessWithoutNullStreams {
  let controller = controllers.get(taskId);
  if (!controller) {
    assertTaskSlotAvailable(taskId);
    const abortController = new AbortController();
    controller = {
      taskId,
      abortController,
      signal: abortController.signal,
      currentProcess: null,
      cancelRequested: false,
      cancelReason: null,
      terminal: false,
      explicit: false,
    };
    controllers.set(taskId, controller);
    registerCompletion(taskId);
  }
  if (controller.cancelRequested) throw new Error('EXPORT_CANCELLED');
  if (controller.currentProcess) throw new Error(`Task ${taskId} already has a child process.`);
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  controller.currentProcess = child;
  child.once('close', () => {
    if (controller?.currentProcess === child) controller.currentProcess = null;
    if (controller && !controller.explicit) {
      controllers.delete(taskId);
      completeTask(taskId);
    }
  });
  return child;
}

export function classifyProcessExit(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  cancellation: { requested: boolean; reason: TaskCancellationReason | null },
): ProcessExitClassification {
  if (cancellation.requested) {
    return {
      kind: 'cancelled',
      code: 'EXPORT_CANCELLED',
      exitCode,
      signal,
      cancelReason: cancellation.reason,
    };
  }
  if (signal !== null || exitCode === null) {
    return {
      kind: 'terminated',
      code: 'EXPORT_TERMINATED',
      exitCode,
      signal,
      cancelReason: null,
    };
  }
  if (exitCode !== 0) {
    return {
      kind: 'failed',
      code: 'EXPORT_FAILED',
      exitCode,
      signal,
      cancelReason: null,
    };
  }
  return {
    kind: 'success',
    code: null,
    exitCode,
    signal,
    cancelReason: null,
  };
}

export function hasActiveTasks(): boolean {
  return controllers.size > 0 || externalTasks.size > 0;
}

export function activeTaskIds(): string[] {
  return [...new Set([...controllers.keys(), ...externalTasks.keys()])];
}

async function terminateChild(child: ChildProcess): Promise<void> {
  child.kill('SIGTERM');
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', shell: false,
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
    });
  }
}

export async function cancelTask(taskId: string, reason: TaskCancellationReason = 'user'): Promise<void> {
  const cancelExternal = externalTasks.get(taskId);
  if (cancelExternal) {
    await cancelExternal();
    externalTasks.delete(taskId);
    return;
  }
  const controller = controllers.get(taskId);
  if (!controller) return;
  controller.cancelRequested = true;
  controller.cancelReason = reason;
  if (!controller.signal.aborted) controller.abortController.abort();
  if (controller.currentProcess) await terminateChild(controller.currentProcess);
  if (!controller.explicit) {
    controllers.delete(taskId);
    completeTask(taskId);
  }
}

export async function cancelAllTasks(reason: TaskCancellationReason = 'app-exit'): Promise<void> {
  await Promise.all(activeTaskIds().map((taskId) => cancelTask(taskId, reason)));
}

export async function cancelAllTasksAndWait(reason: TaskCancellationReason = 'app-exit'): Promise<void> {
  const completions = activeTaskIds()
    .map((taskId) => taskCompletions.get(taskId)?.promise)
    .filter((value): value is Promise<void> => Boolean(value));
  await cancelAllTasks(reason);
  await Promise.all(completions);
}

export function runProcess(executable: string, args: readonly string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const cancellationError = () => Object.assign(new Error('PROCESS_CANCELLED'), { name: 'AbortError' });
    if (options.signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null;
    const abort = () => { void terminateChild(child); };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', (error) => {
      cleanup();
      reject(options.signal?.aborted ? cancellationError() : error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (options.signal?.aborted) {
        reject(cancellationError());
      } else if (code === 0) {
        resolve({ stdout, stderr, code });
      } else if (code === null || signal !== null) {
        reject(new Error(stderr.trim() || `Process terminated by signal ${String(signal)}`));
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });
  });
}
