import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';
import { analysisResultSchema, calibrationSchema, tableAnalysisSchema, type Calibration, type TableAnalysis, type AnalysisResultV1 } from '../../shared/contracts';
import type { NativeEvent } from '../../shared/native-contracts';
import type { AppEvent } from '../../shared/api';
import { IPC } from '../../shared/ipc';
import { overallAnalysisProgress } from '../../domain/analysis-progress';
import { beginTrackedTask, endTrackedTask } from '../processes';
import { getHistoryStore } from '../history';
import { callNative, probeMacVideo, renderMacMedia } from './client';
import { logLine } from '../logger';
import { removeProcessingCache } from '../processing-media';

type AnalysisOptions = Parameters<typeof import('../analysis').startAnalysis>[1];
const checkpoint = { blurball: '3545206c7155194ea654899d33579c88c9fd8e82c632cbdbae3b0c0ec3f2985f', table: '160e1a9b2d0236b501dc4a4d38bbfb39315eeef6de5d8c11770452623ff102df' };
const corners = ['top_left', 'top_right', 'bottom_right', 'bottom_left'] as const;
function send(window: BrowserWindow, event: AppEvent) { if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event); }
function readCalibration(event: NativeEvent): { calibration: Calibration; table: TableAnalysis } {
  if (!event.calibration || !event.tableSamples) throw new Error('NATIVE_CALIBRATION_RESULT_MISSING');
  return {
    calibration: calibrationSchema.parse({ video_width: event.calibration.width, video_height: event.calibration.height, points: Object.fromEntries(corners.map((name, i) => [name, [event.calibration!.points[i]!.x, event.calibration!.points[i]!.y]])) }),
    table: tableAnalysisSchema.parse({ schema_version: 2, engine: 'coreml', compute_units: 'cpuOnly', checkpoint_sha256: checkpoint.table, aggregation_rule: 'closest_valid_table_pair_mean', sampling: event.tableSamples }),
  };
}
function nativeCalibration(calibration: Calibration) {
  return { width: calibration.video_width, height: calibration.video_height, points: corners.map((key) => ({ x: calibration.points[key][0], y: calibration.points[key][1] })) };
}
async function identity(file: string) { const value = await stat(file); if (!value.isFile()) throw new Error('INPUT_MOVED'); return JSON.stringify([path.resolve(file), value.size, value.mtimeMs]); }

export async function startMacCalibration(window: BrowserWindow, value: { videoPath: string; device: string }): Promise<string> {
  if (value.device === 'cuda') throw new Error('UNSUPPORTED_ANALYSIS_DEVICE');
  const taskId = randomUUID(); const controller = beginTrackedTask(taskId);
  void (async () => {
    let terminal: AppEvent;
    try {
      const video = await probeMacVideo(value.videoPath, controller.signal);
      const result = readCalibration(await callNative('TTcutWorker', { operation: 'calibrate', video: video.native_video, mode: 'full', confidence: 0.7, stage1Confidence: 0.3, stage2Confidence: 0.7 }, {
        taskId, onProgress: (event) => send(window, { type: 'progress', data: { taskId, kind: 'calibration', stage: event.stage!, percent: event.total ? event.current! / event.total * 100 : 0 } }),
      }));
      terminal = { type: 'calibration-result', taskId, calibration: result.calibration, tableAnalysis: result.table };
    } catch (error) { terminal = failure(taskId, error, controller.cancelRequested, 'CALIBRATION'); }
    endTrackedTask(taskId); send(window, terminal);
  })();
  return taskId;
}
function failure(taskId: string, error: unknown, cancelled: boolean, kind: string): AppEvent {
  const code = cancelled ? `${kind}_CANCELLED` : error instanceof Error && 'code' in error ? String(error.code) : `${kind}_FAILED`;
  return { type: 'error', taskId, code, message: error instanceof Error ? error.message : String(error) };
}
export async function startMacAnalysis(window: BrowserWindow, value: AnalysisOptions): Promise<string> {
  if (value.device === 'cuda') throw new Error('UNSUPPORTED_ANALYSIS_DEVICE');
  const taskId = randomUUID(); const controller = beginTrackedTask(taskId);
  void (async () => {
    let terminal: AppEvent; let data: AnalysisResultV1 | undefined; let createdCache: string | undefined; let saved = false;
    try {
      const originalIdentity = await identity(value.videoPath);
      const source = await probeMacVideo(value.videoPath, controller.signal);
      let calibration: Calibration; let table: TableAnalysis | undefined;
      const progress = (event: NativeEvent) => send(window, { type: 'progress', data: {
        taskId, kind: 'analysis', stage: event.stage!, percent: overallAnalysisProgress(event.stage!, event.total ? event.current! / event.total * 100 : 0, value.calibrationChoice.method, value.analysisMode,
          value.normalizeVariableFrameRate && source.variable_frame_rate ? 'normalized' : 'source'),
      } });
      const base = { mode: value.analysisMode === 'two_stage' ? 'twoStage' : 'full', confidence: value.blurballConfidenceThreshold, stage1Confidence: value.blurballStage1ConfidenceThreshold, stage2Confidence: value.blurballStage2ConfidenceThreshold };
      if (value.calibrationChoice.method === 'automatic') {
        const result = readCalibration(await callNative('TTcutWorker', { ...base, operation: 'calibrate', video: source.native_video }, { taskId, onProgress: progress }));
        calibration = result.calibration; table = result.table;
      } else {
        calibration = value.calibrationChoice.calibration;
        if (value.calibrationChoice.method === 'precalibrated') table = value.calibrationChoice.table_analysis;
      }
      if (calibration.video_width !== source.width || calibration.video_height !== source.height) throw new Error('INVALID_CALIBRATION');
      let video = source;
      const processing: NonNullable<AnalysisResultV1['processing']> = { mode: source.variable_frame_rate ? 'original_vfr' : 'source_cfr', target_fps_ratio: null, encoder: null, warning_code: null };
      if (source.variable_frame_rate && value.normalizeVariableFrameRate) {
        const encoder = source.native_video!.hdr !== 'sdr' || source.video_codec === 'hevc' ? 'libx265' : 'libx264';
        const key = createHash('sha256').update(JSON.stringify([originalIdentity, source.average_fps_ratio, encoder, 'native-cfr-v1'])).digest('hex');
        const directory = path.join(app.getPath('userData'), 'data', 'processing-media', 'v1', key);
        const cache = path.join(directory, 'media.mp4');
        const partial = path.join(directory, `${taskId}.partial.mp4`);
        try {
          await mkdir(directory, { recursive: true });
          const cached = await probeMacVideo(cache, controller.signal).catch(() => null);
          if (cached && !cached.variable_frame_rate && Math.abs(cached.duration_seconds - source.duration_seconds) <= 0.1 && cached.native_video?.hdr === source.native_video?.hdr && cached.native_video?.bitDepth === source.native_video?.bitDepth) video = cached;
          else {
            if (controller.signal.aborted) throw new Error('PROCESS_CANCELLED');
            await rm(cache, { force: true });
            const normalized = await renderMacMedia(taskId, 'normalize', source.path, partial, [], (percent) => progress({ schemaVersion: 1, taskID: taskId, type: 'progress', stage: 'video_normalization', current: percent, total: 100 }));
            if (!normalized || normalized.variable_frame_rate) throw new Error('NORMALIZATION_INVALID');
            await rename(partial, cache); createdCache = directory;
            video = { ...normalized, path: cache, native_video: { ...normalized.native_video!, path: cache } };
          }
          processing.mode = 'normalized_cfr'; processing.encoder = encoder; processing.target_fps_ratio = source.average_fps_ratio ?? null;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          processing.mode = 'vfr_fallback'; processing.warning_code = 'CFR_TRANSCODE_FAILED'; video = source;
          await logLine(taskId, 'WARN', String(error));
        } finally { await rm(partial, { force: true }); }
      }
      const result = await callNative('TTcutWorker', { ...base, operation: 'analyze', video: video.native_video, calibration: nativeCalibration(calibration) }, { taskId, onProgress: progress });
      if (!result.rallies || !result.bounceTimes || !result.roi) throw new Error('NATIVE_ANALYSIS_RESULT_MISSING');
      const roi = result.roi;
      data = analysisResultSchema.parse({ schema_version: 1, video, source_video: source, processing, calibration,
        ...(table ? { table_analysis: table } : {}),
        rallies: result.rallies.map((rally, i) => ({ id: `rally_${String(i + 1).padStart(3, '0')}`, index: i + 1, start_time_seconds: rally.start, end_time_seconds: rally.end, bounce_count: rally.bounceCount })),
        bounce_times_seconds: [...new Set(result.bounceTimes)].sort((a, b) => a - b),
        inference_runtime: { engine: 'coreml', compute_units: 'cpuAndNeuralEngine', precision: 'float16', prediction_concurrency: 4, checkpoint_sha256: checkpoint.blurball },
        model_provenance: { profile: 'blurball_v1', component_version: null, roi: { x: roi.x, y: roi.y, width: roi.width, height: roi.height }, main_input: { width: roi.modelWidth, height: roi.modelHeight }, aux_input: null,
          analysis: { schema_version: 2, mode: value.analysisMode, ...(value.analysisMode === 'two_stage' ? { interval_expansion_seconds: 0.75 } : {}), stages: value.analysisMode === 'full'
            ? [{ name: 'full', confidence_threshold: value.blurballConfidenceThreshold, window_size: 3, window_stride: 3, retained_output: 'all_window_frames' }]
            : [{ name: 'candidate', confidence_threshold: value.blurballStage1ConfidenceThreshold, window_size: 3, window_stride: 3, retained_output: 'all_window_frames' }, { name: 'refinement', confidence_threshold: value.blurballStage2ConfidenceThreshold, window_size: 3, window_stride: 1, retained_output: 'center_frame' }] },
        },
      });
      if (controller.signal.aborted) throw new Error('PROCESS_CANCELLED');
      if (await identity(source.path) !== originalIdentity) throw Object.assign(new Error('Source changed during analysis'), { code: 'INPUT_MOVED' });
      const record = await getHistoryStore().upsert(data, calibration, value.historyVisibility === 'visible' || data.rallies.length === 0); saved = true;
      if (controller.signal.aborted) throw new Error('PROCESS_CANCELLED');
      terminal = { type: 'analysis-result', taskId, analysisId: record.id, calibration, data };
    } catch (error) { terminal = failure(taskId, error, controller.cancelRequested, 'ANALYSIS'); }
    finally {
      try {
      if (!saved && createdCache) {
        const referenced = await getHistoryStore().hasProcessingMediaReference(path.join(createdCache, 'media.mp4')).catch(() => true);
        if (!referenced) { if (data) await removeProcessingCache(data).catch(() => undefined); else await rm(createdCache, { recursive: true, force: true }); }
      }
      } catch (error) { await logLine(taskId, 'WARN', `Cache cleanup failed: ${String(error)}`).catch(() => undefined); }
    }
    endTrackedTask(taskId); send(window, terminal);
  })();
  return taskId;
}
