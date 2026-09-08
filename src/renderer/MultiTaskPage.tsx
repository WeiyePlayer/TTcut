import { CompatibleVideo } from './CompatibleVideo';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  RALLY_RECOGNITION_METHOD_DEFAULT,
  rallyRecognitionMethod as resultRecognitionMethod,
  DURATION_HIGHLIGHT_TIER_VALUES,
  AnalysisResultV1,
  BatchExportResult,
  Calibration,
  CutSelectionV1,
  ExportWarning,
  DurationHighlightTier,
  RallyRecognitionMethod,
  TableAnalysis,
  VideoMetadata,
} from '../shared/contracts';
import type { AppEvent, SelectedVideo } from '../shared/api';
import { formatTimestamp } from '../domain/time';
import { normalizeCalibrationPoints, validateCalibration } from '../domain/calibration';
import { overallCalibrationProgress } from '../domain/analysis-progress';
import { isSupportedVideoFileName } from '../domain/video-input';
import { CalibrationSurface } from './CalibrationSurface';
import { GlassRadioGroup } from './GlassRadioGroup';

type BatchMode = 'all' | 'highlight' | 'analyze-only';
type CalibrationStatus = 'pending' | 'calibrating' | 'ready' | 'manual-required' | 'error';
type ProcessingStatus = 'waiting' | 'analyzing' | 'exporting' | 'cancelled' | 'failed' | 'done';
type ActivePhase = 'calibration' | 'analysis' | 'export';
type PointName = keyof Calibration['points'];

type BatchItem = {
  id: string;
  additionOrder: number;
  video: SelectedVideo;
  previewVideo: SelectedVideo | null;
  metadata: VideoMetadata;
  mode: BatchMode;
  threshold: 3 | 5 | 7;
  durationTier: DurationHighlightTier;
  calibrationStatus: CalibrationStatus;
  processingStatus: ProcessingStatus;
  progress: number;
  calibration: Calibration | null;
  tableAnalysis: TableAnalysis | null;
  analysisId: string | null;
  analysis: AnalysisResultV1 | null;
  outputPath: string | null;
  outputMediaUrl: string | null;
  recoveredOutputPath: string | null;
  exportWarning: ExportWarning | null;
  error: string | null;
};

interface MultiTaskPageProps {
  initialVideos: SelectedVideo[];
  preRoll: 1.5 | 2.5 | 5;
  postRoll: 0.5 | 1 | 2 | 4;
  normalizeVariableFrameRate?: boolean;
  language?: 'zh-CN' | 'en';
  onOpenAnalysis: (analysisId: string) => void;
  onCompletableTasksFinished?: () => void;
  onTaskStateChange?: (active: boolean) => void;
}

const pointOrder: PointName[] = ['top_left', 'top_right', 'bottom_right', 'bottom_left'];

function makeId(video: SelectedVideo): string {
  return `${video.path}:${video.size}:${Date.now()}:${Math.random()}`;
}

async function createItems(videos: SelectedVideo[], firstOrder = 0): Promise<BatchItem[]> {
  return Promise.all(videos.map(async (video, index) => ({
    id: makeId(video),
    additionOrder: firstOrder + index,
    video,
    previewVideo: null,
    metadata: await window.ttcut.probeVideo(video.path),
    mode: 'all' as const,
    threshold: 5 as const,
    durationTier: 'rally' as const,
    calibrationStatus: 'pending' as const,
    processingStatus: 'waiting' as const,
    progress: 0,
    calibration: null,
    tableAnalysis: null,
    analysisId: null,
    analysis: null,
    outputPath: null,
    outputMediaUrl: null,
    recoveredOutputPath: null,
    exportWarning: null,
    error: null,
  })));
}

function modeLabel(item: BatchItem, rallyRecognitionMethod: RallyRecognitionMethod): string {
  if (item.mode === 'all') return '所有回合';
  if (item.mode === 'highlight') return rallyRecognitionMethod === 'continuous_visibility'
    ? `精彩回合_${({ short_rally: '短回合', rally: '相持', long_rally: '长相持' } as const)[item.durationTier]}`
    : `精彩回合_${item.threshold}板`;
  return '只分析';
}

function hasPendingCalibration(items: BatchItem[]): boolean {
  return items.some((item) => item.calibrationStatus === 'pending' || item.calibrationStatus === 'calibrating');
}

function hasOpenBatchWork(items: BatchItem[]): boolean {
  return items.some((item) => (
    item.calibrationStatus === 'pending'
    || item.calibrationStatus === 'calibrating'
    || (item.calibrationStatus === 'ready'
      && ['waiting', 'analyzing', 'exporting'].includes(item.processingStatus))
  ));
}

export function MultiTaskPage({
  initialVideos,
  preRoll,
  postRoll,
  normalizeVariableFrameRate = false,
  language = 'zh-CN',
  onOpenAnalysis,
  onCompletableTasksFinished = () => undefined,
  onTaskStateChange = () => undefined,
}: MultiTaskPageProps) {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [activePhase, setActivePhase] = useState<ActivePhase | null>(null);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<{ source: string; name: string; width: number; height: number; hdr: boolean } | null>(null);
  const [manualItemId, setManualItemId] = useState<string | null>(null);
  const [manualPoints, setManualPoints] = useState<Partial<Record<PointName, [number, number]>>>({});
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  const [mergeVideos, setMergeVideos] = useState(false);
  const [batchExport, setBatchExport] = useState<{
    status: 'idle' | 'blocked' | 'exporting' | 'done' | 'failed' | 'cancelled' | 'empty';
    progress: number;
    result: BatchExportResult | null;
    error: string | null;
  }>({ status: 'idle', progress: 0, result: null, error: null });
  const mergeVideosRef = useRef(false);
  const mergeRunRef = useRef(false);
  const batchExportRef = useRef<{ taskId: string | null; cancelRequested: boolean } | null>(null);
  const nextAdditionOrder = useRef(initialVideos.length);
  const pendingAdditions = useRef(0);
  const itemsRef = useRef(items);
  const activeRef = useRef<{ taskId: string | null; itemId: string; phase: ActivePhase } | null>(null);
  const runningRef = useRef(false);
  const cancelRequested = useRef(false);
  const autoCalibrationAvailableRef = useRef(true);
  const pendingTaskStartRef = useRef<Promise<string> | null>(null);
  const scheduleRef = useRef<() => void>(() => undefined);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const previousRects = useRef(new Map<string, DOMRect>());
  const optionsRef = useRef({
    preRoll,
    postRoll,
    normalizeVariableFrameRate,
  });

  const isEnglish = language === 'en';
  const text = {
    title: isEnglish ? 'Batch cutting' : '多任务剪辑',
    add: isEnglish ? '+ Add videos' : '＋ 添加视频',
    all: isEnglish ? 'All rallies' : '所有回合',
    highlight: isEnglish ? 'Highlights' : '精彩回合',
    analyzeOnly: isEnglish ? 'Analyze only' : '只分析',
    remove: isEnglish ? 'Remove' : '删除',
    openRecovered: isEnglish ? 'Open retained file' : '打开保留文件',
    warning: isEnglish ? 'Exported with warning' : '已导出，但存在异常',
    processingWarning: isEnglish ? 'Analysis used the original VFR video' : '分析已回退使用原始可变帧率视频',
    logs: isEnglish ? 'Open logs' : '打开日志',
    preview: isEnglish ? 'Preview' : '预览',
    cancel: isEnglish ? 'Cancel' : '取消',
    start: isEnglish ? 'Start analysis and cutting' : '开始分析剪辑',
    calibrating: isEnglish ? 'Calibrating tables' : '正在自动标定',
    running: isEnglish ? 'Processing serially' : '正在串行处理',
    merge: isEnglish ? 'Merge into one video' : '合并为一个视频',
    mergeUnavailable: isEnglish ? 'Choose all rallies or highlights for at least one video.' : '至少一个视频选择“所有回合”或“精彩回合”后可用。',
    merging: isEnglish ? 'Exporting merged video' : '正在合并导出',
    mergeWaiting: isEnglish ? 'Analyzed · waiting to merge' : '分析完成 · 等待合并',
    mergeDone: isEnglish ? 'Merged video ready' : '合并视频已完成',
    mergeBlocked: isEnglish ? 'Finish, retry or remove incomplete videos before merging.' : '请完成标定、重试或移除未完成的视频后再合并。',
    mergeEmpty: isEnglish ? 'No clips to merge' : '没有可合并的片段',
    mergeFailed: isEnglish ? 'Merged export failed. You can retry without reanalyzing.' : '合并导出失败，可直接重试，无需重新分析。',
    mergeCancelled: isEnglish ? 'Merged export cancelled. Analysis results are retained.' : '已取消合并导出，分析结果已保留。',
    mergeSkipped: isEnglish ? 'No matching clips; skipped:' : '没有符合条件的片段，已跳过：',
    retry: isEnglish ? 'Retry merge' : '重试合并',
    previewOutput: isEnglish ? 'Preview output' : '预览输出',
    openFolder: isEnglish ? 'Open folder' : '打开文件夹',
    calibrationTitle: isEnglish ? 'Calibrate the table' : '标定球桌',
    calibrationDescription: isEnglish
      ? 'Mark the four table corners in any order. Drag a point to fine-tune it.'
      : '逐个标记球台四个角点，顺序不限。标满四点后可拖动微调。',
    finishCalibration: isEnglish ? 'Finish calibration' : '完成标定',
    resetCalibration: isEnglish ? 'Reset calibration' : '重置标定',
    calibrationFailed: isEnglish ? 'Calibration failed' : '标定失败',
    calibrateManually: isEnglish ? 'Calibrate manually' : '手动标定',
    modelUnavailable: isEnglish
      ? 'The automatic calibration model is unavailable. Uncalibrated videos can be calibrated manually.'
      : '自动标定模型不可用，尚未标定的视频可改用手动标定。',
    invalidCalibration: isEnglish
      ? 'The points must be distinct and form a sufficiently large quadrilateral without crossing edges.'
      : '四个点不能重合，且必须组成对边不相交、面积足够的四边形。',
    pointLabels: isEnglish
      ? ['1 Corner 1', '2 Corner 2', '3 Corner 3', '4 Corner 4']
      : ['1 角点 1', '2 角点 2', '3 角点 3', '4 角点 4'],
  };

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { runningRef.current = running; }, [running]);
  const batchTaskActive = !initialized || running || hasOpenBatchWork(items);
  const mergeWorkflow = mergeVideos || (running && mergeRunRef.current);
  const exportLocked = batchExport.status === 'exporting';
  const hasClippingItems = items.some((item) => item.mode !== 'analyze-only');
  useEffect(() => onTaskStateChange(batchTaskActive), [batchTaskActive, onTaskStateChange]);

  const replaceItems = (updater: (current: BatchItem[]) => BatchItem[]) => {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
    const hasClipping = next.some((item) => item.mode !== 'analyze-only');
    if (!hasClipping || (runningRef.current && mergeRunRef.current)) {
      mergeVideosRef.current = hasClipping && mergeRunRef.current;
      setMergeVideos(mergeVideosRef.current);
    }
  };

  const invalidateMergedOutput = () => {
    setBatchExport({ status: 'idle', progress: 0, result: null, error: null });
  };

  const selectionFor = (item: BatchItem): Exclude<CutSelectionV1, { mode: 'custom' }> => item.mode === 'all'
    ? { mode: 'all', pre_roll_seconds: optionsRef.current.preRoll, post_roll_seconds: optionsRef.current.postRoll }
    : item.analysis && resultRecognitionMethod(item.analysis) === 'continuous_visibility'
      ? { mode: 'highlight', criterion: { kind: 'duration_tier', tier: item.durationTier }, pre_roll_seconds: optionsRef.current.preRoll, post_roll_seconds: optionsRef.current.postRoll }
      : { mode: 'highlight', criterion: { kind: 'bounce_count', threshold: item.threshold }, pre_roll_seconds: optionsRef.current.preRoll, post_roll_seconds: optionsRef.current.postRoll };

  const completeRun = (success: boolean) => {
    runningRef.current = false;
    mergeRunRef.current = false;
    setRunning(false);
    if (!success) return;
    onCompletableTasksFinished();
  };

  const beginMergedExport = () => {
    // Lock synchronously before the IPC call and snapshot conditions in stable source order.
    batchExportRef.current = { taskId: null, cancelRequested: false };
    setBatchExport({ status: 'exporting', progress: 0, result: null, error: null });
    const participants = itemsRef.current.filter((item) => item.mode !== 'analyze-only')
      .sort((left, right) => left.additionOrder - right.additionOrder);
    const promise = window.ttcut.startBatchExport({ items: participants.map((item) => ({
      analysis_id: item.analysisId!, selection: selectionFor(item),
    })) });
    pendingTaskStartRef.current = promise;
    void promise.then((taskId) => {
      if (!batchExportRef.current) return;
      batchExportRef.current.taskId = taskId;
      if (batchExportRef.current.cancelRequested) void window.ttcut.cancelTask(taskId);
    }).catch((error) => {
      batchExportRef.current = null;
      setBatchExport({ status: 'failed', progress: 0, result: null, error: String(error) });
      completeRun(false);
    }).finally(() => {
      if (pendingTaskStartRef.current === promise) pendingTaskStartRef.current = null;
    });
  };

  const updateItem = (id: string, updater: (item: BatchItem) => BatchItem) => {
    replaceItems((current) => current.map((item) => item.id === id ? updater(item) : item));
  };

  const finishActive = () => {
    activeRef.current = null;
    setActiveItem(null);
    setActivePhase(null);
  };

  const schedule = () => {
    if (activeRef.current || batchExportRef.current) return;
    const calibrationCandidate = itemsRef.current.find((item) => item.calibrationStatus === 'pending');
    if (calibrationCandidate) {
      if (!autoCalibrationAvailableRef.current) {
        replaceItems((current) => current.map((item) => (
          item.calibrationStatus === 'pending'
            ? { ...item, calibrationStatus: 'manual-required', error: null }
            : item
        )));
        setTimeout(() => scheduleRef.current(), 0);
        return;
      }
      const itemId = calibrationCandidate.id;
      activeRef.current = { taskId: null, itemId, phase: 'calibration' };
      setActiveItem(itemId);
      setActivePhase('calibration');
      updateItem(itemId, (item) => ({ ...item, calibrationStatus: 'calibrating', progress: 0, error: null }));
      const startPromise = window.ttcut.startAutoCalibration({ videoPath: calibrationCandidate.video.path, device: 'auto' });
      pendingTaskStartRef.current = startPromise;
      void startPromise
        .then((taskId) => {
          if (activeRef.current?.itemId !== itemId || activeRef.current.phase !== 'calibration') return;
          activeRef.current = { taskId, itemId, phase: 'calibration' };
        })
        .catch((caught) => {
          if (activeRef.current?.itemId !== itemId) return;
          updateItem(itemId, (item) => ({ ...item, calibrationStatus: 'error', error: String(caught) }));
          finishActive();
          setTimeout(() => scheduleRef.current(), 0);
        })
        .finally(() => {
          if (pendingTaskStartRef.current === startPromise) pendingTaskStartRef.current = null;
        });
      return;
    }
    if (!runningRef.current) return;
    const candidate = itemsRef.current.find((item) => (
      item.calibrationStatus === 'ready'
      && item.processingStatus === 'waiting'
    ));
    if (!candidate) {
      if (pendingAdditions.current > 0) return;
      const completedSuccessfully = itemsRef.current.length > 0
        && itemsRef.current.every((item) => item.processingStatus === 'done');
      if (mergeRunRef.current) {
        if (!completedSuccessfully) {
          setBatchExport({ status: 'blocked', progress: 0, result: null, error: null });
          completeRun(false);
        } else if (itemsRef.current.some((item) => item.mode !== 'analyze-only')) {
          beginMergedExport();
        } else {
          completeRun(true);
        }
      } else {
        completeRun(completedSuccessfully);
        if (!completedSuccessfully) onCompletableTasksFinished();
      }
      return;
    }
    if (mergeRunRef.current && candidate.analysisId && candidate.analysis) {
      updateItem(candidate.id, (item) => ({ ...item, processingStatus: 'done', progress: 100 }));
      setTimeout(() => scheduleRef.current(), 0);
      return;
    }
    cancelRequested.current = false;
    setActiveItem(candidate.id);
    if (candidate.analysisId && candidate.analysis && candidate.processingStatus !== 'failed' && candidate.mode !== 'analyze-only') {
      updateItem(candidate.id, (item) => ({ ...item, processingStatus: 'exporting', progress: 70, error: null }));
      activeRef.current = { taskId: null, itemId: candidate.id, phase: 'export' };
      setActivePhase('export');
      const selection = selectionFor(candidate);
      const startPromise = window.ttcut.startExport({
        analysis_id: candidate.analysisId,
        selection,
        destination: 'source',
        mode_label: modeLabel(candidate, candidate.analysis ? resultRecognitionMethod(candidate.analysis) : RALLY_RECOGNITION_METHOD_DEFAULT),
      });
      pendingTaskStartRef.current = startPromise;
      void startPromise.then((taskId) => {
        if (activeRef.current?.itemId !== candidate.id || activeRef.current.phase !== 'export') return;
        activeRef.current = { taskId, itemId: candidate.id, phase: 'export' };
      }).catch((caught) => {
        if (activeRef.current?.itemId !== candidate.id || activeRef.current.phase !== 'export') return;
        updateItem(candidate.id, (item) => ({ ...item, processingStatus: 'failed', error: String(caught) }));
        finishActive();
        setTimeout(() => scheduleRef.current(), 0);
      }).finally(() => {
        if (pendingTaskStartRef.current === startPromise) pendingTaskStartRef.current = null;
      });
      return;
    }
    updateItem(candidate.id, (item) => ({
      ...item,
      processingStatus: 'analyzing',
      progress: 0,
      analysisId: null,
      analysis: null,
      outputPath: null,
      outputMediaUrl: null,
      error: null,
    }));
    const calibrationChoice = candidate.calibration
      ? {
        method: 'precalibrated' as const,
        calibration: candidate.calibration,
        ...(candidate.tableAnalysis ? { table_analysis: candidate.tableAnalysis } : {}),
      }
      : null;
    if (!calibrationChoice) {
      updateItem(candidate.id, (item) => ({ ...item, processingStatus: 'failed', error: 'INVALID_CALIBRATION' }));
      setTimeout(() => scheduleRef.current(), 0);
      return;
    }
    activeRef.current = { taskId: null, itemId: candidate.id, phase: 'analysis' };
    setActivePhase('analysis');
    const startPromise = window.ttcut.startAnalysis({
      videoPath: candidate.video.path,
      calibrationChoice,
      device: 'auto',
      historyVisibility: mergeRunRef.current || candidate.mode === 'analyze-only' ? 'visible' : 'deferred',
      normalizeVariableFrameRate: optionsRef.current.normalizeVariableFrameRate,
    });
    pendingTaskStartRef.current = startPromise;
    void startPromise.then((taskId) => {
      if (activeRef.current?.itemId !== candidate.id || activeRef.current.phase !== 'analysis') return;
      activeRef.current = { taskId, itemId: candidate.id, phase: 'analysis' };
    }).catch((caught) => {
      if (activeRef.current?.itemId !== candidate.id || activeRef.current.phase !== 'analysis') return;
      updateItem(candidate.id, (item) => ({ ...item, processingStatus: 'failed', error: String(caught) }));
      finishActive();
      setTimeout(() => scheduleRef.current(), 0);
    }).finally(() => {
      if (pendingTaskStartRef.current === startPromise) pendingTaskStartRef.current = null;
    });
  };

  useEffect(() => { scheduleRef.current = schedule; });

  useEffect(() => {
    let cancelled = false;
    void createItems(initialVideos).then((created) => {
      if (cancelled) return;
      itemsRef.current = created;
      setItems(created);
      setInitialized(true);
      setTimeout(() => scheduleRef.current(), 0);
    }).catch(() => {
      if (!cancelled) setInitialized(true);
    });
    return () => { cancelled = true; };
  }, [initialVideos]);

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>();
    rowRefs.current.forEach((element, id) => {
      const next = element.getBoundingClientRect();
      nextRects.set(id, next);
      const previous = previousRects.current.get(id);
      if (previous && previous.top !== next.top) {
        element.animate(
          [{ transform: `translateY(${previous.top - next.top}px)` }, { transform: 'translateY(0)' }],
          { duration: 240, easing: 'linear' },
        );
      }
    });
    previousRects.current = nextRects;
  }, [items]);

  useEffect(() => window.ttcut.onTaskEvent((event: AppEvent) => {
    if (event.type === 'component-result') return;
    const eventTaskId = event.type === 'progress' ? event.data.taskId : event.taskId;
    if (batchExportRef.current?.taskId === eventTaskId) {
      if (event.type === 'progress') {
        setBatchExport((current) => ({ ...current, progress: Math.max(current.progress, event.data.percent) }));
      } else if (event.type === 'batch-export-result') {
        batchExportRef.current = null;
        setBatchExport({ status: 'done', progress: 100, result: event.data, error: null });
        completeRun(true);
      } else if (event.type === 'error') {
        batchExportRef.current = null;
        setBatchExport({
          status: event.code === 'BATCH_EXPORT_EMPTY' ? 'empty' : event.code === 'EXPORT_CANCELLED' ? 'cancelled' : 'failed',
          progress: 0, result: null, error: event.code,
        });
        completeRun(false);
      }
      return;
    }
    if (event.type === 'batch-export-result') return;
    const active = activeRef.current;
    if (!active) return;
    const taskId = event.type === 'progress' ? event.data.taskId : event.taskId;
    if (active.taskId !== taskId) return;
    if (event.type === 'progress') {
      const mapped = active.phase === 'calibration'
        ? overallCalibrationProgress(event.data.stage, event.data.percent)
        : active.phase === 'analysis'
          ? (mergeRunRef.current || itemsRef.current.find((item) => item.id === active.itemId)?.mode === 'analyze-only'
            ? event.data.percent
            : event.data.stage === 'video_normalization'
              ? event.data.percent
              : event.data.percent * 0.7)
          : 70 + event.data.percent * 0.3;
      updateItem(active.itemId, (item) => ({ ...item, progress: Math.min(100, Math.max(item.progress, mapped)) }));
      return;
    }
    if (event.type === 'calibration-result') {
      updateItem(active.itemId, (item) => ({
        ...item,
        calibrationStatus: 'ready',
        calibration: event.calibration,
        tableAnalysis: event.tableAnalysis,
        progress: 0,
        error: null,
      }));
      finishActive();
      setTimeout(() => scheduleRef.current(), 0);
      return;
    }
    if (event.type === 'analysis-result') {
      const current = itemsRef.current.find((item) => item.id === active.itemId);
      const finishedAtAnalysis = mergeRunRef.current || current?.mode === 'analyze-only' || event.data.rallies.length === 0;
      updateItem(active.itemId, (item) => ({
        ...item,
        analysisId: event.analysisId,
        analysis: event.data,
        processingStatus: finishedAtAnalysis ? 'done' : 'waiting',
        progress: finishedAtAnalysis ? 100 : 70,
        exportWarning: event.data.processing?.mode === 'vfr_fallback' && event.data.processing.warning_code
          ? { code: event.data.processing.warning_code, message: event.data.processing.warning_code }
          : null,
      }));
      if (event.data.processing?.mode === 'normalized_cfr') {
        void Promise.resolve(window.ttcut.acceptDroppedVideo(event.data.video.path)).then((processed) => {
          if (!processed) return;
          updateItem(active.itemId, (item) => ({ ...item, previewVideo: { ...processed, name: item.video.name } }));
        }).catch(() => undefined);
      }
      finishActive();
      setTimeout(() => scheduleRef.current(), 0);
      return;
    }
    if (event.type === 'export-result') {
      const exportData = event.data;
      if (!('outputPath' in exportData)) return;
      updateItem(active.itemId, (item) => ({
        ...item,
        processingStatus: 'done',
        progress: 100,
        outputPath: exportData.outputPath,
        outputMediaUrl: exportData.mediaUrl,
        recoveredOutputPath: null,
        exportWarning: exportData.warning ?? item.exportWarning,
        error: null,
      }));
      finishActive();
      setTimeout(() => scheduleRef.current(), 0);
      return;
    }
    if (active.phase === 'calibration') {
      if (event.code === 'TABLE_MODEL_RESOURCE_ERROR') {
        autoCalibrationAvailableRef.current = false;
        setSystemNotice(text.modelUnavailable);
        replaceItems((current) => current.map((item) => (
          item.calibrationStatus !== 'ready'
            ? { ...item, calibrationStatus: 'manual-required', error: null }
            : item
        )));
      } else if (event.code === 'AUTO_CALIBRATION_FAILED') {
        updateItem(active.itemId, (item) => ({
          ...item,
          calibrationStatus: 'manual-required',
          calibration: null,
          tableAnalysis: null,
          error: null,
          progress: 0,
        }));
      } else {
        updateItem(active.itemId, (item) => ({ ...item, calibrationStatus: 'error', error: event.code }));
      }
      finishActive();
      setTimeout(() => scheduleRef.current(), 0);
      return;
    }
    const cancelled = event.code === 'EXPORT_CANCELLED'
      || (active.phase === 'analysis' && cancelRequested.current);
    updateItem(active.itemId, (item) => ({
      ...item,
      processingStatus: cancelled ? 'cancelled' : 'failed',
      progress: active.phase === 'export' && item.analysisId ? 70 : 0,
      analysisId: active.phase === 'analysis' ? null : item.analysisId,
      analysis: active.phase === 'analysis' ? null : item.analysis,
      recoveredOutputPath: event.recoveredOutputPath ?? null,
      exportWarning: item.exportWarning,
      error: cancelled ? null : event.code,
    }));
    if (cancelled) {
      replaceItems((current) => {
        const moved = current.find((item) => item.id === active.itemId);
        if (!moved) return current;
        return [...current.filter((item) => item.id !== active.itemId), moved];
      });
    }
    finishActive();
    setTimeout(() => scheduleRef.current(), 0);
  }), []);

  const addVideos = async (videos: SelectedVideo[]) => {
    if (batchExportRef.current) return;
    const existing = new Set(itemsRef.current.map((item) => item.video.path.toLowerCase()));
    const unique = videos.filter((video) => !existing.has(video.path.toLowerCase()));
    if (!unique.length) return;
    const firstOrder = nextAdditionOrder.current;
    nextAdditionOrder.current += unique.length;
    pendingAdditions.current += 1;
    try {
      const created = await createItems(unique, firstOrder);
      if (batchExportRef.current) return;
      const added = autoCalibrationAvailableRef.current
        ? created
        : created.map((item) => ({ ...item, calibrationStatus: 'manual-required' as const }));
      invalidateMergedOutput();
      replaceItems((current) => {
        const currentPaths = new Set(current.map((item) => item.video.path.toLowerCase()));
        return [...current, ...added.filter((item) => !currentPaths.has(item.video.path.toLowerCase()))];
      });
    } catch (error) {
      setSystemNotice(String(error));
    } finally {
      pendingAdditions.current -= 1;
      setTimeout(() => scheduleRef.current(), 0);
    }
  };

  const collectVideos = async (select: () => Promise<SelectedVideo[]>) => {
    if (batchExportRef.current) return;
    pendingAdditions.current += 1;
    try {
      await addVideos(await select());
    } catch (error) {
      setSystemNotice(String(error));
    } finally {
      pendingAdditions.current -= 1;
      setTimeout(() => scheduleRef.current(), 0);
    }
  };

  const chooseMore = () => collectVideos(() => window.ttcut.selectVideos());
  const start = () => {
    if (runningRef.current || batchExportRef.current || hasPendingCalibration(itemsRef.current)) return;
    cancelRequested.current = false;
    mergeRunRef.current = mergeVideosRef.current;
    invalidateMergedOutput();
    replaceItems((current) => current.map((item) => (
      item.processingStatus === 'failed' || item.processingStatus === 'cancelled'
        || (!mergeRunRef.current && item.processingStatus === 'done' && item.mode !== 'analyze-only'
          && item.analysis && item.analysis.rallies.length > 0 && !item.outputPath)
        ? { ...item, processingStatus: 'waiting', recoveredOutputPath: null, exportWarning: null, error: null }
        : item
    )));
    runningRef.current = true;
    setRunning(true);
    scheduleRef.current();
  };

  const toggleMerge = (enabled: boolean) => {
    if (runningRef.current || batchExportRef.current) return;
    mergeVideosRef.current = enabled;
    setMergeVideos(enabled);
    invalidateMergedOutput();
  };

  const changeSelection = (id: string, updater: (item: BatchItem) => BatchItem) => {
    if (batchExportRef.current) return;
    invalidateMergedOutput();
    updateItem(id, updater);
  };

  const cancelMergedExport = () => {
    const active = batchExportRef.current;
    if (!active) return;
    active.cancelRequested = true;
    if (active.taskId) void window.ttcut.cancelTask(active.taskId);
  };

  const cancel = async () => {
    const active = activeRef.current;
    if (!active?.taskId || active.phase === 'calibration') return;
    cancelRequested.current = true;
    await window.ttcut.cancelTask(active.taskId);
  };

  const remove = async (item: BatchItem) => {
    if (item.id === activeRef.current?.itemId || batchExportRef.current) return;
    invalidateMergedOutput();
    replaceItems((current) => current.filter((value) => value.id !== item.id));
    if (item.analysisId) await window.ttcut.deleteAnalysis(item.analysisId);
    setTimeout(() => scheduleRef.current(), 0);
  };

  const openManual = (item: BatchItem) => {
    setManualItemId(item.id);
    setManualPoints(item.calibration?.points ?? {});
  };

  const manualItem = items.find((item) => item.id === manualItemId) ?? null;
  const manualAllPoints = pointOrder.every((name) => manualPoints[name]);
  const manualCalibration: Calibration | null = manualItem && manualAllPoints
    ? {
      video_width: manualItem.metadata.width,
      video_height: manualItem.metadata.height,
      points: normalizeCalibrationPoints(pointOrder.map((name) => manualPoints[name]!)),
    }
    : null;
  const manualIssue = manualCalibration ? validateCalibration(manualCalibration) : null;

  const finishManual = () => {
    if (!manualItem || !manualCalibration || manualIssue) return;
    updateItem(manualItem.id, (item) => ({
      ...item,
      calibrationStatus: 'ready',
      calibration: manualCalibration,
      tableAnalysis: null,
      processingStatus: item.processingStatus === 'done' ? 'waiting' : item.processingStatus,
      exportWarning: null,
      error: null,
      progress: 0,
    }));
    setManualItemId(null);
    setManualPoints({});
    setTimeout(() => scheduleRef.current(), 0);
  };

  if (manualItem) {
    return (
      <section className="page multi-task-page multi-calibration-page">
        <div className="multi-header">
          <button className="workflow-back inline" type="button" onClick={() => { setManualItemId(null); setManualPoints({}); }}>
            ← {isEnglish ? 'Back to batch' : '返回多任务'}
          </button>
          <h1>{text.calibrationTitle}</h1>
        </div>
        <div className="page-heading">
          <p className="eyebrow">{manualItem.video.name}</p>
          <p>{text.calibrationDescription}</p>
        </div>
        <CalibrationSurface video={manualItem.video} metadata={manualItem.metadata} points={manualPoints} onPointsChange={setManualPoints} language={language} />
        <div className="point-legend">
          {text.pointLabels.map((label, index) => <span className={manualPoints[pointOrder[index]!] ? 'done' : ''} key={label}><b>{index + 1}</b>{label.replace(/^\d\s/, '')}</span>)}
        </div>
        {manualIssue && <p className="calibration-error" role="alert">{text.invalidCalibration}</p>}
        <div className="footer-actions">
          <button className="secondary" type="button" onClick={() => setManualPoints({})}>{text.resetCalibration}</button>
          <button className="primary" type="button" disabled={!manualCalibration || Boolean(manualIssue)} onClick={finishManual}>{text.finishCalibration}</button>
        </div>
      </section>
    );
  }

  const ordered = [...items].sort((left, right) => Number(right.processingStatus === 'done') - Number(left.processingStatus === 'done'));
  const calibrationBusy = hasPendingCalibration(items);
  const canStart = items.some((item) => item.calibrationStatus === 'ready' && (
    item.processingStatus !== 'done'
    || (mergeVideos && hasClippingItems && batchExport.status !== 'done')
    || (!mergeVideos && item.mode !== 'analyze-only' && item.analysis && item.analysis.rallies.length > 0 && !item.outputPath)
  ));

  return (
    <section
      className="page multi-task-page"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (batchExportRef.current) return;
        const files = [...event.dataTransfer.files].filter((file) => isSupportedVideoFileName(file.name));
        void collectVideos(() => Promise.all(files.map((file) => window.ttcut.acceptDroppedVideo(window.ttcut.pathForDroppedFile(file)))));
      }}
    >
      <div className="multi-header">
        <h1>{text.title}</h1>
        <button className="secondary" type="button" disabled={exportLocked} onClick={() => void chooseMore()}>{text.add}</button>
      </div>
      {systemNotice && <div className="notice batch-system-notice" role="status"><strong>{systemNotice}</strong></div>}
      <div className="batch-list">
        {ordered.map((item) => {
          const active = item.id === activeItem;
          const manualRequired = item.calibrationStatus === 'manual-required';
          const done = item.processingStatus === 'done';
          const rowStatus = done ? 'done' : active ? 'processing' : manualRequired ? 'manual-required' : item.calibrationStatus === 'error' ? 'failed' : item.processingStatus;
          return (
            <article
              className={`batch-row card ${rowStatus}${mergeWorkflow ? ' merge-workflow' : ''}`}
              key={item.id}
              ref={(element) => { if (element) rowRefs.current.set(item.id, element); else rowRefs.current.delete(item.id); }}
            >
              <button
                className={`batch-cover ${active ? 'processing' : ''} ${active && activePhase === 'calibration' ? 'calibrating' : ''} ${manualRequired ? 'calibration-failed-cover' : ''}`}
                type="button"
                aria-disabled={active && activePhase === 'calibration' ? 'true' : undefined}
                aria-label={manualRequired
                  ? `${item.video.name} ${text.calibrateManually}`
                  : active && activePhase === 'calibration'
                    ? `${text.calibrating} ${item.video.name}`
                    : active
                      ? `${text.cancel} ${item.video.name}`
                      : `${text.preview} ${item.video.name}`}
                onClick={() => manualRequired
                  ? openManual(item)
                  : active && activePhase === 'calibration'
                    ? undefined
                    : active
                      ? void cancel()
                      : setPreview({
                        source: (item.previewVideo ?? item.video).mediaUrl,
                        name: item.video.name,
                        hdr: Boolean(item.metadata.native_video && item.metadata.native_video.hdr !== 'sdr'),
                        width: item.metadata.width,
                        height: item.metadata.height,
                      })}
              >
                <video src={(item.previewVideo ?? item.video).mediaUrl} preload="metadata" muted playsInline />
                {active && <span className="batch-progress"><b>{Math.round(item.progress)}%</b><i style={{ width: `${item.progress}%` }} /></span>}
                {active && activePhase !== 'calibration' && <span className="batch-cancel">{text.cancel}</span>}
                {manualRequired && <span className="batch-calibration-failed"><b>{text.calibrationFailed}</b><b>{text.calibrateManually}</b></span>}
              </button>
              <div className="batch-info">
                <strong title={item.video.name}>{item.video.name}</strong>
                <span>{formatTimestamp(item.metadata.duration_seconds)} · {item.metadata.width} × {item.metadata.height} · {item.metadata.fps.toFixed(3)} fps</span>
                {mergeWorkflow && done && item.mode !== 'analyze-only' && batchExport.status !== 'done' && <span>{text.mergeWaiting}</span>}
                {item.error && !manualRequired && <small>{item.error}</small>}
                {item.exportWarning && (
                  <div className="batch-export-warning" role="alert">
                    <span><b>{item.analysis?.processing?.mode === 'vfr_fallback' ? text.processingWarning : text.warning}</b><code>{item.exportWarning.code}</code></span>
                    <button className="text-button" type="button" onClick={() => void window.ttcut.revealLogs()}>{text.logs}</button>
                  </div>
                )}
              </div>
              {done && !mergeWorkflow ? (
                <div className="batch-actions">
                  <button className="secondary" type="button" disabled={!item.outputMediaUrl && batchTaskActive} onClick={() => item.outputMediaUrl ? setPreview({
                    source: item.outputMediaUrl,
                    name: item.video.name,
                    hdr: Boolean(item.metadata.native_video && item.metadata.native_video.hdr !== 'sdr'),
                    width: item.metadata.width,
                    height: item.metadata.height,
                  }) : item.analysisId && onOpenAnalysis(item.analysisId)}>{item.outputPath ? '预览输出' : '查看分析'}</button>
                  <button className="secondary" type="button" onClick={() => void window.ttcut.revealOutput(item.outputPath ?? item.video.path)}>打开文件夹</button>
                </div>
              ) : item.processingStatus === 'failed' && item.recoveredOutputPath ? (
                <div className="batch-actions">
                  <button className="secondary" type="button" onClick={() => void window.ttcut.revealOutput(item.recoveredOutputPath!)}>{text.openRecovered}</button>
                  <button className="batch-remove" type="button" aria-label={`${text.remove} ${item.video.name}`} disabled={active || exportLocked} onClick={() => void remove(item)}>×</button>
                </div>
              ) : (
                <>
                  <div className="batch-mode">
                    <div className="batch-mode-options" role="group" aria-label={`${item.video.name} 的剪辑模式`}>
                      {([
                        ['all', text.all],
                        ['highlight', text.highlight],
                        ['analyze-only', text.analyzeOnly],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          className={item.mode === mode ? 'selected' : ''}
                          aria-pressed={item.mode === mode}
                          disabled={exportLocked || (!mergeWorkflow && active && activePhase !== 'calibration')}
                          onClick={() => changeSelection(item.id, (value) => ({ ...value, mode }))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {item.mode === 'highlight' && (item.analysis && resultRecognitionMethod(item.analysis) === 'continuous_visibility' ? <GlassRadioGroup
                      ariaLabel={language === 'zh-CN' ? '时长档位' : 'Duration tier'}
                      className="compact"
                      disabled={exportLocked || (!mergeWorkflow && active)}
                      idPrefix={`batch-duration-tier-${item.id}`}
                      name={`batch-duration-tier-${item.id}`}
                      onChange={(durationTier) => changeSelection(item.id, (current) => ({ ...current, durationTier }))}
                      options={DURATION_HIGHLIGHT_TIER_VALUES.map((value) => ({ value, label: ({ short_rally: language === 'zh-CN' ? '短回合' : 'Short rally', rally: language === 'zh-CN' ? '相持' : 'Rally', long_rally: language === 'zh-CN' ? '长相持' : 'Long rally' } as const)[value] }))}
                      value={item.durationTier}
                    /> : <GlassRadioGroup
                      ariaLabel={language === 'zh-CN' ? '板数筛选' : 'Bounce filter'}
                      className="compact"
                      disabled={exportLocked || (!mergeWorkflow && active)}
                      idPrefix={`batch-threshold-${item.id}`}
                      name={`batch-threshold-${item.id}`}
                      onChange={(threshold) => changeSelection(item.id, (current) => ({ ...current, threshold }))}
                      options={([3, 5, 7] as const).map((value) => ({ value, label: `${value}${language === 'zh-CN' ? '板' : ' bounces'}` }))}
                      value={item.threshold}
                    />)}
                  </div>
                  <button className="batch-remove" type="button" aria-label={`${text.remove} ${item.video.name}`} disabled={active || exportLocked} onClick={() => void remove(item)}>×</button>
                </>
              )}
            </article>
          );
        })}
      </div>
      {batchExport.status !== 'idle' && (
        <div className="batch-merged-result card" role="status">
          <strong>{({
            blocked: text.mergeBlocked, exporting: text.merging, done: text.mergeDone,
            failed: text.mergeFailed, cancelled: text.mergeCancelled, empty: text.mergeEmpty,
          })[batchExport.status]}</strong>
          {exportLocked && <>
            <progress aria-label={text.merging} max={100} value={batchExport.progress} />
            <span>{Math.round(batchExport.progress)}%</span>
            <button className="secondary" type="button" onClick={cancelMergedExport}>{text.cancel}</button>
          </>}
          {batchExport.error && batchExport.status === 'failed' && <>
            <small>{batchExport.error}</small>
            <button className="text-button" type="button" onClick={() => void window.ttcut.revealLogs()}>{text.logs}</button>
          </>}
          {['blocked', 'failed', 'cancelled', 'empty'].includes(batchExport.status) && (
            <button className="secondary" type="button" disabled={!canStart || calibrationBusy || running} onClick={start}>{text.retry}</button>
          )}
          {batchExport.result && <>
            <span className="batch-merged-path">{batchExport.result.outputPath}</span>
            {batchExport.result.skippedAnalysisIds.length > 0 && <span>{text.mergeSkipped}{items
              .filter((item) => item.analysisId && batchExport.result!.skippedAnalysisIds.includes(item.analysisId))
              .map((item) => item.video.name).join('、')}</span>}
            <div className="batch-actions">
              <button className="secondary" type="button" onClick={() => setPreview({
                source: batchExport.result!.mediaUrl, name: text.mergeDone,
                width: batchExport.result!.width, height: batchExport.result!.height, hdr: false,
              })}>{text.previewOutput}</button>
              <button className="secondary" type="button" onClick={() => void window.ttcut.revealOutput(batchExport.result!.outputPath)}>{text.openFolder}</button>
            </div>
          </>}
        </div>
      )}
      <div className="batch-launcher floating-launcher"
        tabIndex={0} aria-label={isEnglish ? 'Batch task options' : '多任务选项'}>
        <div className="batch-launch-options custom-export-options floating-launch-options">
          <label className="export-checkbox" title={!hasClippingItems ? text.mergeUnavailable : undefined}>
            <input type="checkbox" checked={mergeVideos} disabled={running || exportLocked || !hasClippingItems}
              onChange={(event) => toggleMerge(event.target.checked)} />
            <span className="export-checkbox-control" aria-hidden="true"><span className="export-checkbox-gloss" /></span>
            <span className="export-checkbox-text">{text.merge}</span>
          </label>
        </div>
        <button
          className="batch-start primary floating-launch-start"
          type="button"
          disabled={running || calibrationBusy || !canStart}
          onClick={start}
        >
          {exportLocked ? text.merging : activePhase === 'calibration' ? text.calibrating : running ? text.running : text.start}
        </button>
      </div>
      {preview && (
        <div className="modal-backdrop batch-preview-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
          <div className="modal batch-preview">
            <div className="batch-preview-header">
              <h2>{preview.name}</h2>
              <button className="preview-close" type="button" onClick={() => setPreview(null)}>×</button>
            </div>
            <div className="batch-preview-media" style={{ aspectRatio: `${preview.width} / ${preview.height}` }}>
              <CompatibleVideo hdr={preview.hdr} src={preview.source} controls autoPlay />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
