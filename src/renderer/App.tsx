import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AnalysisResultV1, AppSettings, Calibration, CutSelectionV1, ExportResult, HistorySummaryV1, Rally, UpdateState, VideoMetadata } from '../shared/contracts';
import type { AppEvent, BootstrapData, PendingComponentImport, SelectedVideo } from '../shared/api';
import { DONATION_URL, GITHUB_URL, RELEASES_URL, WEBSITE_URL } from '../shared/urls';
import { formatTimestamp } from '../domain/time';
import { rallyPreviewRange } from '../domain/preview';
import { validateCalibration } from '../domain/calibration';
import { interpolate, messages, type Language, type Messages } from './i18n';
import { MultiTaskPage } from './MultiTaskPage';
import packageJson from '../../package.json';
import captureGuideImage from './assets/pingpong-table-with-pose-mannequins.png';

type View = 'auto' | 'history' | 'settings' | 'multi';
type Step = 'select' | 'calibrate' | 'analyzing' | 'empty' | 'mode' | 'cutting' | 'complete' | 'error';
type PointName = keyof Calibration['points'];

const appVersion = packageJson.version;
const pointOrder: PointName[] = ['top_left', 'top_right', 'bottom_right', 'bottom_left'];

function fileSize(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function errorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0] ?? 'UNKNOWN';
}

function localizedError(code: string, translations: Messages): string {
  return translations.errors[code as keyof typeof translations.errors] ?? translations.errors.UNKNOWN;
}

function CalibrationSurface({
  video, metadata, points, onPointsChange,
}: {
  video: SelectedVideo;
  metadata: VideoMetadata;
  points: Partial<Record<PointName, [number, number]>>;
  onPointsChange: (points: Partial<Record<PointName, [number, number]>>) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const dragging = useRef<PointName | null>(null);

  const toSource = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const element = videoRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const scale = Math.min(rect.width / metadata.width, rect.height / metadata.height);
    const renderedWidth = metadata.width * scale;
    const renderedHeight = metadata.height * scale;
    const offsetX = rect.left + (rect.width - renderedWidth) / 2;
    const offsetY = rect.top + (rect.height - renderedHeight) / 2;
    const x = (clientX - offsetX) / scale;
    const y = (clientY - offsetY) / scale;
    if (x < 0 || y < 0 || x >= metadata.width || y >= metadata.height) return null;
    return [Math.max(0, Math.min(metadata.width - 1, x)), Math.max(0, Math.min(metadata.height - 1, y))];
  }, [metadata]);

  const sourceToPercent = (point: [number, number]) => {
    const surface = surfaceRef.current;
    const element = videoRef.current;
    if (!surface || !element) return { left: '50%', top: '50%' };
    const rect = element.getBoundingClientRect();
    const parent = surface.getBoundingClientRect();
    const scale = Math.min(rect.width / metadata.width, rect.height / metadata.height);
    const renderedWidth = metadata.width * scale;
    const renderedHeight = metadata.height * scale;
    const x = rect.left - parent.left + (rect.width - renderedWidth) / 2 + point[0] * scale;
    const y = rect.top - parent.top + (rect.height - renderedHeight) / 2 + point[1] * scale;
    return { left: `${x}px`, top: `${y}px` };
  };

  const setAtPointer = (event: ReactPointerEvent, name?: PointName) => {
    const next = toSource(event.clientX, event.clientY);
    if (!next) return;
    const target = name ?? pointOrder.find((item) => !points[item]);
    if (target) onPointsChange({ ...points, [target]: next });
  };

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const update = () => setCurrentTime(element.currentTime);
    element.addEventListener('timeupdate', update);
    return () => element.removeEventListener('timeupdate', update);
  }, []);

  return (
    <div className="calibration-shell">
      <div
        className="video-surface"
        ref={surfaceRef}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('.calibration-point')) return;
          setAtPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) setAtPointer(event, dragging.current);
        }}
        onPointerUp={() => { dragging.current = null; }}
      >
        <video ref={videoRef} src={video.mediaUrl} preload="metadata" muted playsInline />
        {pointOrder.map((name, index) => points[name] && (
          <button
            type="button"
            key={name}
            className="calibration-point"
            style={sourceToPercent(points[name]!)}
            aria-label={`Calibration point ${index + 1}`}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = name;
              event.stopPropagation();
            }}
            onPointerMove={(event) => {
              if (dragging.current === name) setAtPointer(event, name);
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId);
              dragging.current = null;
            }}
          >{index + 1}</button>
        ))}
      </div>
      <div className="scrubber-row">
        <span>{formatTimestamp(currentTime)}</span>
        <input
          aria-label="Video position"
          type="range"
          min={0}
          max={metadata.duration_seconds}
          step={0.01}
          value={currentTime}
          onChange={(event) => {
            const value = Number(event.target.value);
            setCurrentTime(value);
            if (videoRef.current) videoRef.current.currentTime = value;
          }}
        />
        <span>{formatTimestamp(metadata.duration_seconds)}</span>
      </div>
    </div>
  );
}

function RallyPreviewDialog({ video, videoDuration, rally, translations, onClose }: {
  video: SelectedVideo;
  videoDuration: number;
  rally: Rally;
  translations: Messages;
  onClose: () => void;
}) {
  const bounds = useMemo(() => rallyPreviewRange(rally, videoDuration), [rally, videoDuration]);
  const previewRef = useRef<HTMLVideoElement>(null);
  const [position, setPosition] = useState(bounds.start);
  const [failed, setFailed] = useState(false);
  const seekToleranceSeconds = 0.05;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      const element = previewRef.current;
      if (element) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
    };
  }, [onClose]);

  const clampToRally = (element: HTMLVideoElement) => {
    if (element.currentTime < bounds.start - seekToleranceSeconds) element.currentTime = bounds.start;
    else if (element.currentTime > bounds.end + seekToleranceSeconds) element.currentTime = bounds.end;
  };

  return (
    <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal rally-preview-modal" role="dialog" aria-modal="true" aria-label={translations.rallyPreviewTitle}>
        <div className="preview-heading"><div><h2>{translations.rallyPreviewTitle}</h2><p>{interpolate(translations.rallyPreviewDetail, { index: rally.index })}</p></div><button className="preview-close" type="button" aria-label={translations.closePreview} onClick={onClose}>×</button></div>
        <video
          ref={previewRef}
          src={video.mediaUrl}
          controls
          preload="metadata"
          playsInline
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = bounds.start;
            setPosition(bounds.start);
          }}
          onPlay={(event) => {
            if (event.currentTarget.currentTime >= bounds.end - seekToleranceSeconds) event.currentTarget.currentTime = bounds.start;
          }}
          onSeeking={(event) => clampToRally(event.currentTarget)}
          onTimeUpdate={(event) => {
            const element = event.currentTarget;
            if (element.currentTime >= bounds.end) {
              element.pause();
              element.currentTime = bounds.end;
            }
            setPosition(Math.max(bounds.start, Math.min(bounds.end, element.currentTime)));
          }}
          onError={() => setFailed(true)}
        />
        <div className="preview-time"><span>{formatTimestamp(position)}</span><span>{formatTimestamp(bounds.start)} – {formatTimestamp(bounds.end)}</span></div>
        {failed && <p className="preview-error" role="alert">{translations.previewFailed}</p>}
      </div>
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    language: 'zh-CN', calibration_method: 'automatic', export_strategy: 'compatible',
    pre_roll_seconds: 2.5, post_roll_seconds: 2,
  });
  const [view, setView] = useState<View>('auto');
  const [step, setStep] = useState<Step>('select');
  const [video, setVideo] = useState<SelectedVideo | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [points, setPoints] = useState<Partial<Record<PointName, [number, number]>>>({});
  const [analysis, setAnalysis] = useState<AnalysisResultV1 | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [forceManual, setForceManual] = useState(false);
  const [multiVideos, setMultiVideos] = useState<SelectedVideo[]>([]);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle', version: null, message: null });
  const [mode, setMode] = useState<'all' | 'highlight' | 'custom'>('all');
  const [threshold, setThreshold] = useState<3 | 5 | 7>(5);
  const [customIds, setCustomIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState({ percent: 0, stage: 'probe' });
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<{ code: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [closeDialog, setCloseDialog] = useState(false);
  const [languageTransition, setLanguageTransition] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [setupTask, setSetupTask] = useState<string | null>(null);
  const setupTaskRef = useRef<string | null>(null);
  const multiActiveRef = useRef(false);
  const settingsRef = useRef(settings);
  const promptedUpdateVersion = useRef<string | null>(null);
  const [setupProgress, setSetupProgress] = useState<{ percent: number; stage: string; current?: number; total?: number } | null>(null);
  const [setupOutcome, setSetupOutcome] = useState<'success' | 'pending' | 'cancelled' | 'failed' | null>(null);
  const [setupFailureCode, setSetupFailureCode] = useState<string | null>(null);
  const [setupPendingImports, setSetupPendingImports] = useState<PendingComponentImport[]>([]);
  const [historyEntries, setHistoryEntries] = useState<HistorySummaryV1[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyConfirmation, setHistoryConfirmation] = useState<{ kind: 'delete'; id: string } | { kind: 'clear' } | null>(null);
  const [missingComponents, setMissingComponents] = useState<string[] | null>(null);
  const [previewRally, setPreviewRally] = useState<Rally | null>(null);
  const t = messages(settings.language as Language);
  const platformSupported = bootstrap?.platformCompatibility.status === 'supported';
  const useManualCalibration = settings.calibration_method === 'manual' || forceManual;
  const platformDetail = !bootstrap
    ? ''
    : platformSupported
      ? interpolate(t.platformSupportedDetail, { build: bootstrap.platformCompatibility.build_number ?? '—' })
      : bootstrap.platformCompatibility.reason === 'probe_failed'
        ? t.platformProbeFailedDetail
        : t.platformUnsupportedDetail;

  useEffect(() => {
    void window.ttcut.bootstrap().then((data) => {
      setBootstrap(data);
      setSettings(data.settings);
      settingsRef.current = data.settings;
      if (data.platformCompatibility.status !== 'supported' || !data.components.analysis.available || !data.components.media.available) {
        setView('settings');
      }
    });
    const removeTask = window.ttcut.onTaskEvent((event: AppEvent) => {
      if (multiActiveRef.current && event.type !== 'component-result') return;
      if (event.type === 'progress') {
        if (event.data.kind === 'setup') {
          setupTaskRef.current = event.data.taskId;
          setSetupTask(event.data.taskId);
          setSetupProgress({
            percent: event.data.percent,
            stage: event.data.stage,
            ...(event.data.current === undefined ? {} : { current: event.data.current }),
            ...(event.data.total === undefined ? {} : { total: event.data.total }),
          });
          return;
        }
        setActiveTask(event.data.taskId);
        setProgress({ percent: event.data.percent, stage: event.data.stage });
      } else if (event.type === 'analysis-result') {
        setActiveTask(null);
        setAnalysisId(event.analysisId);
        setAnalysis(event.data);
        setPoints(event.calibration.points);
        setStep(event.data.rallies.length ? 'mode' : 'empty');
      } else if (event.type === 'export-result') {
        setActiveTask(null);
        setExportResult(event.data);
        setStep('complete');
      } else if (event.type === 'component-result') {
        setupTaskRef.current = null;
        setSetupTask(null);
        setSetupProgress(null);
        setSetupOutcome(event.pendingImports.length ? 'pending' : 'success');
        setSetupFailureCode(null);
        setSetupPendingImports(event.pendingImports);
        setBootstrap((current) => current ? { ...current, components: event.data } : current);
      } else {
        if (setupTaskRef.current === event.taskId) {
          setupTaskRef.current = null;
          setSetupTask(null);
          setSetupProgress(null);
          setSetupOutcome(event.code === 'SETUP_CANCELLED' ? 'cancelled' : 'failed');
          setSetupFailureCode(event.code);
          return;
        }
        if (settingsRef.current.calibration_method === 'automatic'
          && ['AUTO_CALIBRATION_FAILED', 'TABLE_MODEL_RESOURCE_ERROR'].includes(event.code)) {
          setActiveTask(null);
          setForceManual(true);
          setToast(event.code === 'TABLE_MODEL_RESOURCE_ERROR'
            ? (settingsRef.current.language === 'zh-CN' ? '自动标定模型不可用，请改用手动标定。' : 'The automatic calibration model is unavailable. Please calibrate manually.')
            : (settingsRef.current.language === 'zh-CN' ? '自动标定不可靠，请改用手动标定。' : 'Automatic calibration was unreliable. Please calibrate manually.'));
          setStep('calibrate');
          return;
        }
        if (event.code === 'EXPORT_CANCELLED') {
          setActiveTask(null);
          setStep('mode');
          return;
        }
        setActiveTask(null);
        setError({ code: event.code });
        setStep('error');
      }
    });
    const removeClose = window.ttcut.onCloseRequested(() => setCloseDialog(true));
    const removeUpdate = window.ttcut.onUpdateState(setUpdateState);
    void window.ttcut.getUpdateState().then(setUpdateState);
    return () => { removeTask(); removeClose(); removeUpdate(); };
  }, []);

  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (updateState.status !== 'downloaded' || promptedUpdateVersion.current === updateState.version) return;
    promptedUpdateVersion.current = updateState.version;
    if (window.confirm(`TTcut ${updateState.version ?? ''} 已下载完成。立即重启安装？\n选择“取消”可稍后重启。`)) {
      void window.ttcut.restartToUpdate();
    }
  }, [updateState]);

  const reset = useCallback(() => {
    setPreviewRally(null);
    setStep('select'); setVideo(null); setMetadata(null); setPoints({}); setAnalysis(null); setAnalysisId(null); setForceManual(false);
    setMode('all'); setThreshold(5); setCustomIds(new Set()); setProgress({ percent: 0, stage: 'probe' });
    setActiveTask(null); setExportResult(null); setError(null);
  }, []);

  const acceptVideo = async (selected: SelectedVideo | null) => {
    if (!selected) return;
    try {
      const info = await window.ttcut.probeVideo(selected.path);
      setVideo(selected); setMetadata(info); setPoints({}); setAnalysisId(null); setForceManual(false); setError(null); setStep('calibrate'); setView('auto');
    } catch (caught) {
      setError({ code: errorCode(caught) }); setStep('error');
    }
  };

  const acceptVideos = async (selected: SelectedVideo[]) => {
    if (!selected.length) return;
    if (selected.length === 1) {
      await acceptVideo(selected[0] ?? null);
      return;
    }
    multiActiveRef.current = true;
    setMultiVideos(selected);
    setView('multi');
  };
  const choose = async () => acceptVideos(await window.ttcut.selectVideos());
  const allPoints = metadata && pointOrder.every((name) => points[name]);
  const calibrationValue: Calibration | null = metadata && allPoints ? {
    video_width: metadata.width,
    video_height: metadata.height,
    points: points as Calibration['points'],
  } : null;
  const calibrationIssue = calibrationValue ? validateCalibration(calibrationValue) : null;
  const highlights = analysis?.rallies.filter((rally) => rally.bounce_count > threshold) ?? [];
  const selectedCount = mode === 'all' ? analysis?.rallies.length ?? 0 : mode === 'highlight' ? highlights.length : customIds.size;

  const startAnalysis = async () => {
    if (!video || !metadata || (useManualCalibration && (!calibrationValue || calibrationIssue)) || !platformSupported || !bootstrap?.components.analysis.available) return;
    setStep('analyzing'); setProgress({ percent: 0, stage: 'load_model' });
    try {
      setActiveTask(await window.ttcut.startAnalysis({
        videoPath: video.path,
        calibrationChoice: useManualCalibration ? { method: 'manual', calibration: calibrationValue! } : { method: 'automatic' },
        device: 'auto',
        historyVisibility: 'visible',
      }));
    } catch (caught) {
      setError({ code: errorCode(caught) }); setStep('error');
    }
  };

  const startCutting = async () => {
    if (!analysis || !analysisId || !platformSupported || !bootstrap?.components.media.available || selectedCount === 0) return;
    let selection: CutSelectionV1;
    const common = { pre_roll_seconds: settings.pre_roll_seconds, post_roll_seconds: settings.post_roll_seconds } as const;
    if (mode === 'all') selection = { mode, ...common };
    else if (mode === 'highlight') selection = { mode, highlight_threshold: threshold, ...common };
    else selection = { mode, selected_rally_ids: [...customIds], ...common };
    setStep('cutting'); setProgress({ percent: 0, stage: 'preparing' });
    try {
      setActiveTask(await window.ttcut.startExport({
        analysis_id: analysisId,
        selection,
        destination: 'source',
        export_strategy: settings.export_strategy,
      }));
    } catch (caught) {
      setError({ code: errorCode(caught) }); setStep('error');
    }
  };

  const changeLanguage = async (language: Language) => {
    if (language === settings.language) return;
    setLanguageTransition(true);
    await new Promise((resolve) => setTimeout(resolve, 160));
    const next = await window.ttcut.saveSettings({ ...settings, language });
    setSettings(next);
    settingsRef.current = next;
    document.documentElement.lang = language;
    await new Promise((resolve) => setTimeout(resolve, 160));
    setLanguageTransition(false);
  };

  const saveRolls = async (partial: Partial<AppSettings>) => {
    const next = await window.ttcut.saveSettings({ ...settings, ...partial });
    setSettings(next);
    settingsRef.current = next;
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistoryEntries(await window.ttcut.listHistory());
    } catch (caught) {
      setHistoryError(errorCode(caught));
    } finally {
      setHistoryLoading(false);
    }
  };

  const showHistory = () => {
    setPreviewRally(null);
    setView('history');
    void loadHistory();
  };

  const openHistory = async (id: string) => {
    try {
      const opened = await window.ttcut.openHistory(id);
      setVideo(opened.video);
      setMetadata(opened.analysis.video);
      setAnalysis(opened.analysis);
      setAnalysisId(opened.analysisId);
      setPoints(opened.calibration.points);
      setMode('all');
      setThreshold(5);
      setCustomIds(new Set());
      setExportResult(null);
      setError(null);
      setStep('mode');
      setView('auto');
    } catch (caught) {
      const code = errorCode(caught);
      await loadHistory();
      setHistoryError(code);
    }
  };

  const confirmHistoryAction = async () => {
    const confirmation = historyConfirmation;
    if (!confirmation) return;
    setHistoryConfirmation(null);
    setHistoryError(null);
    try {
      if (confirmation.kind === 'clear') await window.ttcut.clearHistory();
      else await window.ttcut.deleteHistory(confirmation.id);
      await loadHistory();
    } catch (caught) {
      setHistoryError(errorCode(caught));
    }
  };

  const refreshComponents = async () => {
    const components = await window.ttcut.refreshComponents();
    setBootstrap((current) => current ? { ...current, components } : current);
    const missing = [
      ...(!components.analysis.available ? [t.analysisComponent] : []),
      ...(!components.media.available ? [t.mediaComponent] : []),
    ];
    setMissingComponents(missing.length > 0 ? missing : null);
  };

  const importComponents = async () => {
    setSetupOutcome(null);
    setSetupFailureCode(null);
    setSetupPendingImports([]);
    if (!platformSupported) {
      setSetupOutcome('failed');
      setSetupFailureCode(bootstrap?.platformCompatibility.reason === 'probe_failed' ? 'PLATFORM_PROBE_FAILED' : 'PLATFORM_UNSUPPORTED');
      return;
    }
    try {
      const taskId = await window.ttcut.importComponents();
      if (!taskId) return;
      setupTaskRef.current = taskId;
      setSetupTask(taskId);
    } catch (caught) {
      setSetupOutcome('failed');
      setSetupFailureCode(errorCode(caught));
    }
  };

  const installMediaComponent = async () => {
    setSetupOutcome(null);
    setSetupFailureCode(null);
    if (!platformSupported) {
      setSetupOutcome('failed');
      setSetupFailureCode(bootstrap?.platformCompatibility.reason === 'probe_failed' ? 'PLATFORM_PROBE_FAILED' : 'PLATFORM_UNSUPPORTED');
      return;
    }
    try {
      const taskId = await window.ttcut.installMediaComponent(true);
      setupTaskRef.current = taskId;
      setSetupTask(taskId);
    } catch (caught) {
      setSetupOutcome('failed');
      setSetupFailureCode(errorCode(caught));
    }
  };

  const installAnalysisComponent = async () => {
    setSetupOutcome(null);
    setSetupFailureCode(null);
    if (!platformSupported) {
      setSetupOutcome('failed');
      setSetupFailureCode(bootstrap?.platformCompatibility.reason === 'probe_failed' ? 'PLATFORM_PROBE_FAILED' : 'PLATFORM_UNSUPPORTED');
      return;
    }
    try {
      const taskId = await window.ttcut.installAnalysisComponent(true);
      setupTaskRef.current = taskId;
      setSetupTask(taskId);
    } catch (caught) {
      setSetupOutcome('failed');
      setSetupFailureCode(errorCode(caught));
    }
  };

  const tableRecognitionStage = progress.stage === 'table_sampling'
    || progress.stage === 'table_model'
    || progress.stage === 'table_inference';
  const stageText = tableRecognitionStage
    ? (settings.language === 'zh-CN' ? '正在识别球桌' : 'Recognizing table')
    : t.stages[progress.stage as keyof typeof t.stages] ?? progress.stage;
  const setupPendingText = setupPendingImports.map((pending) => interpolate(t.setupPending, {
    variant: pending.variant,
    received: pending.receivedParts,
    total: pending.totalParts,
  })).join(' ');
  const canReturnToSelection = view === 'multi' || (
    view === 'auto'
      && step !== 'select'
      && step !== 'analyzing'
      && step !== 'cutting'
      && Boolean(video)
      && !activeTask
      && !setupTask
  );
  const returnToSelection = () => {
    if (view === 'multi') {
      multiActiveRef.current = false;
      setMultiVideos([]);
    }
    reset();
    setView('auto');
  };

  return (
    <div className={`app-shell ${languageTransition ? 'language-changing' : ''}`}>
      <header className="titlebar" onDoubleClick={() => void window.ttcut.toggleMaximize()}>
        {canReturnToSelection && (
          <button
            type="button"
            className="workflow-back"
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={returnToSelection}
          >
            <span aria-hidden="true">←</span>{t.back}
          </button>
        )}
        <div className="titlebar-spacer" />
        <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" aria-label="Minimize" onClick={() => void window.ttcut.minimize()}>—</button>
          <button type="button" aria-label="Maximize or restore" onClick={() => void window.ttcut.toggleMaximize()}>□</button>
          <button type="button" className="close-control" aria-label="Close" onClick={() => void window.ttcut.close()}>×</button>
        </div>
      </header>
      <aside className="sidebar">
        <div className="brand"><span>TTcut</span><small>v{bootstrap?.version ?? '1.0.0'}</small></div>
        <nav aria-label="Primary navigation">
          <button className={view === 'auto' || view === 'multi' ? 'active' : ''} onClick={() => { multiActiveRef.current = false; setView('auto'); }}><i />{t.autoCut}</button>
          <button className={view === 'history' ? 'active' : ''} onClick={showHistory}><i />{t.history}</button>
        </nav>
        <button className={`settings-link ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><i />{t.settings}</button>
      </aside>

      <main className="main-content">
        {view === 'multi' ? (
          <MultiTaskPage
            initialVideos={multiVideos}
            preRoll={settings.pre_roll_seconds}
            postRoll={settings.post_roll_seconds}
            exportStrategy={settings.export_strategy}
            onOpenAnalysis={(id) => { multiActiveRef.current = false; void openHistory(id); }}
          />
        ) : view === 'settings' ? (
          <section className="page settings-page">
            <div className="page-heading settings-heading"><h1>{t.settings}</h1></div>
            <div className="settings-grid">
              <article className="card about-card">
                <div className="about-brand"><span>TT</span><div><h2>TTcut</h2><p>{settings.language === 'zh-CN' ? `当前版本 ${bootstrap?.version ?? ''}` : `Version ${bootstrap?.version ?? ''}`}</p></div></div>
                <div className="about-actions">
                  <button className="secondary" onClick={() => void window.ttcut.openExternalUrl(WEBSITE_URL)}>{settings.language === 'zh-CN' ? '官方网站' : 'Website'}</button>
                  <button className="secondary" onClick={() => void window.ttcut.openExternalUrl(GITHUB_URL)}>GitHub</button>
                  <button className="secondary" onClick={() => void window.ttcut.openExternalUrl(RELEASES_URL)}>{settings.language === 'zh-CN' ? '更新日志' : 'Release notes'}</button>
                  <button className="secondary donate-button" onClick={() => void window.ttcut.openExternalUrl(DONATION_URL)}>{settings.language === 'zh-CN' ? '打赏作者' : 'Support author'}</button>
                  <button className="secondary" disabled={updateState.status === 'checking'} onClick={() => updateState.status === 'downloaded' ? void window.ttcut.restartToUpdate() : void window.ttcut.checkForUpdates()}>{updateState.status === 'checking' ? (settings.language === 'zh-CN' ? '正在检查…' : 'Checking…') : updateState.status === 'downloaded' ? (settings.language === 'zh-CN' ? '立即重启' : 'Restart now') : (settings.language === 'zh-CN' ? '检查更新' : 'Check updates')}</button>
                </div>
                {updateState.status !== 'idle' && <p className="update-detail">{updateState.status === 'up-to-date' ? (settings.language === 'zh-CN' ? '当前已是最新稳定版。' : 'You are using the latest stable version.') : updateState.status === 'available' ? (settings.language === 'zh-CN' ? '发现新版本，正在后台下载。' : 'A new version is downloading in the background.') : updateState.status === 'error' ? (updateState.message ?? (settings.language === 'zh-CN' ? '检查更新失败。' : 'Update check failed.')) : updateState.status === 'unsupported' ? (settings.language === 'zh-CN' ? '开发环境或当前平台不支持自动更新。' : 'Automatic updates are unavailable in this environment.') : ''}</p>}
              </article>
              <article className="card setting-card">
                <div><h2>{t.language}</h2></div>
                <div className="segmented">
                  <button className={settings.language === 'zh-CN' ? 'selected' : ''} onClick={() => void changeLanguage('zh-CN')}>{t.chinese}</button>
                  <button className={settings.language === 'en' ? 'selected' : ''} onClick={() => void changeLanguage('en')}>{t.english}</button>
                </div>
              </article>
              <article className="card setting-card">
                <div>
                  <h2>{settings.language === 'zh-CN' ? '导出方式' : 'Export strategy'}</h2>
                  <p>{settings.language === 'zh-CN'
                    ? '兼容模式保留现有全片滤镜流程；快速分段模式按片段 seek 后编码并使用 concat 合并。'
                    : 'Compatible mode keeps the existing filter graph; fast segmented mode seeks, encodes, and concatenates each segment.'}</p>
                </div>
                <div className="segmented">
                  <button
                    className={settings.export_strategy === 'compatible' ? 'selected' : ''}
                    onClick={() => void saveRolls({ export_strategy: 'compatible' })}
                  >
                    {settings.language === 'zh-CN' ? '兼容模式（默认）' : 'Compatible mode (default)'}
                  </button>
                  <button
                    className={settings.export_strategy === 'fast_segmented' ? 'selected' : ''}
                    onClick={() => void saveRolls({ export_strategy: 'fast_segmented' })}
                  >
                    {settings.language === 'zh-CN' ? '快速分段模式' : 'Fast segmented mode'}
                  </button>
                </div>
              </article>
              <article className="card setting-card">
                <div><h2>{settings.language === 'zh-CN' ? '球台标定' : 'Table calibration'}</h2><p>{settings.language === 'zh-CN' ? '选择单视频流程使用的球台标定方式。多任务始终使用自动标定。' : 'Choose the calibration method for single videos. Multi-task mode always uses automatic calibration.'}</p></div>
                <div className="segmented">
                  <button className={settings.calibration_method === 'manual' ? 'selected' : ''} onClick={() => void saveRolls({ calibration_method: 'manual' })}>{settings.language === 'zh-CN' ? '手动' : 'Manual'}</button>
                  <button className={settings.calibration_method === 'automatic' ? 'selected' : ''} onClick={() => void saveRolls({ calibration_method: 'automatic' })}>{settings.language === 'zh-CN' ? '自动' : 'Automatic'}</button>
                </div>
              </article>
              <article className="card timing-setting-card">
                <div><h2>{t.preRoll}</h2><p>{t.preRollSettingDetail}</p></div>
                <div className="choice-row">{([1.5, 2.5, 5] as const).map((value, index) => <button className={settings.pre_roll_seconds === value ? 'selected' : ''} key={value} onClick={() => void saveRolls({ pre_roll_seconds: value })}><strong>{[t.short, t.medium, t.long][index]}</strong><span>{value} s</span></button>)}</div>
              </article>
              <article className="card timing-setting-card">
                <div><h2>{t.postRoll}</h2><p>{t.postRollSettingDetail}</p></div>
                <div className="choice-row four">{([0.5, 1, 2, 4] as const).map((value, index) => <button className={settings.post_roll_seconds === value ? 'selected' : ''} key={value} onClick={() => void saveRolls({ post_roll_seconds: value })}><strong>{[t.veryShort, t.short, t.medium, t.long][index]}</strong><span>{value} s</span></button>)}</div>
              </article>
              <article className="card components-card">
                <h2>{t.components}</h2>
                <div className="component-row"><div><strong>{t.analysisComponent}</strong><span>{bootstrap?.components.analysis.version ?? t.unavailable}</span>{bootstrap?.components.analysis.path && <span>{t.componentPath}: {bootstrap.components.analysis.path}</span>}</div><span className={`status ${bootstrap?.components.analysis.available ? 'ok' : ''}`}>{bootstrap?.components.analysis.available ? t.available : t.unavailable}</span></div>
                <div className="component-row"><div><strong>{t.mediaComponent}</strong><span>{bootstrap?.components.media.version ?? t.unavailable}</span>{bootstrap?.components.media.available && <span>{t.activeEncoder}: {bootstrap.components.media.active_encoder === 'libx264' ? t.x264 : t.openh264}</span>}{bootstrap?.components.media.path && <span>{t.componentPath}: {bootstrap.components.media.path}</span>}</div><span className={`status ${bootstrap?.components.media.available ? 'ok' : ''}`}>{bootstrap?.components.media.available ? t.available : t.unavailable}</span></div>
                <div className="component-row"><div><strong>{t.acceleration}</strong><span>{bootstrap?.components.analysis.acceleration === 'cuda' ? t.gpu : bootstrap?.components.analysis.acceleration === 'cpu' ? t.cpu : t.unavailable}</span></div></div>
              </article>
              <article className="card setup-card">
                <div className="setup-heading"><div><h2>{t.setupTitle}</h2><p>{t.setupDetail}</p></div><button className="secondary" disabled={Boolean(setupTask)} onClick={() => void refreshComponents()}>{t.refreshComponents}</button></div>
                <p className="setup-purpose">{t.setupPurpose}</p>
                {setupProgress ? (
                  <div className="setup-progress" role="status">
                    <div><strong>{t.setupWorking}</strong><span>{t.setupStages[setupProgress.stage as keyof typeof t.setupStages] ?? setupProgress.stage}</span><b>{Math.round(setupProgress.percent)}%</b></div>
                    <div className="progress-track"><span style={{ width: `${setupProgress.percent}%` }} /></div>
                    <button className="secondary" onClick={() => setupTask && void window.ttcut.cancelTask(setupTask)}>{t.cancel}</button>
                  </div>
                ) : (
                  <div className="setup-options">
                    {bootstrap?.componentSetup.analysis_offer && !bootstrap.components.analysis.available && (
                      <div className="setup-option"><div><strong>{t.analysisOffer}</strong><span>{t.analysisOfferDetail}</span><small>{interpolate(t.downloadUpTo, { size: fileSize(bootstrap.componentSetup.analysis_offer.download_size_bytes) })}</small><small className="setup-network-hint">{t.networkHint}</small></div><div><button className="text-button" onClick={() => void window.ttcut.openExternalUrl(bootstrap.componentSetup.analysis_offer!.license_url)}>{t.viewLicense}</button><button className="primary" disabled={!platformSupported || !bootstrap.componentSetup.analysis_offer.available_for_download} onClick={() => void installAnalysisComponent()}>{t.consentInstall}</button></div></div>
                    )}
                    {bootstrap?.componentSetup.media_offer && !bootstrap.components.media.available && (
                      <div className="setup-option"><div><strong>{t.mediaOffer}</strong><span>{t.mediaOfferDetail}</span><small>{interpolate(t.downloadSize, { size: fileSize(bootstrap.componentSetup.media_offer.download_size_bytes) })}</small></div><div><button className="text-button" onClick={() => void window.ttcut.openExternalUrl(bootstrap.componentSetup.media_offer!.license_url)}>{t.viewLicense}</button><button className="primary" disabled={!platformSupported || !bootstrap.componentSetup.media_offer.available_for_download} onClick={() => void installMediaComponent()}>{t.consentInstall}</button></div></div>
                    )}
                    {bootstrap?.componentSetup.x264_manual_offer && !bootstrap.components.media.x264_available && (
                      <div className="setup-option optional-component"><div><strong>{t.x264ManualOffer}</strong><span>{t.x264ManualDetail}</span><small>{interpolate(t.downloadSize, { size: fileSize(bootstrap.componentSetup.x264_manual_offer.download_size_bytes) })}</small></div><div><button className="secondary" disabled={Boolean(setupTask)} onClick={() => void window.ttcut.openX264Download()}>{t.goToDownload}</button></div></div>
                    )}
                    <div className="setup-manual">
                      <div><strong>{t.manualDownload}</strong></div>
                      <div className="setup-manual-actions"><button className="text-button" disabled={Boolean(setupTask)} onClick={() => void window.ttcut.openComponentDownloads()}>{t.goToDownload}</button><button className="secondary" disabled={!platformSupported || Boolean(setupTask)} onClick={() => void importComponents()}>{t.importComponents}</button></div>
                    </div>
                  </div>
                )}
                {setupOutcome && <p className={`setup-outcome ${setupOutcome}`}>{setupOutcome === 'success' ? t.setupSuccess : setupOutcome === 'pending' ? setupPendingText : setupOutcome === 'cancelled' ? t.setupCancelled : setupFailureCode === 'COMPONENT_DOWNLOAD_RETRY_EXHAUSTED' ? t.setupNetworkFailed : setupFailureCode && (setupFailureCode.startsWith('COMPONENT_IMPORT_') || setupFailureCode.startsWith('X264_')) ? localizedError(setupFailureCode, t) : t.setupFailed}</p>}
              </article>
              <article className="card actions-card">
                <div><h2>{t.version}</h2><p>{appVersion}</p></div>
                <button className="secondary" onClick={() => void window.ttcut.revealLogs()}>{t.logs}</button>
                <button className="secondary" onClick={() => void window.ttcut.openLicenses()}>{t.licenses}</button>
              </article>
            </div>
          </section>
        ) : view === 'history' ? (
          <section className="page history-page">
            <div className="history-header"><div className="page-heading"><h1>{t.history}</h1><p>{t.historyDescription}</p></div><button className="secondary" disabled={historyEntries.length === 0 || Boolean(activeTask || setupTask)} onClick={() => setHistoryConfirmation({ kind: 'clear' })}>{t.clearHistory}</button></div>
            {historyError && <div className="history-error" role="alert"><span>{localizedError(historyError, t)}</span><button className="text-button" onClick={() => void loadHistory()}>{t.retry}</button></div>}
            {historyLoading ? (
              <div className="history-loading" role="status">{t.loadingHistory}</div>
            ) : historyEntries.length === 0 ? (
              <div className="empty-state history-empty"><span>○</span><h1>{t.noHistory}</h1><p>{t.noHistoryDetail}</p><button className="primary" onClick={() => { reset(); setView('auto'); }}>{t.startFirstAnalysis}</button></div>
            ) : (
              <div className="history-grid">
                {historyEntries.map((entry) => {
                  const unavailable = entry.source_status !== 'available';
                  return <article className={`history-card card ${unavailable ? 'unavailable' : ''}`} key={entry.id}>
                    <button className="history-open" disabled={unavailable || Boolean(activeTask || setupTask)} onClick={() => void openHistory(entry.id)}>
                      <div className="history-cover">{entry.cover_url ? <img src={entry.cover_url} alt="" /> : <span>{t.coverUnavailable}</span>}</div>
                      <div className="history-info"><strong title={entry.video_name}>{entry.video_name}</strong><div><span>{interpolate(t.historyRallies, { count: entry.rally_count })}</span><span>{formatTimestamp(entry.duration_seconds)}</span></div>{unavailable && <small>{entry.source_status === 'missing' ? t.historyMissing : t.historyChanged}</small>}</div>
                    </button>
                    <button className="history-delete" disabled={Boolean(activeTask || setupTask)} aria-label={interpolate(t.deleteHistoryItem, { name: entry.video_name })} onClick={() => setHistoryConfirmation({ kind: 'delete', id: entry.id })}>×</button>
                  </article>;
                })}
              </div>
            )}
          </section>
        ) : (
          <section className="page auto-page">
            {bootstrap && !platformSupported && step === 'select' && (
              <div className="notice platform-notice"><strong>{t.platformUnsupported}</strong><span>{platformDetail}</span><button className="secondary" onClick={() => setView('settings')}>{t.openSetup}</button></div>
            )}
            {bootstrap && platformSupported && (!bootstrap.components.analysis.available || !bootstrap.components.media.available) && step === 'select' && (
              <div className="notice"><strong>{t.componentMissing}</strong><span>{t.componentMissingDetail}</span><button className="secondary" onClick={() => setView('settings')}>{t.openSetup}</button></div>
            )}
            {step === 'select' && (
              <div className="center-stage">
                <div className="page-heading centered"><h1>{t.selectTitle}</h1><p>{t.selectDescription}</p></div>
                <button
                  type="button"
                  className={`drop-zone ${dragging ? 'dragging' : ''}`}
                  onClick={() => void choose()}
                  onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault(); setDragging(false);
                    const files = [...event.dataTransfer.files].filter((file) => file.name.toLowerCase().endsWith('.mp4'));
                    if (!files.length) { setToast(t.invalidFile); return; }
                    void Promise.all(files.map((file) => window.ttcut.acceptDroppedVideo(window.ttcut.pathForDroppedFile(file)))).then(acceptVideos).catch(() => {
                      setError({ code: 'INVALID_INPUT' }); setStep('error');
                    });
                  }}
                >
                  <span className="drop-icon">＋</span><strong>{t.chooseVideo}</strong><span>{t.dropVideo}</span><small>.mp4</small>
                </button>
              </div>
            )}

            {step === 'calibrate' && video && metadata && (
              <div className="workflow-page">
                <div className="page-heading"><p className="eyebrow">1 / 4</p><h1>{t.calibrationTitle}</h1><p>{useManualCalibration ? t.calibrationDescription : (settings.language === 'zh-CN' ? '将调用自动标定内核识别球台四角。' : 'The automatic calibration kernel will identify the table corners.')}</p></div>
                <div className="file-summary card"><div><span>{t.fileName}</span><strong>{video.name}</strong></div><div><span>{t.fileSize}</span><strong>{fileSize(video.size)}</strong></div><div><span>{t.duration}</span><strong>{formatTimestamp(metadata.duration_seconds)}</strong></div><div><span>{t.resolution}</span><strong>{metadata.width} × {metadata.height}</strong></div><div><span>{t.frameRate}</span><strong>{metadata.fps.toFixed(3)} fps</strong></div></div>
                {useManualCalibration ? <>
                  <CalibrationSurface video={video} metadata={metadata} points={points} onPointsChange={setPoints} />
                  <div className="point-legend">{[t.point1, t.point2, t.point3, t.point4].map((label, index) => <span className={points[pointOrder[index]!] ? 'done' : ''} key={label}><b>{index + 1}</b>{label.replace(/^\d\s/, '')}</span>)}</div>
                  {calibrationIssue && <p className="calibration-error" role="alert">{t.invalidCalibration}</p>}
                </> : <div className="card automatic-calibration"><span>⌖</span><div><h2>{settings.language === 'zh-CN' ? '自动球台标定' : 'Automatic table calibration'}</h2><p>{settings.language === 'zh-CN' ? '将识别首帧、25%、50%、75% 和尾帧，并融合为固定球台标定。' : 'The first, 25%, 50%, 75%, and final frames are combined into one fixed table calibration.'}</p></div></div>}
                <div className="footer-actions">{useManualCalibration && <button className="secondary" onClick={() => setPoints({})}>{t.resetPoints}</button>}<button className="primary" disabled={(useManualCalibration && (!allPoints || Boolean(calibrationIssue))) || !platformSupported || !bootstrap?.components.analysis.available} onClick={() => void startAnalysis()}>{t.startAnalysis}</button></div>
              </div>
            )}

            {(step === 'analyzing' || step === 'cutting') && (
              <div className="progress-stage">
                <div className="progress-orb"><span>{Math.round(progress.percent)}%</span></div>
                <h1>{step === 'analyzing' ? (tableRecognitionStage ? stageText : t.analyzing) : stageText}</h1>
                <p>{step === 'analyzing' ? (tableRecognitionStage ? stageText : t.analyzingDetail) : video?.name}</p>
                <div className="progress-track"><span style={{ width: `${progress.percent}%` }} /></div>
                <strong>{stageText}</strong>
                {activeTask && <button className="secondary" onClick={() => void window.ttcut.cancelTask(activeTask)}>{t.cancel}</button>}
              </div>
            )}

            {step === 'empty' && (
              <div className="empty-state"><span>○</span><h1>{t.noRallies}</h1><p>{t.noRalliesDetail}</p><button className="primary" onClick={reset}>{t.chooseAnother}</button></div>
            )}

            {step === 'mode' && analysis && (
              <div className="workflow-page mode-page">
                <div className="page-heading"><p className="eyebrow">3 / 4</p><h1>{t.modeTitle}</h1><p>{interpolate(t.detected, { count: analysis.rallies.length })}</p></div>
                <div className="mode-grid">
                  {([
                    ['all', t.all, t.allDetail], ['highlight', t.highlight, t.highlightDetail], ['custom', t.custom, t.customDetail],
                  ] as const).map(([value, title, detail]) => (
                    <button key={value} className={`mode-card ${mode === value ? 'selected' : ''}`} onClick={() => setMode(value)}><span className="radio-dot" /><strong>{title}</strong><small>{detail}</small></button>
                  ))}
                </div>
                {mode === 'highlight' && <div className="card inline-setting"><div><h2>{t.threshold}</h2><p>{t.highlightDetail}</p></div><div className="segmented">{([3, 5, 7] as const).map((value) => <button key={value} className={threshold === value ? 'selected' : ''} onClick={() => setThreshold(value)}>&gt; {value}</button>)}</div>{highlights.length === 0 && <span className="inline-error">{t.noHighlights}</span>}</div>}
                {mode === 'custom' && <div className="rally-table card"><div className="table-tools"><button className="text-button" onClick={() => setCustomIds(new Set(analysis.rallies.map((rally) => rally.id)))}>{t.selectAll}</button><button className="text-button" onClick={() => setCustomIds(new Set())}>{t.clearAll}</button></div><div className="table-scroll"><table><thead><tr><th /><th>{t.rally}</th><th>{t.strokes}</th><th>{t.start}</th><th>{t.end}</th><th>{t.preview}</th></tr></thead><tbody>{analysis.rallies.map((rally: Rally) => <tr key={rally.id}><td><input type="checkbox" checked={customIds.has(rally.id)} onChange={(event) => { const next = new Set(customIds); if (event.target.checked) next.add(rally.id); else next.delete(rally.id); setCustomIds(next); }} /></td><td>{rally.index}</td><td>{rally.bounce_count}</td><td>{formatTimestamp(rally.start_time_seconds)}</td><td>{formatTimestamp(rally.end_time_seconds)}</td><td><button className="text-button" onClick={() => setPreviewRally(rally)}>{t.preview}</button></td></tr>)}</tbody></table></div></div>}
                <div className="footer-actions"><span>{selectedCount} / {analysis.rallies.length}</span><button className="primary" disabled={selectedCount === 0 || !platformSupported || !bootstrap?.components.media.available} onClick={() => void startCutting()}>{t.startCutting}</button></div>
              </div>
            )}

            {step === 'complete' && exportResult && (
              <div className="workflow-page success-page"><div className="success-heading"><span>✓</span><div><p className="eyebrow">4 / 4</p><h1>{t.exportComplete}</h1></div></div><video className="output-preview" src={exportResult.mediaUrl} controls preload="metadata" /><div className="card output-details"><div><span>{t.outputName}</span><strong>{exportResult.outputName}</strong></div><div><span>{t.outputPath}</span><strong>{exportResult.outputPath}</strong></div></div><div className="footer-actions"><button className="secondary" onClick={() => void window.ttcut.revealOutput(exportResult.outputPath)}>{t.openFolder}</button><button className="primary" onClick={reset}>{t.cutAnother}</button></div></div>
            )}

            {step === 'error' && error && (
              <div className="empty-state error-state"><span>!</span><h1>{t.errorTitle}</h1><p>{localizedError(error.code, t)}</p><code>{error.code}</code><small>{t.technicalLog}</small><div className="error-actions"><button className="secondary" onClick={() => void window.ttcut.revealLogs()}>{t.logs}</button><button className="primary" onClick={() => { setError(null); setStep(video && metadata ? 'calibrate' : 'select'); }}>{t.retry}</button></div></div>
            )}
          </section>
        )}
      </main>

      {view === 'auto' && step === 'select' && (
        <div className="capture-help">
          <button type="button" className="capture-help-trigger" aria-label={t.captureGuideTitle}>
            <span aria-hidden="true">?</span>
          </button>
          <div className="capture-help-card" role="tooltip">
            <h2>{t.captureGuideTitle}</h2>
            <img src={captureGuideImage} alt={t.captureGuideImageAlt} />
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
      {languageTransition && <div className="language-loader"><span /></div>}
      {previewRally && video && analysis && <RallyPreviewDialog key={`${video.mediaUrl}:${previewRally.id}`} video={video} videoDuration={analysis.video.duration_seconds} rally={previewRally} translations={t} onClose={() => setPreviewRally(null)} />}
      {missingComponents && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label={t.componentCheckTitle}><h2>{t.componentCheckTitle}</h2><p>{interpolate(t.missingComponentsMessage, { components: missingComponents.join(settings.language === 'zh-CN' ? '、' : ', ') })}</p><div><button className="primary" onClick={() => setMissingComponents(null)}>{t.confirm}</button></div></div></div>}
      {historyConfirmation && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true"><h2>{historyConfirmation.kind === 'clear' ? t.clearHistoryTitle : t.deleteHistoryTitle}</h2><p>{historyConfirmation.kind === 'clear' ? t.clearHistoryConfirm : t.deleteHistoryConfirm}</p><div><button className="secondary" onClick={() => setHistoryConfirmation(null)}>{t.cancel}</button><button className="primary destructive-confirm" onClick={() => void confirmHistoryAction()}>{t.confirmDelete}</button></div></div></div>}
      {closeDialog && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true"><h2>{t.closeTitle}</h2><p>{t.closeDetail}</p><div><button className="secondary" onClick={() => { setCloseDialog(false); void window.ttcut.confirmClose('cancel'); }}>{t.cancel}</button><button className="secondary" onClick={() => { setCloseDialog(false); void window.ttcut.confirmClose('minimize'); }}>{t.minimize}</button><button className="primary" onClick={() => void window.ttcut.confirmClose('exit')}>{t.exit}</button></div></div></div>}
    </div>
  );
}
