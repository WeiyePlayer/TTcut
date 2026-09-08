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
const continuousVisibilityProvenance = {
  detection_confidence_threshold: 0.30,
  start_visible_seconds: 0.20,
  end_invisible_seconds: 0.50,
  motion_filter: {
    minimum_horizontal_excursion_ratio: 20 / 618,
    maximum_reversal_gap_seconds: 0.35,
    minimum_horizontal_to_vertical_range_ratio: 0.70,
    maximum_monotonic_vertical_reversals: 1,
    minimum_monotonic_horizontal_range_ratio: 200 / 618,
    minimum_monotonic_duration_seconds: 0.60,
    short_vertical_filter_seconds: 1.20,
    maximum_short_vertical_range_ratio: 0.50,
    minimum_vertical_to_horizontal_range_ratio: 1.0,
    end_on_min_opposing_edge_balance: 0.85,
    end_on_min_screen_aspect_ratio: 2.0,
  },
  fragment_bridge: {
    maximum_gap_seconds: 1.50,
    maximum_boundary_displacement_ratio: 0.35,
    maximum_boundary_speed_ratio_per_second: 0.26,
  },
  inter_rally_fragment_filter: {
    side_on_views_only: true,
    minimum_candidate_seconds: 1.0,
    maximum_candidate_seconds: 6.0,
    maximum_expanded_table_ratio: 0.45,
    minimum_visible_run_count: 3,
    minimum_one_way_range_ratio: 0.55,
    maximum_sparse_visibility_ratio: 0.30,
    minimum_contiguous_flight_seconds: 0.15,
    minimum_coherent_reversal_ratio: 0.20,
    minimum_coherent_flight_displacement_ratio: 0.15,
    expanded_table_length_margin_cm: 35.0,
    expanded_table_width_margin_cm: 25.0,
    motion_refinement: {
      version: 5 as const,
      minimum_motion_run_seconds: 0.15,
      minimum_horizontal_range_ratio: 0.05,
      minimum_speed_ratio_per_second: 0.35,
      reversal_range_ratio: 0.06,
      gap_minimum_motion_range_ratio: 0.04,
      gap_minimum_motion_support_ratio: 0.35,
      short_gap_seconds: 1.25,
      long_gap_seconds: 2.25,
      stationary_run_seconds: 0.50,
      boundary_context_seconds: 0.25,
    },
  },
} as const;
function isEndOnTableView(calibration: Calibration): boolean {
  const { top_left: topLeft, top_right: topRight, bottom_right: bottomRight, bottom_left: bottomLeft } = calibration.points;
  const distance = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const top = distance(topLeft, topRight);
  const bottom = distance(bottomLeft, bottomRight);
  const left = distance(topLeft, bottomLeft);
  const right = distance(topRight, bottomRight);
  return Math.min(top, bottom) / Math.max(top, bottom) >= 0.85
    && (top + bottom) / (left + right) >= 2.0;
}
const corners = ['top_left', 'top_right', 'bottom_right', 'bottom_left'] as const;
function send(window: BrowserWindow, event: AppEvent) { if (!window.isDestroyed()) window.webContents.send(IPC.taskEvent, event); }
function readCalibration(event: NativeEvent): { calibration: Calibration; table: TableAnalysis } {
  if (!event.calibration || !event.tableSamples) throw new Error('NATIVE_CALIBRATION_RESULT_MISSING');
  return {
    calibration: calibrationSchema.parse({ video_width: event.calibration.width, video_height: event.calibration.height, points: Object.fromEntries(corners.map((name, i) => [name, [event.calibration!.points[i]!.x, event.calibration!.points[i]!.y]])) }),
    table: tableAnalysisSchema.parse({ schema_version: 2, engine: 'coreml', compute_units: 'cpuOnly', checkpoint_sha256: checkpoint.table, aggregation_rule: 'temporal_peak_clusters_geometric_consensus', sampling: event.tableSamples }),
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
  void logLine(taskId, 'INFO', `Analysis started for ${path.basename(value.videoPath)}`);
  void (async () => {
    let terminal: AppEvent; let data: AnalysisResultV1 | undefined; let createdCache: string | undefined; let saved = false;
    try {
      const originalIdentity = await identity(value.videoPath);
      const source = await probeMacVideo(value.videoPath, controller.signal);
      await logLine(taskId, 'INFO', `Analysis input: ${JSON.stringify({
        codec: source.video_codec, width: source.width, height: source.height,
        fps: source.fps, frameCount: source.frame_count,
        variableFrameRate: source.variable_frame_rate,
        calibrationMethod: value.calibrationChoice.method, analysisMode: 'full',
        rallyRecognitionMethod: 'continuous_visibility', confidenceThreshold: 0.30,
        normalizeVariableFrameRate: value.normalizeVariableFrameRate,
      })}`).catch(() => undefined);
      let calibration: Calibration; let table: TableAnalysis | undefined;
      const progress = (event: NativeEvent) => send(window, { type: 'progress', data: {
        taskId, kind: 'analysis', stage: event.stage!, percent: overallAnalysisProgress(event.stage!, event.total ? event.current! / event.total * 100 : 0, value.calibrationChoice.method, 'full',
          value.normalizeVariableFrameRate && source.variable_frame_rate ? 'normalized' : 'source'),
      } });
      // The native Core ML worker does not yet implement the Python worker's
      // hybrid_motion_bounce algorithm. Preserve the established macOS
      // continuous-visibility path instead of sending an unsupported method.
      const base = { mode: 'full', rallyRecognitionMethod: 'continuous_visibility', confidence: 0.30, stage1Confidence: 0.30, stage2Confidence: 0.70 };
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
      if (!result.roi || !result.visibilityRallies) throw new Error('NATIVE_ANALYSIS_RESULT_MISSING');
      const roi = result.roi;
      const commonResult = {
        video, source_video: source, processing, calibration,
        ...(table ? { table_analysis: table } : {}),
        inference_runtime: { engine: 'coreml' as const, compute_units: 'cpuAndNeuralEngine' as const, precision: 'float16' as const, prediction_concurrency: 4, checkpoint_sha256: checkpoint.blurball },
        model_provenance: { profile: 'blurball_v1' as const, component_version: null, roi: { x: roi.x, y: roi.y, width: roi.width, height: roi.height }, main_input: { width: roi.modelWidth, height: roi.modelHeight }, aux_input: null,
          analysis: { schema_version: 2 as const, mode: 'full' as const, stages: [{ name: 'full' as const, confidence_threshold: continuousVisibilityProvenance.detection_confidence_threshold, window_size: 3 as const, window_stride: 3 as const, retained_output: 'all_window_frames' as const }] },
        },
      };
      data = analysisResultSchema.parse({
        schema_version: 2,
        ...commonResult,
        rallies: result.visibilityRallies!.map((rally, i) => ({
          id: `rally_${String(i + 1).padStart(3, '0')}`, index: i + 1,
          start_time_seconds: rally.startTime, end_time_seconds: rally.endTime,
          ...(rally.leadInStartTime === undefined ? {} : { lead_in_start_time_seconds: rally.leadInStartTime }),
        })),
        rally_recognition: {
          method: 'continuous_visibility', ...continuousVisibilityProvenance,
          motion_filter: {
            ...continuousVisibilityProvenance.motion_filter,
            vertical_exchange_enabled: isEndOnTableView(calibration),
          },
        },
      });
      if (controller.signal.aborted) throw new Error('PROCESS_CANCELLED');
      if (await identity(source.path) !== originalIdentity) throw Object.assign(new Error('Source changed during analysis'), { code: 'INPUT_MOVED' });
      const record = await getHistoryStore().upsert(data, calibration, value.historyVisibility === 'visible' || data.rallies.length === 0); saved = true;
      await logLine(taskId, 'INFO', `Analysis saved: ${JSON.stringify({
        decodedFrames: video.frame_count, rallyCount: data.rallies.length, calibration,
        model: 'blurball_v1', modelInput: data.model_provenance?.main_input,
        analysisRoi: data.model_provenance?.roi, processingMode: processing.mode,
        recognition: 'rally_recognition' in data ? data.rally_recognition : 'bounce_events',
      })}`).catch(() => undefined);
      if (controller.signal.aborted) throw new Error('PROCESS_CANCELLED');
      terminal = { type: 'analysis-result', taskId, analysisId: record.id, calibration, data };
    } catch (error) {
      await logLine(taskId, 'ERROR', `Analysis failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      terminal = failure(taskId, error, controller.cancelRequested, 'ANALYSIS');
    }
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
