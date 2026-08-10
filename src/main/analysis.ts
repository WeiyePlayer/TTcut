import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  analysisRequestSchema,
  analysisResultSchema,
  workerEventSchema,
  type Calibration,
  type CalibrationChoice,
  type BallModelProfile,
  type WorkerEventV1,
} from '../shared/contracts';
import type { AppEvent } from '../shared/api';
import { IPC } from '../shared/ipc';
import { resolveUsableAnalysisComponents, validateDualBallModels } from './components';
import { logLine } from './logger';
import { getHistoryStore } from './history';
import { probeVideo } from './probe';
import { hasActiveTasks, spawnTracked } from './processes';
import { overallAnalysisProgress } from '../domain/analysis-progress';
import { analysisProcessEnvironment } from './analysis-environment';

function send(window: BrowserWindow, event: AppEvent): void {
  if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
}

export async function startAnalysis(
  window: BrowserWindow,
  value: {
    videoPath: string;
    calibrationChoice: CalibrationChoice;
    device: 'auto' | 'cuda' | 'cpu';
    historyVisibility: 'visible' | 'deferred';
    ballModelProfile: BallModelProfile;
  },
): Promise<string> {
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  const metadata = await probeVideo(value.videoPath);
  if ((value.calibrationChoice.method === 'manual' || value.calibrationChoice.method === 'precalibrated')
    && (metadata.width !== value.calibrationChoice.calibration.video_width
      || metadata.height !== value.calibrationChoice.calibration.video_height)) {
    throw new Error('INVALID_CALIBRATION');
  }
  const taskId = randomUUID();
  const requestedDevice = value.ballModelProfile === 'tracknet_v1' ? value.device : 'cuda';
  const components = await resolveUsableAnalysisComponents(requestedDevice);
  if (!components.python) throw new Error('RUNTIME_MISSING');
  if (value.ballModelProfile === 'uplifting_dual_v1') await validateDualBallModels(components);
  const request = analysisRequestSchema.parse({
    schema_version: 2,
    task_id: taskId,
    video_path: metadata.path,
    device: requestedDevice,
    ball_model_profile: value.ballModelProfile,
    video_metadata: {
      duration_seconds: metadata.duration_seconds,
      fps: metadata.fps,
      frame_count: metadata.frame_count ?? null,
      variable_frame_rate: metadata.variable_frame_rate,
    },
    calibration_choice: value.calibrationChoice,
  });
  const child = spawnTracked(taskId, components.python, ['-m', 'ttcut_worker.worker'], {
    cwd: components.worker,
    env: {
      ...analysisProcessEnvironment(process.env),
      PYTHONPATH: components.worker,
      PYTHONUTF8: '1',
      TTCUT_TRACKNET_WEIGHTS: components.tracknetWeights,
      TTCUT_BLURBALL_WEIGHTS: components.blurballWeights,
      TTCUT_TABLE_ANALYZE_WEIGHTS: components.tableAnalyzeWeights,
      TTCUT_DUAL_BALL_MAIN_WEIGHTS: components.dualBallMainWeights,
      TTCUT_DUAL_BALL_AUX_WEIGHTS: components.dualBallAuxWeights,
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let terminalEvent: Extract<AppEvent, { type: 'analysis-result' | 'error' }> | null = null;
  const protocolFailure = (line: string, error: unknown) => {
    terminalEvent = { type: 'error', taskId, code: 'INVALID_WORKER_OUTPUT', message: 'Worker output was invalid.' };
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
            percent: overallAnalysisProgress(parsed.stage, parsed.percent, value.calibrationChoice.method),
            current: parsed.current,
            total: parsed.total,
          },
        });
      } else if (parsed.type === 'result') {
        const data = analysisResultSchema.parse({ ...parsed.data, video: metadata });
        const calibration = data.calibration
          ?? (value.calibrationChoice.method !== 'automatic' ? value.calibrationChoice.calibration : null);
        if (!calibration) throw new Error('Worker did not return calibration.');
        terminalEvent = {
          type: 'analysis-result', taskId, analysisId: randomUUID(), calibration, data,
        };
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
  child.once('close', async (code, signal) => {
    if (stdoutBuffer.trim()) processWorkerLine(stdoutBuffer);
    if (!terminalEvent) {
      send(window, { type: 'error', taskId, code: 'WORKER_EXITED', message: `Analysis process exited without a terminal event (code ${String(code)}, signal ${String(signal)}).` });
    } else if (terminalEvent.type === 'analysis-result' && code !== 0) {
      send(window, { type: 'error', taskId, code: 'WORKER_EXITED', message: `Analysis process exited with code ${String(code)} and signal ${String(signal)} after reporting a result.` });
    } else if (terminalEvent.type === 'analysis-result') {
      try {
        const record = await getHistoryStore().upsert(
          terminalEvent.data,
          terminalEvent.calibration,
          value.historyVisibility === 'visible' || terminalEvent.data.rallies.length === 0,
        );
        send(window, { ...terminalEvent, analysisId: record.id });
      } catch (error) {
        await logLine(taskId, 'ERROR', `Analysis could not be saved: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).catch(() => undefined);
        send(window, { type: 'error', taskId, code: 'ANALYSIS_SAVE_FAILED', message: String(error) });
      }
    } else {
      send(window, terminalEvent);
    }
  });
  child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8');
  void logLine(taskId, 'INFO', `Analysis started for ${path.basename(metadata.path)}`);
  return taskId;
}
