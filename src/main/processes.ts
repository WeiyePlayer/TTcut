import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type ProcessResult = { stdout: string; stderr: string; code: number };

const active = new Map<string, ChildProcessWithoutNullStreams>();
const externalTasks = new Map<string, () => void | Promise<void>>();

function assertTaskSlotAvailable(taskId: string): void {
  if (active.has(taskId) || externalTasks.has(taskId)) throw new Error(`Task ${taskId} is already active.`);
  if (active.size > 0 || externalTasks.size > 0) throw new Error('TASK_BUSY');
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
  assertTaskSlotAvailable(taskId);
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  active.set(taskId, child);
  child.once('close', () => active.delete(taskId));
  return child;
}

export function hasActiveTasks(): boolean {
  return active.size > 0 || externalTasks.size > 0;
}

export function activeTaskIds(): string[] {
  return [...new Set([...active.keys(), ...externalTasks.keys()])];
}

export async function cancelTask(taskId: string): Promise<void> {
  const cancelExternal = externalTasks.get(taskId);
  if (cancelExternal) {
    await cancelExternal();
    externalTasks.delete(taskId);
    return;
  }
  const child = active.get(taskId);
  if (!child) return;
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
  active.delete(taskId);
}

export async function cancelAllTasks(): Promise<void> {
  await Promise.all(activeTaskIds().map(cancelTask));
}

export function runProcess(executable: string, args: readonly string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
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
    child.once('error', reject);
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      const numericCode = code ?? -1;
      if (numericCode === 0) resolve({ stdout, stderr, code: numericCode });
      else reject(new Error(stderr.trim() || `Process exited with code ${numericCode}`));
    });
  });
}
