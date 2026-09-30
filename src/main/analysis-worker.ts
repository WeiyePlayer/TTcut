import type { WorkerEventV1 } from '../shared/contracts';
import { workerEventSchema } from '../shared/contracts';
import { spawnTracked, getTaskController, terminateChild } from './processes';
import { logLine } from './logger';

type WorkerFailure = Error & { code: string; logPath?: string; cancelled?: boolean };
function workerFailure(code: string, message: string, options: { logPath?: string; cancelled?: boolean } = {}): WorkerFailure {
  return Object.assign(new Error(message), { code, ...options });
}

export async function runWorker<T>(options: {
  taskId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  request: unknown;
  parseResult: (data: unknown) => T;
  onProgress: (event: Extract<WorkerEventV1, { type: 'progress' }>) => void;
}): Promise<T> {
  const { taskId, executable, args, cwd, env, request, parseResult, onProgress } = options;
  return new Promise<T>((resolve, reject) => {
    const child = spawnTracked(taskId, executable, args, { cwd, env });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdoutBuffer = '';
    let result: T | null = null;
    let terminalFailure: WorkerFailure | null = null;
    const fail = (failure: WorkerFailure, terminate = true) => {
      if (!terminalFailure) terminalFailure = failure;
      if (terminate && !child.killed) void terminateChild(child);
    };
    const parseLine = (line: string) => {
      if (!line.trim() || terminalFailure) return;
      try {
        const parsed = workerEventSchema.parse(JSON.parse(line)) as WorkerEventV1;
        if (parsed.task_id !== taskId) throw new Error('Worker task ID mismatch');
        if (result !== null) throw new Error('Worker emitted an event after its terminal result.');
        if (parsed.type === 'progress') onProgress(parsed);
        else if (parsed.type === 'result') result = parseResult(parsed.data);
        else fail(workerFailure(parsed.code, parsed.message, parsed.log_path ? { logPath: parsed.log_path } : {}));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void logLine(taskId, 'ERROR', `Invalid worker JSONL: ${line} :: ${detail}`);
        fail(workerFailure('INVALID_WORKER_OUTPUT', 'Worker output was invalid.'));
      }
    };
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach(parseLine);
    });
    child.stderr.on('data', (chunk: string) => void logLine(taskId, 'WORKER', chunk));
    child.once('error', (error) => fail(workerFailure('WORKER_EXITED', error.message), false));
    child.once('close', (code, signal) => {
      if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
      const controller = getTaskController(taskId);
      if (controller?.cancelRequested) {
        reject(workerFailure('ANALYSIS_CANCELLED', 'Analysis was cancelled.', { cancelled: true }));
      } else if (terminalFailure) {
        reject(terminalFailure);
      } else if (result === null || code !== 0 || signal !== null) {
        reject(workerFailure('WORKER_EXITED', `Worker exited without a valid result (code ${String(code)}, signal ${String(signal)}).`));
      } else {
        resolve(result);
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8');
  });
}
