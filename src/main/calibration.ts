import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  analysisRequestSchema,
  calibrationResultSchema,
  workerEventSchema,
  type WorkerEventV1,
} from '../shared/contracts';
import type { AppEvent } from '../shared/api';
import { IPC } from '../shared/ipc';
import { resolveUsableAnalysisComponents } from './components';
import { logLine } from './logger';
import { probeVideo } from './probe';
import { hasActiveTasks, spawnTracked } from './processes';

function send(window: BrowserWindow, event: AppEvent): void {
  if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
}

export async function startAutoCalibration(
  window: BrowserWindow,
  value: {
    videoPath: string;
    device: 'auto' | 'cuda' | 'cpu';
  },
): Promise<string> {
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  const metadata = await probeVideo(value.videoPath);
  const taskId = randomUUID();
  const components = await resolveUsableAnalysisComponents(value.device);
  if (!components.python) throw new Error('RUNTIME_MISSING');
  const request = analysisRequestSchema.parse({
    schema_version: 1,
    task_id: taskId,
    video_path: metadata.path,
    device: value.device,
    video_metadata: {
      duration_seconds: metadata.duration_seconds,
      fps: metadata.fps,
      frame_count: metadata.frame_count ?? null,
      variable_frame_rate: metadata.variable_frame_rate,
    },
    calibration_choice: { method: 'automatic' },
  });
  const child = spawnTracked(taskId, components.python, ['-m', 'ttcut_worker.calibration_worker'], {
    cwd: components.worker,
    env: {
      ...process.env,
      PYTHONPATH: components.worker,
      PYTHONUTF8: '1',
      TTCUT_TRACKNET_WEIGHTS: components.tracknetWeights,
      TTCUT_TABLE_ANALYZE_WEIGHTS: components.tableAnalyzeWeights,
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let terminalEvent: Extract<AppEvent, { type: 'calibration-result' | 'error' }> | null = null;
  const protocolFailure = (line: string, error: unknown) => {
    terminalEvent = { type: 'error', taskId, code: 'INVALID_WORKER_OUTPUT', message: 'Worker output was invalid.' };
    void logLine(taskId, 'ERROR', `Invalid calibration worker JSONL: ${line} :: ${String(error)}`);
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
            kind: 'calibration',
            stage: parsed.stage,
            percent: parsed.percent,
            current: parsed.current,
            total: parsed.total,
          },
        });
      } else if (parsed.type === 'result') {
        const data = calibrationResultSchema.parse(parsed.data);
        terminalEvent = {
          type: 'calibration-result',
          taskId,
          calibration: data.calibration,
          tableAnalysis: data.table_analysis,
        };
      } else {
        terminalEvent = {
          type: 'error',
          taskId,
          code: parsed.code,
          message: parsed.message,
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
  child.once('close', (code, signal) => {
    if (stdoutBuffer.trim()) processWorkerLine(stdoutBuffer);
    if (!terminalEvent) {
      send(window, {
        type: 'error',
        taskId,
        code: 'WORKER_EXITED',
        message: `Calibration process exited without a terminal event (code ${String(code)}, signal ${String(signal)}).`,
      });
    } else if (terminalEvent.type === 'calibration-result' && code !== 0) {
      send(window, {
        type: 'error',
        taskId,
        code: 'WORKER_EXITED',
        message: `Calibration process exited with code ${String(code)} and signal ${String(signal)} after reporting a result.`,
      });
    } else {
      send(window, terminalEvent);
    }
  });
  child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8');
  void logLine(taskId, 'INFO', `Automatic calibration started for ${path.basename(metadata.path)}`);
  return taskId;
}
