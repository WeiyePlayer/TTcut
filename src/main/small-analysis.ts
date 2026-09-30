import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { AnalysisStartInput, AppEvent } from '../shared/api';
import { smallAnalysisRequestSchema, smallAnalysisResultSchema } from '../shared/contracts';
import { IPC } from '../shared/ipc';
import { resolveSmallComponents } from './small-components';
import { runWorker } from './analysis-worker';
import { beginTrackedTask, endTrackedTask, hasActiveTasks } from './processes';
import { probeVideo } from './probe';
import { getHistoryStore } from './history';
import { logLine } from './logger';
import {
  CfrNormalizationError, prepareProcessingMedia, retainOriginalVfrMedia,
  removeProcessingCache, targetFrameRateRatio, type ProcessingMediaOutcome,
} from './processing-media';

export async function startSmallAnalysis(
  window: BrowserWindow,
  input: Extract<AnalysisStartInput, { analysisBackend: 'mobilenet_small' }> & { device: 'auto' | 'cuda' | 'cpu' },
): Promise<string> {
  if (hasActiveTasks()) throw new Error('TASK_BUSY');
  const components = await resolveSmallComponents();
  const source = await probeVideo(input.videoPath);
  const taskId = randomUUID();
  const controller = beginTrackedTask(taskId);
  const normalizationWeight = source.variable_frame_rate && input.normalizeVariableFrameRate ? 20 : 0;
  const send = (event: AppEvent) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event);
  };
  const progress = (stage: string, percent: number) => send({
    type: 'progress', data: { taskId, kind: 'analysis', stage, percent },
  });
  const assertActive = () => {
    if (controller.cancelRequested || controller.signal.aborted) {
      throw new CfrNormalizationError('ANALYSIS_CANCELLED', 'Analysis was cancelled.', true);
    }
  };

  void (async () => {
    let processing: ProcessingMediaOutcome | null = null;
    let saved = false;
    try {
      assertActive();
      const media = components.media;
      if (source.variable_frame_rate && !input.normalizeVariableFrameRate) {
        processing = retainOriginalVfrMedia(source);
      } else {
        try {
          processing = await prepareProcessingMedia(
            taskId, source, media.mediaEncoder === 'unavailable' ? 'libx264' : media.mediaEncoder,
            media.ffmpeg!, controller.signal,
            value => progress('video_normalization', value * normalizationWeight / 100),
          );
        } catch (error) {
          assertActive();
          if (!source.variable_frame_rate || (error instanceof CfrNormalizationError
            && (error.cancelled || error.code === 'INPUT_MOVED'))) throw error;
          let ratio: string | null = null;
          try { ratio = targetFrameRateRatio(source); } catch { /* Keep VFR fallback behavior. */ }
          processing = {
            metadata: source, mode: 'vfr_fallback', targetFpsRatio: ratio,
            encoder: media.mediaEncoder === 'unavailable' ? null : media.mediaEncoder,
            warningCode: error instanceof CfrNormalizationError ? error.code : 'CFR_TRANSCODE_FAILED',
            cachePath: null, cacheKey: null, cacheCreated: false,
          };
          await logLine(taskId, 'WARN', `Small CFR fallback: ${String(error)}`).catch(() => undefined);
        }
      }
      assertActive();
      const request = smallAnalysisRequestSchema.parse({
        schema_version: 6, task_id: taskId, video_path: processing.metadata.path,
        video_metadata: processing.metadata, device: input.device, sampling_fps: 6,
      });
      // The upstream decoder resolves ffmpeg/ffprobe by name. Supply TTcut's
      // validated media tools without changing the user's global PATH.
      const env = { ...process.env };
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
      env[pathKey] = [path.dirname(media.ffmpeg!), path.dirname(media.ffprobe!), env[pathKey] ?? ''].join(path.delimiter);
      const result = await runWorker({
        taskId, executable: components.python,
        args: ['-B', '-m', 'ttcut_worker.mobilenet_small'], cwd: components.worker,
        env: { ...env, PYTHONPATH: components.worker, PYTHONUTF8: '1', TTCUT_MOBILENET_ROOT: components.root },
        request, parseResult: data => smallAnalysisResultSchema.parse(data),
        onProgress: event => {
          const percent = event.stage === 'load_model' ? normalizationWeight + event.percent * 0.02
            : event.stage === 'postprocess' ? 98 + event.percent * 0.01
              : normalizationWeight + 2 + event.percent * (96 - normalizationWeight) / 100;
          progress(event.stage, percent);
        },
      });
      assertActive();
      const data = smallAnalysisResultSchema.parse({
        ...result, video: processing.metadata, source_video: source,
        processing: {
          mode: processing.mode, target_fps_ratio: processing.targetFpsRatio,
          encoder: processing.encoder, warning_code: processing.warningCode,
        },
      });
      const record = await getHistoryStore().upsert(data, undefined, input.historyVisibility === 'visible' || data.rallies.length === 0);
      saved = true;
      assertActive();
      await logLine(taskId, 'INFO', `Small analysis saved: ${JSON.stringify({ rallies: data.rallies.length, ...data.small_model })}`).catch(() => undefined);
      progress('postprocess', 100);
      send({ type: 'analysis-result', taskId, analysisId: record.id, data });
    } catch (error) {
      const cancelled = controller.cancelRequested || controller.signal.aborted
        || (error instanceof CfrNormalizationError && error.cancelled);
      const code = cancelled ? 'ANALYSIS_CANCELLED'
        : error instanceof Error && 'code' in error ? String(error.code) : 'ANALYSIS_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      await logLine(taskId, 'ERROR', `Small analysis failed: ${message}`).catch(() => undefined);
      send({ type: 'error', taskId, code, message });
    } finally {
      if (!saved && processing?.cacheCreated && processing.cachePath) {
        const referenced = await getHistoryStore().hasProcessingMediaReference(processing.cachePath).catch(() => false);
        if (!referenced) {
          await removeProcessingCache({
            schema_version: 1, video: processing.metadata, source_video: source, rallies: [],
            processing: { mode: processing.mode, target_fps_ratio: processing.targetFpsRatio,
              encoder: processing.encoder, warning_code: processing.warningCode },
          }).catch(() => undefined);
        }
      }
      endTrackedTask(taskId);
    }
  })();
  return taskId;
}
