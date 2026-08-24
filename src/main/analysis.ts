import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  analysisRequestSchema,
  analysisResultSchema,
  calibrationResultSchema,
  workerEventSchema,
  type AnalysisResultV1,
  type Calibration,
  type CalibrationChoice,
  type BlurBallAnalysisMode,
  type TableAnalysis,
  type WorkerEventV1,
} from '../shared/contracts';
import type { AppEvent } from '../shared/api';
import { IPC } from '../shared/ipc';
import {
  beginTrackedTask,
  endTrackedTask,
  getTaskController,
  hasActiveTasks,
  spawnTracked,
} from './processes';
import { resolveUsableAnalysisComponents, resolveUsableMediaComponents } from './components';
import { logLine } from './logger';
import { getHistoryStore } from './history';
import { probeVideo } from './probe';
import { overallAnalysisProgress } from '../domain/analysis-progress';
import { requestedAnalysisDevice } from '../domain/analysis-device';
import { analysisProcessEnvironment } from './analysis-environment';
import {
  CfrNormalizationError,
  prepareProcessingMedia,
  removeProcessingCache,
  targetFrameRateRatio,
  type ProcessingMediaOutcome,
} from './processing-media';

function send(window: BrowserWindow, event: AppEvent): void {
  if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
}

type WorkerFailure = Error & { code: string; logPath?: string; cancelled?: boolean };
type ProcessingProgressMode = 'source' | 'normalized';

function safeTargetFrameRateRatio(metadata: Awaited<ReturnType<typeof probeVideo>>): string | null {
  try {
    return targetFrameRateRatio(metadata);
  } catch {
    return null;
  }
}

function workerFailure(code: string, message: string, options: { logPath?: string; cancelled?: boolean } = {}): WorkerFailure {
  return Object.assign(new Error(message), { code, ...options }) as WorkerFailure;
}

function workerEnvironment(
  components: Awaited<ReturnType<typeof resolveUsableAnalysisComponents>>,
  includeBlurball: boolean,
): NodeJS.ProcessEnv {
  return {
    ...analysisProcessEnvironment(process.env),
    PYTHONPATH: components.worker,
    PYTHONUTF8: '1',
    ...(includeBlurball ? { TTCUT_BLURBALL_WEIGHTS: components.blurballWeights } : {}),
    TTCUT_TABLE_ANALYZE_WEIGHTS: components.tableAnalyzeWeights,
  };
}

async function runWorker<T>(options: {
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
      if (terminate && !child.killed) child.kill('SIGTERM');
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

function emitProgress(
  window: BrowserWindow,
  taskId: string,
  event: Extract<WorkerEventV1, { type: 'progress' }>,
  calibrationMethod: CalibrationChoice['method'],
  analysisMode: BlurBallAnalysisMode,
  processingMode: ProcessingProgressMode,
): void {
  send(window, {
    type: 'progress',
    data: {
      taskId,
      kind: 'analysis',
      stage: event.stage,
      percent: overallAnalysisProgress(event.stage, event.percent, calibrationMethod, analysisMode, processingMode),
      current: event.current,
      total: event.total,
    },
  });
}

function workerVideoMetadata(metadata: Awaited<ReturnType<typeof probeVideo>>) {
  return {
    duration_seconds: metadata.duration_seconds,
    fps: metadata.fps,
    frame_count: metadata.frame_count ?? null,
    variable_frame_rate: metadata.variable_frame_rate,
  };
}

export async function startAnalysis(
  window: BrowserWindow,
  value: {
    videoPath: string;
    calibrationChoice: CalibrationChoice;
    device: 'auto' | 'cuda' | 'cpu';
    historyVisibility: 'visible' | 'deferred';
    analysisMode: BlurBallAnalysisMode;
    blurballConfidenceThreshold: number;
    blurballStage1ConfidenceThreshold: number;
    blurballStage2ConfidenceThreshold: number;
  },
): Promise<string> {
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  let sourceMetadata = await probeVideo(value.videoPath);
  if ((value.calibrationChoice.method === 'manual' || value.calibrationChoice.method === 'precalibrated')
    && (sourceMetadata.width !== value.calibrationChoice.calibration.video_width
      || sourceMetadata.height !== value.calibrationChoice.calibration.video_height)) {
    throw new Error('INVALID_CALIBRATION');
  }
  const taskId = randomUUID();
  const requestedDevice = requestedAnalysisDevice(value.device);
  const analysisComponents = await resolveUsableAnalysisComponents(requestedDevice);
  if (!analysisComponents.python) throw new Error('RUNTIME_MISSING');
  const python = analysisComponents.python;
  const mediaComponents = await resolveUsableMediaComponents();
  const encoder = mediaComponents.mediaEncoder === 'unavailable' ? null : mediaComponents.mediaEncoder;
  const controller = beginTrackedTask(taskId);
  let processing: ProcessingMediaOutcome | null = null;
  let historySaved = false;

  void (async () => {
    try {
      let calibrationChoice: CalibrationChoice = value.calibrationChoice;
      if (calibrationChoice.method === 'automatic') {
        const calibrationRequest = analysisRequestSchema.parse({
          schema_version: 1,
          task_id: taskId,
          video_path: sourceMetadata.path,
          device: requestedDevice,
          video_metadata: workerVideoMetadata(sourceMetadata),
          calibration_choice: calibrationChoice,
        });
        const calibrationData = await runWorker({
          taskId,
          executable: python,
          args: ['-m', 'ttcut_worker.calibration_worker'],
          cwd: analysisComponents.worker,
          env: workerEnvironment(analysisComponents, false),
          request: calibrationRequest,
          parseResult: (data): { calibration: Calibration; table_analysis: TableAnalysis } => calibrationResultSchema.parse(data),
          onProgress: (event) => emitProgress(window, taskId, event, 'automatic', value.analysisMode, 'normalized'),
        });
        calibrationChoice = {
          method: 'precalibrated',
          calibration: calibrationData.calibration,
          table_analysis: calibrationData.table_analysis,
        };
      }

      // The initial probe feeds the calibration UI/worker. Probe the original
      // again after calibration so VFR detection and the cache identity belong
      // to the exact source that will enter the processing stage.
      sourceMetadata = await probeVideo(value.videoPath, controller.signal);
      if (sourceMetadata.width !== calibrationChoice.calibration.video_width
        || sourceMetadata.height !== calibrationChoice.calibration.video_height) {
        throw workerFailure('INVALID_CALIBRATION', 'The source dimensions changed during calibration.');
      }

      const canNormalize = Boolean(mediaComponents.ffmpeg)
        && mediaComponents.mediaEncoder !== 'unavailable';
      if (controller.cancelRequested || controller.signal.aborted) {
        throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
      }
      if (!sourceMetadata.variable_frame_rate) {
        processing = await prepareProcessingMedia(
          taskId,
          sourceMetadata,
          encoder ?? 'libopenh264',
          mediaComponents.ffmpeg ?? '',
          controller.signal,
          () => undefined,
        );
      } else if (!canNormalize) {
        if (controller.cancelRequested || controller.signal.aborted) {
          throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
        }
        send(window, {
          type: 'progress',
          data: {
            taskId,
            kind: 'analysis',
            stage: 'video_normalization',
            percent: value.calibrationChoice.method === 'automatic' ? 5 : 0,
          },
        });
        processing = {
          metadata: sourceMetadata,
          mode: 'vfr_fallback',
          targetFpsRatio: safeTargetFrameRateRatio(sourceMetadata),
          encoder,
          warningCode: 'CFR_MEDIA_COMPONENT_MISSING',
          cachePath: null,
          cacheKey: null,
          cacheCreated: false,
        };
        send(window, {
          type: 'progress',
          data: {
            taskId,
            kind: 'analysis',
            stage: 'video_normalization',
            percent: value.calibrationChoice.method === 'automatic' ? 30 : 25,
          },
        });
      } else {
        try {
          send(window, {
            type: 'progress',
            data: {
              taskId,
              kind: 'analysis',
              stage: 'video_normalization',
              percent: value.calibrationChoice.method === 'automatic' ? 5 : 0,
            },
          });
          processing = await prepareProcessingMedia(
            taskId,
            sourceMetadata,
            encoder!,
            mediaComponents.ffmpeg!,
            controller.signal,
            (percent) => send(window, {
              type: 'progress',
              data: {
                taskId,
                kind: 'analysis',
                stage: 'video_normalization',
                percent: (value.calibrationChoice.method === 'automatic' ? 5 : 0) + percent * 0.25,
              },
            }),
          );
        } catch (error) {
          if (controller.cancelRequested || controller.signal.aborted
            || (error instanceof CfrNormalizationError && error.cancelled)) {
            throw new CfrNormalizationError('CFR_NORMALIZATION_CANCELLED', 'CFR normalization was cancelled.', true);
          }
          if (error instanceof CfrNormalizationError && error.code === 'INPUT_MOVED') throw error;
          const warningCode = error instanceof CfrNormalizationError ? error.code : 'CFR_TRANSCODE_FAILED';
          await logLine(taskId, 'WARN', `CFR normalization failed; continuing with source VFR: ${warningCode}`).catch(() => undefined);
          processing = {
            metadata: sourceMetadata,
            mode: 'vfr_fallback',
            targetFpsRatio: safeTargetFrameRateRatio(sourceMetadata),
            encoder,
            warningCode,
            cachePath: null,
            cacheKey: null,
            cacheCreated: false,
          };
          send(window, {
            type: 'progress',
            data: {
              taskId,
              kind: 'analysis',
              stage: 'video_normalization',
              percent: value.calibrationChoice.method === 'automatic' ? 30 : 25,
            },
          });
        }
      }
      if (!processing) throw workerFailure('CFR_PROCESSING_MEDIA_MISSING', 'Processing media was not prepared.');
      const request = analysisRequestSchema.parse({
        schema_version: 2,
        task_id: taskId,
        video_path: processing.metadata.path,
        device: requestedDevice,
        video_metadata: workerVideoMetadata(processing.metadata),
        calibration_choice: calibrationChoice,
        analysis: value.analysisMode === 'full'
          ? { mode: 'full', confidence_threshold: value.blurballConfidenceThreshold }
          : {
            mode: 'two_stage',
            stage1_confidence_threshold: value.blurballStage1ConfidenceThreshold,
            stage2_confidence_threshold: value.blurballStage2ConfidenceThreshold,
          },
      });
      const workerResult = await runWorker({
        taskId,
        executable: python,
        args: ['-m', 'ttcut_worker.worker'],
        cwd: analysisComponents.worker,
        env: workerEnvironment(analysisComponents, true),
        request,
        parseResult: (data): AnalysisResultV1 => analysisResultSchema.parse(data),
        onProgress: (event) => emitProgress(
          window,
          taskId,
          event,
          value.calibrationChoice.method,
          value.analysisMode,
          sourceMetadata.variable_frame_rate ? 'normalized' : 'source',
        ),
      });
      const data = analysisResultSchema.parse({
        ...workerResult,
        video: processing.metadata,
        source_video: sourceMetadata,
        processing: {
          mode: processing.mode,
          target_fps_ratio: processing.targetFpsRatio,
          encoder: processing.encoder,
          warning_code: processing.warningCode,
        },
      });
      const calibration: Calibration | undefined = data.calibration ?? calibrationChoice.calibration;
      if (!calibration) throw workerFailure('ANALYSIS_CALIBRATION_MISSING', 'Worker did not return calibration.');
      if (controller.cancelRequested || controller.signal.aborted) {
        throw workerFailure('ANALYSIS_CANCELLED', 'Analysis was cancelled.', { cancelled: true });
      }
      let record: Awaited<ReturnType<ReturnType<typeof getHistoryStore>['upsert']>>;
      try {
        record = await getHistoryStore().upsert(
          data,
          calibration,
          value.historyVisibility === 'visible' || data.rallies.length === 0,
        );
      } catch (error) {
        throw workerFailure('ANALYSIS_SAVE_FAILED', error instanceof Error ? error.message : String(error));
      }
      historySaved = true;
      if (controller.cancelRequested || controller.signal.aborted) {
        throw workerFailure('ANALYSIS_CANCELLED', 'Analysis was cancelled.', { cancelled: true });
      }
      send(window, { type: 'analysis-result', taskId, analysisId: record.id, calibration, data });
    } catch (error) {
      const cancelled = controller.cancelRequested
        || (error instanceof CfrNormalizationError && error.cancelled)
        || (error instanceof Error && 'cancelled' in error && Boolean((error as WorkerFailure).cancelled));
      const code = cancelled ? 'ANALYSIS_CANCELLED'
        : error instanceof Error && 'code' in error ? String((error as WorkerFailure).code) : 'ANALYSIS_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const logPath = error instanceof Error && 'logPath' in error ? String((error as WorkerFailure).logPath) : undefined;
      await logLine(taskId, 'ERROR', `Analysis failed: ${message}`).catch(() => undefined);
      send(window, { type: 'error', taskId, code, message, ...(logPath ? { logPath } : {}) });
    } finally {
      if (!historySaved && processing?.cacheCreated && processing.cachePath) {
        const stillReferenced = await getHistoryStore().hasProcessingMediaReference(processing.cachePath).catch(() => false);
        if (!stillReferenced) {
          await removeProcessingCache({
            schema_version: 1,
            video: processing.metadata,
            source_video: sourceMetadata,
            processing: {
              mode: processing.mode,
              target_fps_ratio: processing.targetFpsRatio,
              encoder: processing.encoder,
              warning_code: processing.warningCode,
            },
            rallies: [],
          } as AnalysisResultV1).catch(() => undefined);
        }
      }
      endTrackedTask(taskId);
    }
  })();
  void logLine(taskId, 'INFO', `Analysis started for ${path.basename(sourceMetadata.path)}`);
  return taskId;
}
