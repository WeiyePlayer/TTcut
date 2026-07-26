import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  analysisRequestSchema,
  analysisResultSchema,
  workerEventSchema,
  type AnalysisResultV1,
  type Calibration,
  type WorkerEventV1,
} from '../shared/contracts';
import type { AppEvent } from '../shared/api';
import { IPC } from '../shared/ipc';
import { resolveUsableAnalysisComponents } from './components';
import { logLine } from './logger';
import { getHistoryStore } from './history';
import { probeVideo } from './probe';
import { hasActiveTasks, spawnTracked } from './processes';

let latestResult: AnalysisResultV1 | null = null;

function send(window: BrowserWindow, event: AppEvent): void {
  if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
}

export function getLatestAnalysis(): AnalysisResultV1 | null {
  return latestResult;
}

export function clearLatestAnalysis(): void {
  latestResult = null;
}

export function activateLatestAnalysis(value: AnalysisResultV1): AnalysisResultV1 {
  latestResult = analysisResultSchema.parse(value);
  return latestResult;
}

export async function startAnalysis(
  window: BrowserWindow,
  value: { videoPath: string; calibration: Calibration; device: 'auto' | 'cuda' | 'cpu' },
): Promise<string> {
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  const components = await resolveUsableAnalysisComponents(value.device);
  if (!components.python || !components.weights) throw new Error('RUNTIME_MISSING');
  const metadata = await probeVideo(value.videoPath);
  if (metadata.width !== value.calibration.video_width || metadata.height !== value.calibration.video_height) {
    throw new Error('INVALID_CALIBRATION');
  }
  const taskId = randomUUID();
  const request = analysisRequestSchema.parse({
    schema_version: 1,
    task_id: taskId,
    video_path: metadata.path,
    device: value.device,
    calibration: value.calibration,
  });
  const child = spawnTracked(taskId, components.python, ['-m', 'ttcut_worker.worker'], {
    cwd: components.worker,
    env: {
      ...process.env,
      PYTHONPATH: components.worker,
      PYTHONUTF8: '1',
      TTCUT_TRACKNET_WEIGHTS: components.weights,
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let terminalEvent: Extract<AppEvent, { type: 'analysis-result' | 'error' }> | null = null;
  const protocolFailure = (line: string, error: unknown) => {
    terminalEvent = {
      type: 'error', taskId, code: 'INVALID_WORKER_OUTPUT', message: 'Worker output was invalid.',
    };
    void logLine(taskId, 'ERROR', `Invalid worker JSONL: ${line} :: ${String(error)}`);
    child.kill('SIGTERM');
  };
  const processWorkerLine = (line: string) => {
    if (!line.trim()) return;
    try {
      if (terminalEvent) throw new Error('Worker emitted an event after its terminal event.');
      const parsed = workerEventSchema.parse(JSON.parse(line)) as WorkerEventV1;
      if (parsed.task_id !== taskId) throw new Error('Worker task ID mismatch');
      if (parsed.type === 'progress') {
        send(window, {
          type: 'progress',
          data: {
            taskId,
            kind: 'analysis',
            stage: parsed.stage,
            percent: parsed.stage === 'analysis' ? Math.min(parsed.percent, 99.9) : parsed.percent,
            current: parsed.current,
            total: parsed.total,
          },
        });
      } else if (parsed.type === 'result') {
        const data = analysisResultSchema.parse({ ...parsed.data, video: metadata });
        terminalEvent = { type: 'analysis-result', taskId, data };
      } else {
        terminalEvent = {
          type: 'error', taskId, code: parsed.code, message: parsed.message,
          ...(parsed.log_path ? { logPath: parsed.log_path } : {}),
        };
      }
    } catch (error) {
      protocolFailure(line, error);
    }
  };
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) processWorkerLine(line);
  });
  child.stderr.on('data', (chunk: string) => void logLine(taskId, 'WORKER', chunk));
  child.once('error', (error) => {
    void logLine(taskId, 'ERROR', error.message);
    terminalEvent ??= { type: 'error', taskId, code: 'WORKER_EXITED', message: error.message };
  });
  child.once('close', async (code) => {
    if (stdoutBuffer.trim()) processWorkerLine(stdoutBuffer);
    if (!terminalEvent) {
      send(window, {
        type: 'error', taskId, code: 'WORKER_EXITED',
        message: `Analysis process exited without a terminal event (code ${code ?? -1}).`,
      });
    } else if (terminalEvent.type === 'analysis-result' && code !== 0) {
      send(window, {
        type: 'error', taskId, code: 'WORKER_EXITED',
        message: `Analysis process exited with code ${code ?? -1} after reporting a result.`,
      });
    } else if (terminalEvent.type === 'analysis-result') {
      latestResult = terminalEvent.data;
      try {
        await getHistoryStore().upsert(terminalEvent.data, value.calibration);
      } catch (error) {
        await logLine(taskId, 'WARN', `Analysis history could not be saved: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).catch(() => undefined);
      }
      send(window, terminalEvent);
    } else {
      send(window, terminalEvent);
    }
  });
  child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8');
  void logLine(taskId, 'INFO', `Analysis started for ${path.basename(metadata.path)}`);
  return taskId;
}
