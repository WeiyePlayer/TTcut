import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT,
  BLURBALL_STAGE1_CONFIDENCE_THRESHOLD_DEFAULT,
  DURATION_HIGHLIGHT_SECONDS,
  DURATION_HIGHLIGHT_TIER_VALUES,
  rallyRecognitionMethod,
  type AnalysisResultV1,
  type AppSettings,
  type Calibration,
  type CutSelectionV1,
  type ExportRequest,
  type ExportResult,
  type ExportWarning,
  type HistorySummaryV1,
  type DurationHighlightTier,
  type UpdateState,
  type VideoMetadata,
} from '../shared/contracts';
import type { AppEvent, BootstrapData, PendingComponentImport, SelectedVideo } from '../shared/api';
import { DONATION_URL, GITHUB_URL, RELEASES_URL, WEBSITE_URL } from '../shared/urls';
import { formatTimestamp } from '../domain/time';
import { createCustomClipDraft, customExportSegments, setCustomClipSelected, type CustomRallyClip } from '../domain/custom-clips';
import { normalizeCalibrationPoints, validateCalibration } from '../domain/calibration';
import { isSupportedVideoFileName } from '../domain/video-input';
import { isSupportPromptSuppressed, suppressSupportPromptForThirtyDays } from '../domain/support-prompt';
import { interpolate, messages, type Language, type Messages } from './i18n';
import { MultiTaskPage } from './MultiTaskPage';
import { CalibrationSurface } from './CalibrationSurface';
import { SupportPrompt } from './SupportPrompt';
import { CustomCutPage } from './CustomCutPage';
import { GlassRadioGroup } from './GlassRadioGroup';
import packageJson from '../../package.json';
import captureGuideImage from './assets/pingpong-table-with-pose-mannequins.png';
import ttcutIcon from './assets/ttcut-icon.png';
import contactAuthorQr from './assets/contact-author-qr.png';

type View = 'auto' | 'history' | 'settings' | 'multi';
type Step = 'select' | 'calibrate' | 'analyzing' | 'empty' | 'mode' | 'custom' | 'cutting' | 'complete' | 'error';
type VideoTaskOwner = 'single' | 'multi' | null;
type PointName = keyof Calibration['points'];

const appVersion = packageJson.version;
const pointOrder: PointName[] = ['top_left', 'top_right', 'bottom_right', 'bottom_left'];

function SidebarIcon({ kind }: { kind: 'scissors' | 'history' | 'settings' }) {
  if (kind === 'scissors') {
    return <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="m8.2 7.4 10.3 10.3M8.2 16.6 18.5 6.3" /></svg>;
  }
  if (kind === 'history') {
    return <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a8 8 0 1 1 2.3 5.7" /><path d="M4 5.5v5.5h5.5M12 7v5l3.2 1.8" /></svg>;
  }
  return <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.2 3.8.5-1.3h4.6l.5 1.3 1.6.7 1.3-.6 3.2 3.2-.6 1.3.7 1.6 1.3.5v4.6l-1.3.5-.7 1.6.6 1.3-3.2 3.2-1.3-.6-1.6.7-.5 1.3H9.7l-.5-1.3-1.6-.7-1.3.6-3.2-3.2.6-1.3L3 14.6l-1.3-.5V9.5L3 9l.7-1.6-.6-1.3 3.2-3.2 1.3.6 1.6-.7Z" /><circle cx="12" cy="12" r="3" /></svg>;
}

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

function updateErrorMessage(code: string | null, language: Language): string {
  if (code === 'UPDATE_VERIFICATION_FAILED') {
    return language === 'zh-CN'
      ? '下载的更新无法验证，请从官方发布页手动下载安装。'
      : 'The downloaded update could not be verified. Download it manually from the official release page.';
  }
  return language === 'zh-CN'
    ? '检查更新失败，请检查网络后重试。'
    : 'Update check failed. Check your network connection and try again.';
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    language: 'zh-CN', calibration_method: 'automatic',
    pre_roll_seconds: 2.5, post_roll_seconds: 1,
    analysis_mode: 'full',
    rally_recognition_method: 'bounce_events',
    normalize_variable_frame_rate: false,
  });
  const [view, setView] = useState<View>('auto');
  const [step, setStep] = useState<Step>('select');
  const [video, setVideo] = useState<SelectedVideo | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [points, setPoints] = useState<Partial<Record<PointName, [number, number]>>>({});
  const [analysis, setAnalysis] = useState<AnalysisResultV1 | null>(null);
  const [analysisWarning, setAnalysisWarning] = useState<ExportWarning | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [forceManual, setForceManual] = useState(false);
  const [multiVideos, setMultiVideos] = useState<SelectedVideo[]>([]);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle', version: null, message: null });
  const [mode, setMode] = useState<'all' | 'highlight' | 'custom'>('all');
  const [bounceThreshold, setBounceThreshold] = useState<3 | 5 | 7>(5);
  const [durationTier, setDurationTier] = useState<DurationHighlightTier>('rally');
  const blurballConfidenceThreshold = BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT;
  const blurballStage1ConfidenceThreshold = BLURBALL_STAGE1_CONFIDENCE_THRESHOLD_DEFAULT;
  const blurballStage2ConfidenceThreshold = BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT;
  const [customDraft, setCustomDraft] = useState<CustomRallyClip[] | null>(null);
  const [customOutputs, setCustomOutputs] = useState<NonNullable<ExportRequest['outputs']>>({
    combined_video: true,
    rally_videos: false,
    premiere_xml: false,
  });
  const [progress, setProgress] = useState({ percent: 0, stage: 'probe' });
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [videoTaskOwner, setVideoTaskOwnerState] = useState<VideoTaskOwner>(null);
  const videoTaskOwnerRef = useRef<VideoTaskOwner>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<{ code: string; recoveredOutputPath?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [supportPromptVisible, setSupportPromptVisible] = useState(false);
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
  const exportOriginRef = useRef<'mode' | 'custom'>('mode');
  const updateVideoTaskOwner = useCallback((owner: VideoTaskOwner) => {
    videoTaskOwnerRef.current = owner;
    setVideoTaskOwnerState(owner);
  }, []);
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
  const showSupportPrompt = useCallback(() => {
    if (!isSupportPromptSuppressed()) setSupportPromptVisible(true);
  }, []);

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
        if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
        setAnalysisId(event.analysisId);
        setAnalysis(event.data);
        setAnalysisWarning(event.data.processing?.mode === 'vfr_fallback' && event.data.processing.warning_code
          ? { code: event.data.processing.warning_code, message: event.data.processing.warning_code }
          : null);
        if (event.data.processing?.mode === 'normalized_cfr' && event.data.video.path !== video?.path) {
          void Promise.resolve(window.ttcut.acceptDroppedVideo(event.data.video.path)).then((processed) => {
            if (!processed) return;
            setVideo((current) => current ? { ...processed, name: current.name } : processed);
          }).catch(() => undefined);
        }
        if (event.data.processing?.mode === 'vfr_fallback') {
          setToast(settingsRef.current.language === 'zh-CN'
            ? `固定帧率预处理失败，已使用原始可变帧率视频继续分析（${event.data.processing.warning_code ?? 'CFR_FALLBACK'}）。`
            : `CFR preprocessing failed; analysis continued with the original VFR video (${event.data.processing.warning_code ?? 'CFR_FALLBACK'}).`);
        }
        setPoints(event.calibration.points);
        setStep(event.data.rallies.length ? 'mode' : 'empty');
      } else if (event.type === 'calibration-result') {
        return;
      } else if (event.type === 'export-result') {
        setActiveTask(null);
        if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
        setExportResult(event.data);
        setStep('complete');
        showSupportPrompt();
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
          if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
          setForceManual(true);
          setToast(event.code === 'TABLE_MODEL_RESOURCE_ERROR'
            ? (settingsRef.current.language === 'zh-CN' ? '自动标定模型不可用，请改用手动标定。' : 'The automatic calibration model is unavailable. Please calibrate manually.')
            : (settingsRef.current.language === 'zh-CN' ? '自动标定不可靠，请改用手动标定。' : 'Automatic calibration was unreliable. Please calibrate manually.'));
          setStep('calibrate');
          return;
        }
        if (event.code === 'EXPORT_CANCELLED') {
          setActiveTask(null);
          if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
          setStep(exportOriginRef.current);
          return;
        }
        if (event.code === 'ANALYSIS_CANCELLED') {
          setActiveTask(null);
          if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
          setStep('calibrate');
          return;
        }
        setActiveTask(null);
        if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
        setError({
          code: event.code,
          ...(event.recoveredOutputPath ? { recoveredOutputPath: event.recoveredOutputPath } : {}),
        });
        setStep('error');
      }
    });
    const removeClose = window.ttcut.onCloseRequested(() => setCloseDialog(true));
    const removeUpdate = window.ttcut.onUpdateState(setUpdateState);
    void window.ttcut.getUpdateState().then(setUpdateState);
    return () => { removeTask(); removeClose(); removeUpdate(); };
  }, [showSupportPrompt, updateVideoTaskOwner]);

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
    setStep('select'); setVideo(null); setMetadata(null); setPoints({}); setAnalysis(null); setAnalysisId(null); setForceManual(false);
    setAnalysisWarning(null);
    setMode('all'); setBounceThreshold(5); setDurationTier('rally'); setCustomDraft(null); setCustomOutputs({ combined_video: true, rally_videos: false, premiere_xml: false }); setProgress({ percent: 0, stage: 'probe' });
    setActiveTask(null); setExportResult(null); setError(null);
    if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
  }, [updateVideoTaskOwner]);

  const acceptVideo = async (selected: SelectedVideo | null) => {
    if (!selected) return;
    try {
      const info = await window.ttcut.probeVideo(selected.path);
      setVideo(selected); setMetadata(info); setPoints({}); setAnalysis(null); setAnalysisId(null); setAnalysisWarning(null); setForceManual(false); setError(null); setStep('calibrate'); setView('auto');
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
    updateVideoTaskOwner('multi');
    setMultiVideos(selected);
    setView('multi');
  };
  const choose = async () => acceptVideos(await window.ttcut.selectVideos());
  const allPoints = metadata && pointOrder.every((name) => points[name]);
  const calibrationValue: Calibration | null = metadata && allPoints ? {
    video_width: metadata.width,
    video_height: metadata.height,
    points: normalizeCalibrationPoints(pointOrder.map((name) => points[name]!)),
  } : null;
  const calibrationIssue = calibrationValue ? validateCalibration(calibrationValue) : null;
  const analysisUsesContinuousVisibility = analysis ? rallyRecognitionMethod(analysis) === 'continuous_visibility' : false;
  const highlights = analysis?.rallies.filter((rally) => (
    analysisUsesContinuousVisibility
      ? rally.end_time_seconds - rally.start_time_seconds > DURATION_HIGHLIGHT_SECONDS[durationTier]
      : 'bounce_count' in rally && typeof rally.bounce_count === 'number' && rally.bounce_count > bounceThreshold
  )) ?? [];
  const selectedCount = mode === 'all'
    ? analysis?.rallies.length ?? 0
    : mode === 'highlight'
      ? highlights.length
      : customDraft?.filter((clip) => clip.selected).length ?? 0;

  const openCustomEditor = () => {
    if (!analysis) return;
    setMode('custom');
    setCustomDraft(createCustomClipDraft(
      analysis.rallies,
      settings.pre_roll_seconds,
      settings.post_roll_seconds,
      analysis.video.duration_seconds,
      analysis.video.fps,
      rallyRecognitionMethod(analysis),
    ));
    setCustomOutputs({ combined_video: true, rally_videos: false, premiere_xml: false });
    setStep('custom');
  };

  const startAnalysis = async () => {
    if (!video || !metadata || (useManualCalibration && (!calibrationValue || calibrationIssue)) || !platformSupported || !bootstrap?.components.analysis.available) return;
    updateVideoTaskOwner('single');
    setStep('analyzing'); setProgress({ percent: 0, stage: 'load_model' });
    try {
      setActiveTask(await window.ttcut.startAnalysis({
        videoPath: video.path,
        calibrationChoice: useManualCalibration ? { method: 'manual', calibration: calibrationValue! } : { method: 'automatic' },
        device: 'auto',
        historyVisibility: 'visible',
        analysisMode: settings.rally_recognition_method === 'continuous_visibility' ? 'full' : settings.analysis_mode,
        rallyRecognitionMethod: settings.rally_recognition_method,
        normalizeVariableFrameRate: settings.normalize_variable_frame_rate,
        blurballConfidenceThreshold,
        blurballStage1ConfidenceThreshold,
        blurballStage2ConfidenceThreshold,
      }));
    } catch (caught) {
      if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
      setError({ code: errorCode(caught) }); setStep('error');
    }
  };

  const startCutting = async (preparedSelection?: CutSelectionV1, outputs?: ExportRequest['outputs']) => {
    const mediaRequired = (outputs?.combined_video ?? true) || outputs?.rally_videos === true;
    if (!analysis || !analysisId || !platformSupported || (mediaRequired && !bootstrap?.components.media.available)) return;
    if (!preparedSelection && selectedCount === 0) return;
    let selection: CutSelectionV1;
    const common = { pre_roll_seconds: settings.pre_roll_seconds, post_roll_seconds: settings.post_roll_seconds } as const;
    if (preparedSelection) selection = preparedSelection;
    else if (mode === 'all') selection = { mode, ...common };
    else if (mode === 'highlight') selection = analysisUsesContinuousVisibility
      ? { mode, criterion: { kind: 'duration_tier', tier: durationTier }, ...common }
      : { mode, criterion: { kind: 'bounce_count', threshold: bounceThreshold }, ...common };
    else return;
    if (selection.mode === 'custom' && selection.segments.length === 0) return;
    exportOriginRef.current = selection.mode === 'custom' ? 'custom' : 'mode';
    updateVideoTaskOwner('single');
    setStep('cutting'); setProgress({ percent: 0, stage: 'preparing' });
    try {
      setActiveTask(await window.ttcut.startExport({
        analysis_id: analysisId,
        selection,
        destination: 'source',
        ...(outputs ? { outputs } : {}),
      }));
    } catch (caught) {
      if (videoTaskOwnerRef.current === 'single') updateVideoTaskOwner(null);
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
    const next = { ...settings, ...partial };
    setSettings(next);
    settingsRef.current = next;
    const saved = await window.ttcut.saveSettings(next);
    setSettings(saved);
    settingsRef.current = saved;
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
    setView('history');
    void loadHistory();
  };

  const openHistory = async (id: string) => {
    if (videoTaskOwnerRef.current) return;
    try {
      const opened = await window.ttcut.openHistory(id);
      setVideo(opened.video);
      setMetadata(opened.analysis.video);
      setAnalysis(opened.analysis);
      setAnalysisWarning(opened.analysis.processing?.mode === 'vfr_fallback' && opened.analysis.processing.warning_code
        ? { code: opened.analysis.processing.warning_code, message: opened.analysis.processing.warning_code }
        : null);
      setAnalysisId(opened.analysisId);
      setPoints(opened.calibration.points);
      setMode('all');
      setBounceThreshold(5);
      setDurationTier('rally');
      setCustomDraft(null);
      setCustomOutputs({ combined_video: true, rally_videos: false, premiere_xml: false });
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
    if (!confirmation || videoTaskOwnerRef.current) return;
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
    if (videoTaskOwnerRef.current) return;
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
    if (videoTaskOwnerRef.current) return;
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
    if (videoTaskOwnerRef.current) return;
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
  const canReturnToSelection = (view === 'multi' && videoTaskOwner !== 'multi') || (
    view === 'auto'
      && step !== 'select'
      && step !== 'analyzing'
      && step !== 'cutting'
      && Boolean(video)
      && !activeTask
      && !setupTask
  );
  const customWorkspace = view === 'auto' && step === 'custom';
  const discardMulti = () => {
    multiActiveRef.current = false;
    setMultiVideos([]);
    if (videoTaskOwnerRef.current === 'multi') updateVideoTaskOwner(null);
  };
  const handleMultiTaskStateChange = (active: boolean) => {
    if (active && videoTaskOwnerRef.current !== 'multi') updateVideoTaskOwner('multi');
    if (!active && videoTaskOwnerRef.current === 'multi') updateVideoTaskOwner(null);
  };
  const requestView = (target: Exclude<View, 'multi'>) => {
    if (target === 'history') {
      showHistory();
      return;
    }
    if (target === 'settings') {
      setView('settings');
      return;
    }
    if (videoTaskOwnerRef.current === 'single') {
      setView('auto');
      return;
    }
    if (videoTaskOwnerRef.current === 'multi') {
      setView('multi');
      return;
    }
    if (multiVideos.length > 0) discardMulti();
    reset();
    setView('auto');
  };
  const returnToSelection = () => {
    if (view === 'auto' && step === 'custom') {
      setCustomDraft(null);
      setCustomOutputs({ combined_video: true, rally_videos: false, premiere_xml: false });
      setMode('all');
      setStep('mode');
      return;
    }
    requestView('auto');
  };

  return (
    <div className={`app-shell ${languageTransition ? 'language-changing' : ''} ${customWorkspace ? 'custom-workspace-shell' : ''}`}>
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
        <div className="brand"><img className="brand-icon" src={ttcutIcon} alt="" /><span>TTcut</span><small>v{bootstrap?.version ?? appVersion}</small></div>
        <nav aria-label="Primary navigation">
          <button aria-label={t.autoCut} title={t.autoCut} className={view === 'auto' || view === 'multi' ? 'active' : ''} onClick={() => requestView('auto')}><i /><SidebarIcon kind="scissors" /><span className="sidebar-label">{t.autoCut}</span></button>
          <button aria-label={t.history} title={t.history} className={view === 'history' ? 'active' : ''} onClick={() => requestView('history')}><i /><SidebarIcon kind="history" /><span className="sidebar-label">{t.history}</span></button>
        </nav>
        <button aria-label={t.settings} title={t.settings} className={`settings-link ${view === 'settings' ? 'active' : ''}`} onClick={() => requestView('settings')}><i /><SidebarIcon kind="settings" /><span className="sidebar-label">{t.settings}</span></button>
      </aside>

      <main className="main-content">
        {multiVideos.length > 0 && (
          <div hidden={view !== 'multi'}>
            <MultiTaskPage
              initialVideos={multiVideos}
              preRoll={settings.pre_roll_seconds}
              postRoll={settings.post_roll_seconds}
              analysisMode={settings.rally_recognition_method === 'continuous_visibility' ? 'full' : settings.analysis_mode}
              rallyRecognitionMethod={settings.rally_recognition_method}
              normalizeVariableFrameRate={settings.normalize_variable_frame_rate}
              blurballConfidenceThreshold={blurballConfidenceThreshold}
              blurballStage1ConfidenceThreshold={blurballStage1ConfidenceThreshold}
              blurballStage2ConfidenceThreshold={blurballStage2ConfidenceThreshold}
              language={settings.language}
              onTaskStateChange={handleMultiTaskStateChange}
              onOpenAnalysis={(id) => { discardMulti(); void openHistory(id); }}
              onCompletableTasksFinished={showSupportPrompt}
            />
          </div>
        )}
        {view !== 'multi' && (view === 'settings' ? (
          <section className="page settings-page">
            <div className="page-heading settings-heading"><h1>{t.settings}</h1></div>
            <div className="settings-grid">
              <article className="card about-card">
                <div className="about-brand"><img src={ttcutIcon} alt="" /><div><h2>TTcut</h2><p>{settings.language === 'zh-CN' ? `当前版本 ${bootstrap?.version ?? ''}` : `Version ${bootstrap?.version ?? ''}`}</p></div></div>
                <div className="about-actions">
                  <button className="secondary" onClick={() => void window.ttcut.openExternalUrl(WEBSITE_URL)}>{settings.language === 'zh-CN' ? '官方网站' : 'Website'}</button>
                  <button className="secondary" onClick={() => void window.ttcut.openExternalUrl(GITHUB_URL)}>GitHub</button>
                  <div className="contact-author">
                    <button className="secondary contact-author-button" type="button" aria-describedby="contact-author-qr">{settings.language === 'zh-CN' ? '联系作者' : 'Contact author'}</button>
                    <div className="contact-author-qr" id="contact-author-qr" role="tooltip">
                      <img src={contactAuthorQr} alt={settings.language === 'zh-CN' ? '联系作者微信二维码' : 'WeChat QR code for contacting the author'} />
                      <span>{settings.language === 'zh-CN' ? '微信扫码联系作者' : 'Scan with WeChat to contact the author'}</span>
                    </div>
                  </div>
                  <button className="secondary donate-button" onClick={() => void window.ttcut.openExternalUrl(DONATION_URL)}>{settings.language === 'zh-CN' ? '打赏作者' : 'Support author'}</button>
                  <button className="secondary" disabled={updateState.status === 'checking'} onClick={() => updateState.status === 'downloaded' ? void window.ttcut.restartToUpdate() : void window.ttcut.checkForUpdates()}>{updateState.status === 'checking' ? (settings.language === 'zh-CN' ? '正在检查…' : 'Checking…') : updateState.status === 'downloaded' ? (settings.language === 'zh-CN' ? '立即重启' : 'Restart now') : (settings.language === 'zh-CN' ? '检查更新' : 'Check updates')}</button>
                  {updateState.status === 'error' && updateState.message === 'UPDATE_VERIFICATION_FAILED' && (
                    <button className="secondary" onClick={() => void window.ttcut.openExternalUrl(RELEASES_URL)}>
                      {settings.language === 'zh-CN' ? '手动下载更新' : 'Download update manually'}
                    </button>
                  )}
                </div>
                {updateState.status !== 'idle' && <p className="update-detail">{updateState.status === 'up-to-date' ? (settings.language === 'zh-CN' ? '当前已是最新稳定版。' : 'You are using the latest stable version.') : updateState.status === 'available' ? (settings.language === 'zh-CN' ? '发现新版本，正在后台下载。' : 'A new version is downloading in the background.') : updateState.status === 'error' ? updateErrorMessage(updateState.message, settings.language) : updateState.status === 'unsupported' ? (settings.language === 'zh-CN' ? '开发环境或当前平台不支持自动更新。' : 'Automatic updates are unavailable in this environment.') : ''}</p>}
              </article>
              <article className="card setting-card">
                <div><h2>{t.language}</h2></div>
                <GlassRadioGroup
                  ariaLabel={t.language}
                  className="compact"
                  idPrefix="settings-language"
                  name="settings-language"
                  onChange={(language) => void changeLanguage(language)}
                  options={[{ value: 'zh-CN', label: t.chinese }, { value: 'en', label: t.english }] as const}
                  value={settings.language as Language}
                />
              </article>
              <article className="card setting-card">
                <div><h2>{t.rallyRecognitionMethod}</h2></div>
                <GlassRadioGroup
                  ariaLabel={t.rallyRecognitionMethod}
                  className="compact"
                  idPrefix="settings-rally-recognition"
                  name="settings-rally-recognition"
                  onChange={(rally_recognition_method) => void saveRolls({ rally_recognition_method })}
                  options={[
                    { value: 'bounce_events', label: t.bounceEvents },
                    { value: 'continuous_visibility', label: t.continuousVisibility },
                  ] as const}
                  value={settings.rally_recognition_method}
                />
              </article>
              {settings.rally_recognition_method === 'bounce_events' && <article className="card detector-settings-card">
                <section className="detector-setting">
                  <div>
                    <h2>{t.blurballAnalysisMode}</h2>
                    <p>{t.blurballAnalysisModeDetail}</p>
                  </div>
                  <GlassRadioGroup
                    ariaLabel={t.blurballAnalysisMode}
                    className="compact"
                    idPrefix="settings-blurball-mode"
                    name="settings-blurball-mode"
                    onChange={(analysis_mode) => void saveRolls({ analysis_mode })}
                    options={[
                      { value: 'full', label: t.blurballModeDefault },
                      { value: 'two_stage', label: t.blurballModeHighPrecision },
                    ] as const}
                    value={settings.analysis_mode}
                  />
                </section>
              </article>}
              <article className="card setting-card">
                <div>
                  <h2>{t.normalizeVariableFrameRate}</h2>
                  <p>{t.normalizeVariableFrameRateDetail}</p>
                </div>
                <GlassRadioGroup
                  ariaLabel={t.normalizeVariableFrameRate}
                  className="compact"
                  idPrefix="settings-normalize-variable-frame-rate"
                  name="settings-normalize-variable-frame-rate"
                  onChange={(normalize_variable_frame_rate) => void saveRolls({ normalize_variable_frame_rate })}
                  options={[
                    { value: false, label: t.off },
                    { value: true, label: t.on },
                  ] as const}
                  value={settings.normalize_variable_frame_rate}
                />
              </article>
              <article className="card setting-card">
                <div><h2>{settings.language === 'zh-CN' ? '球台标定' : 'Table calibration'}</h2><p>{settings.language === 'zh-CN' ? '选择单视频流程使用的球台标定方式。多任务会先自动标定，失败项目可手动补充。' : 'Choose the calibration method for single videos. Batch tasks calibrate automatically first, with manual recovery for failed items.'}</p></div>
                <GlassRadioGroup
                  ariaLabel={settings.language === 'zh-CN' ? '球台标定方式' : 'Table calibration method'}
                  className="compact"
                  idPrefix="settings-calibration"
                  name="settings-calibration"
                  onChange={(calibration_method) => void saveRolls({ calibration_method })}
                  options={[
                    { value: 'manual', label: settings.language === 'zh-CN' ? '手动' : 'Manual' },
                    { value: 'automatic', label: settings.language === 'zh-CN' ? '自动' : 'Automatic' },
                  ] as const}
                  value={settings.calibration_method}
                />
              </article>
              <article className="card timing-settings-card">
                <section className="timing-setting">
                  <div><h2>{t.preRoll}</h2><p>{t.preRollSettingDetail}</p></div>
                  <GlassRadioGroup
                    ariaLabel={t.preRoll}
                    className="timing-toggle"
                    idPrefix="settings-pre-roll"
                    name="settings-pre-roll"
                    onChange={(pre_roll_seconds) => void saveRolls({ pre_roll_seconds })}
                    options={([1.5, 2.5, 5] as const).map((value, index) => ({ value, label: [t.short, t.medium, t.long][index] }))}
                    value={settings.pre_roll_seconds}
                  />
                </section>
                <section className="timing-setting">
                  <div><h2>{t.postRoll}</h2><p>{t.postRollSettingDetail}</p></div>
                  <GlassRadioGroup
                    ariaLabel={t.postRoll}
                    className="timing-toggle"
                    idPrefix="settings-post-roll"
                    name="settings-post-roll"
                    onChange={(post_roll_seconds) => void saveRolls({ post_roll_seconds })}
                    options={([0.5, 1, 2, 4] as const).map((value, index) => ({ value, label: [t.veryShort, t.short, t.medium, t.long][index] }))}
                    value={settings.post_roll_seconds}
                  />
                </section>
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
                      <div className="setup-option"><div><strong>{t.analysisOffer}</strong><span>{t.analysisOfferDetail}</span><small>{interpolate(t.downloadUpTo, { size: fileSize(bootstrap.componentSetup.analysis_offer.download_size_bytes) })}</small><small className="setup-network-hint">{t.networkHint}</small></div><div><button className="text-button" onClick={() => void window.ttcut.openExternalUrl(bootstrap.componentSetup.analysis_offer!.license_url)}>{t.viewLicense}</button><button className="primary" disabled={!platformSupported || !bootstrap.componentSetup.analysis_offer.available_for_download || Boolean(videoTaskOwner)} onClick={() => void installAnalysisComponent()}>{t.consentInstall}</button></div></div>
                    )}
                    {bootstrap?.componentSetup.media_offer && !bootstrap.components.media.available && (
                      <div className="setup-option"><div><strong>{t.mediaOffer}</strong><span>{t.mediaOfferDetail}</span><small>{interpolate(t.downloadSize, { size: fileSize(bootstrap.componentSetup.media_offer.download_size_bytes) })}</small></div><div><button className="text-button" onClick={() => void window.ttcut.openExternalUrl(bootstrap.componentSetup.media_offer!.license_url)}>{t.viewLicense}</button><button className="primary" disabled={!platformSupported || !bootstrap.componentSetup.media_offer.available_for_download || Boolean(videoTaskOwner)} onClick={() => void installMediaComponent()}>{t.consentInstall}</button></div></div>
                    )}
                    {bootstrap?.componentSetup.x264_manual_offer && !bootstrap.components.media.x264_available && (
                      <div className="setup-option optional-component"><div><strong>{t.x264ManualOffer}</strong><span>{t.x264ManualDetail}</span><small>{interpolate(t.downloadSize, { size: fileSize(bootstrap.componentSetup.x264_manual_offer.download_size_bytes) })}</small></div><div><button className="secondary" disabled={Boolean(setupTask)} onClick={() => void window.ttcut.openX264Download()}>{t.goToDownload}</button></div></div>
                    )}
                    <div className="setup-manual">
                      <div><strong>{t.manualDownload}</strong></div>
                      <div className="setup-manual-actions"><button className="text-button" disabled={Boolean(setupTask)} onClick={() => void window.ttcut.openComponentDownloads()}>{t.goToDownload}</button><button className="secondary" disabled={!platformSupported || Boolean(setupTask) || Boolean(videoTaskOwner)} onClick={() => void importComponents()}>{t.importComponents}</button></div>
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
            <div className="history-header"><div className="page-heading"><h1>{t.history}</h1><p>{t.historyDescription}</p></div><button className="secondary" disabled={historyEntries.length === 0 || Boolean(activeTask || setupTask || videoTaskOwner)} onClick={() => setHistoryConfirmation({ kind: 'clear' })}>{t.clearHistory}</button></div>
            {historyError && <div className="history-error" role="alert"><span>{localizedError(historyError, t)}</span><button className="text-button" onClick={() => void loadHistory()}>{t.retry}</button></div>}
            {historyLoading ? (
              <div className="history-loading" role="status">{t.loadingHistory}</div>
            ) : historyEntries.length === 0 ? (
              <div className="empty-state history-empty"><span>○</span><h1>{t.noHistory}</h1><p>{t.noHistoryDetail}</p><button className="primary" onClick={() => requestView('auto')}>{t.startFirstAnalysis}</button></div>
            ) : (
              <div className="history-grid">
                {historyEntries.map((entry) => {
                  const unavailable = entry.source_status !== 'available';
                  return <article className={`history-card card ${unavailable ? 'unavailable' : ''}`} key={entry.id}>
                    <button className="history-open" disabled={unavailable || Boolean(activeTask || setupTask || videoTaskOwner)} onClick={() => void openHistory(entry.id)}>
                      <div className="history-cover">{entry.cover_url ? <img src={entry.cover_url} alt="" /> : <span>{t.coverUnavailable}</span>}</div>
                      <div className="history-info"><strong title={entry.video_name}>{entry.video_name}</strong><div><span>{interpolate(t.historyRallies, { count: entry.rally_count })}</span><span>{formatTimestamp(entry.duration_seconds)}</span></div>{unavailable && <small>{entry.source_status === 'missing' ? t.historyMissing : t.historyChanged}</small>}</div>
                    </button>
                    <button className="history-delete" disabled={Boolean(activeTask || setupTask || videoTaskOwner)} aria-label={interpolate(t.deleteHistoryItem, { name: entry.video_name })} onClick={() => setHistoryConfirmation({ kind: 'delete', id: entry.id })}>×</button>
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
            {analysisWarning && analysis && !['select', 'calibrate', 'analyzing', 'cutting'].includes(step) && (
              <section className="export-warning processing-warning" role="alert" aria-labelledby="processing-warning-title">
                <div className="export-warning-heading">
                  <span aria-hidden="true">!</span>
                  <div><strong id="processing-warning-title">{settings.language === 'zh-CN' ? '已回退使用原始可变帧率视频' : 'Fell back to the original variable-frame-rate video'}</strong><p>{localizedError(analysisWarning.code, t)}</p></div>
                  <button className="secondary" type="button" onClick={() => void window.ttcut.revealLogs()}>{t.logs}</button>
                </div>
                <div className="export-warning-summary"><code>{analysisWarning.code}</code><span>{localizedError(analysisWarning.code, t)}</span></div>
              </section>
            )}
            {step === 'select' && (
              <div className="center-stage">
                <div className="page-heading centered"><h1>{t.selectTitle}</h1></div>
                <button
                  type="button"
                  className={`drop-zone ${dragging ? 'dragging' : ''}`}
                  onClick={() => void choose()}
                  onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault(); setDragging(false);
                    const files = [...event.dataTransfer.files].filter((file) => isSupportedVideoFileName(file.name));
                    if (!files.length) { setToast(t.invalidFile); return; }
                    void Promise.all(files.map((file) => window.ttcut.acceptDroppedVideo(window.ttcut.pathForDroppedFile(file)))).then(acceptVideos).catch(() => {
                      setError({ code: 'INVALID_INPUT' }); setStep('error');
                    });
                  }}
                >
                  <span className="drop-icon" aria-hidden="true">＋</span>
                  <strong>{t.chooseVideo}</strong>
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
                </> : <div className="card automatic-calibration"><span>⌖</span><div><h2>{settings.language === 'zh-CN' ? '自动球台标定' : 'Automatic table calibration'}</h2><p>{settings.language === 'zh-CN' ? '将从视频多个位置识别球台，并通过跨帧几何一致性生成固定标定。' : 'The table is detected at multiple video positions and combined using cross-frame geometric consistency.'}</p></div></div>}
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
                    ['all', t.all, t.allDetail], ['highlight', t.highlight, analysisUsesContinuousVisibility ? t.highlightDurationDetail : t.highlightDetail], ['custom', t.custom, t.customDetail],
                  ] as const).map(([value, title, detail]) => (
                    <button key={value} className={`mode-card ${value !== 'custom' && mode === value ? 'selected' : ''} ${value === 'custom' ? 'mode-card-navigate' : ''}`} onClick={() => { if (value === 'custom') openCustomEditor(); else setMode(value); }}>
                      {value === 'custom' ? <span className="mode-card-chevron" aria-hidden="true" /> : <span className="radio-dot" />}
                      <strong>{title}</strong><small>{detail}</small>
                    </button>
                  ))}
                </div>
                {mode === 'highlight' && <div className="card inline-setting"><div><h2>{analysisUsesContinuousVisibility ? t.durationTier : t.threshold}</h2><p>{analysisUsesContinuousVisibility ? t.highlightDurationDetail : t.highlightDetail}</p></div>{analysisUsesContinuousVisibility ? <GlassRadioGroup ariaLabel={t.durationTier} className="compact" idPrefix="single-duration-tier" name="single-duration-tier" onChange={setDurationTier} options={DURATION_HIGHLIGHT_TIER_VALUES.map((value) => ({ value, label: value === 'short_rally' ? t.shortRallyTier : value === 'rally' ? t.rallyTier : t.longRallyTier }))} value={durationTier} /> : <GlassRadioGroup ariaLabel={t.threshold} className="compact" idPrefix="single-threshold" name="single-threshold" onChange={setBounceThreshold} options={[3, 5, 7].map((value) => ({ value: value as 3 | 5 | 7, label: `> ${value}` }))} value={bounceThreshold} />}{highlights.length === 0 && <span className="inline-error">{analysisUsesContinuousVisibility ? t.noDurationHighlights : t.noHighlights}</span>}</div>}
                <div className="footer-actions"><span>{selectedCount} / {analysis.rallies.length}</span><button className="primary" disabled={selectedCount === 0 || !platformSupported || !bootstrap?.components.media.available} onClick={() => void startCutting()}>{t.startCutting}</button></div>
              </div>
            )}

            {step === 'custom' && analysis && video && customDraft && (
              <CustomCutPage
                video={video}
                analysis={analysis}
                clips={customDraft}
                translations={t}
                mediaAvailable={Boolean(platformSupported && bootstrap?.components.media.available)}
                outputs={customOutputs}
                onOutputsChange={setCustomOutputs}
                onClipsChange={setCustomDraft}
                onToggleAll={(selected) => {
                  if (!selected) {
                    setCustomDraft((current) => current?.map((clip) => ({ ...clip, selected: false })) ?? null);
                    return;
                  }
                  setCustomDraft((current) => current?.reduce(
                    (next, clip) => setCustomClipSelected(
                      next,
                      clip.clipId,
                      true,
                      analysis.video.duration_seconds,
                      analysis.video.fps,
                    ),
                    current,
                  ) ?? null);
                }}
                onExport={(outputs) => void startCutting({ mode: 'custom', segments: customExportSegments(customDraft) }, outputs)}
              />
            )}

            {step === 'complete' && exportResult && exportResult.kind === 'custom-artifacts' && (
              <div className="workflow-page success-page">
                <div className="success-heading"><span>✓</span><div><p className="eyebrow">4 / 4</p><h1>{t.exportComplete}</h1></div></div>
                <div className="card output-details custom-artifact-details">
                  <div><span>{t.outputPath}</span><strong>{exportResult.outputDirectory}</strong></div>
                  <div><span>{t.exportRallyVideos}</span><strong>{interpolate(t.exportedRallyVideos, { count: exportResult.rallyVideos.length })}</strong></div>
                  <div><span>{t.exportPremiereXml}</span><strong>{exportResult.premiereXml ? t.exported : t.notExported}</strong></div>
                </div>
                {exportResult.partialSuccess && <div className="notice" role="status"><span>{t.partialExportNotice}</span></div>}
                {exportResult.premiereXml?.quantizedForVfr && <div className="notice" role="status"><span>{t.xmlVfrNotice}</span></div>}
                {exportResult.failedRallies.length > 0 && <div className="notice" role="status"><span>{interpolate(t.rallyExportFailures, { count: exportResult.failedRallies.length })} {interpolate(t.failedRallyDetails, { rallies: exportResult.failedRallies.map((failure) => failure.rallyIndex === undefined ? failure.rallyId ?? '?' : String(failure.rallyIndex)).join(', ') })}</span></div>}
                {exportResult.xmlFailure && <div className="notice" role="status"><span>{t.xmlExportFailed}</span></div>}
                <div className="footer-actions"><button className="secondary" onClick={() => void window.ttcut.openOutputDirectory(exportResult.outputDirectory)}>{t.openFolder}</button><button className="primary" onClick={reset}>{t.cutAnother}</button></div>
              </div>
            )}

            {step === 'complete' && exportResult && exportResult.kind !== 'custom-artifacts' && (
              <div className="workflow-page success-page">
                <div className="success-heading"><span>✓</span><div><p className="eyebrow">4 / 4</p><h1>{t.exportComplete}</h1></div></div>
                {Math.abs(exportResult.timing.driftSeconds) > 0.1 && (
                  <div className="notice" role="status"><span>{interpolate(t.exportTimingNotice, {
                    drift: `${exportResult.timing.driftSeconds >= 0 ? '+' : ''}${exportResult.timing.driftSeconds.toFixed(2)}`,
                    allowed: exportResult.timing.allowedDriftSeconds.toFixed(2),
                  })}</span></div>
                )}
                <video className="output-preview" src={exportResult.mediaUrl} controls preload="metadata" />
                <div className="card output-details"><div><span>{t.outputName}</span><strong>{exportResult.outputName}</strong></div><div><span>{t.outputPath}</span><strong>{exportResult.outputPath}</strong></div></div>
                <div className="footer-actions"><button className="secondary" onClick={() => void window.ttcut.revealOutput(exportResult.outputPath)}>{t.openFolder}</button><button className="primary" onClick={reset}>{t.cutAnother}</button></div>
                {exportResult.warning && (
                  <section className="export-warning" role="alert" aria-labelledby="export-warning-title">
                    <div className="export-warning-heading">
                      <span aria-hidden="true">!</span>
                      <div><strong id="export-warning-title">{t.exportWarningTitle}</strong><p>{t.exportWarningDetail}</p></div>
                      <button className="secondary" type="button" onClick={() => void window.ttcut.revealLogs()}>{t.logs}</button>
                    </div>
                    <div className="export-warning-summary"><code>{exportResult.warning.code}</code><span>{localizedError(exportResult.warning.code, t)}</span></div>
                    <details><summary>{t.technicalDetails}</summary><pre>{exportResult.warning.message}</pre></details>
                  </section>
                )}
              </div>
            )}

            {step === 'error' && error && (
              <div className="empty-state error-state">
                <span>!</span><h1>{t.errorTitle}</h1><p>{localizedError(error.code, t)}</p><code>{error.code}</code>
                {error.recoveredOutputPath && (
                  <div className="card output-details"><div><span>{t.recoveredOutput}</span><strong>{error.recoveredOutputPath}</strong></div></div>
                )}
                <small>{t.technicalLog}</small>
                <div className="error-actions">
                  <button className="secondary" onClick={() => void window.ttcut.revealLogs()}>{t.logs}</button>
                  {error.recoveredOutputPath && <button className="secondary" onClick={() => void window.ttcut.revealOutput(error.recoveredOutputPath!)}>{t.openRecoveredOutput}</button>}
                  <button className="primary" onClick={() => { setError(null); setStep(video && metadata ? 'calibrate' : 'select'); }}>{t.retry}</button>
                </div>
              </div>
            )}
          </section>
        ))}
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
      {supportPromptVisible && (
        <SupportPrompt
          copy={t}
          onSponsor={() => void window.ttcut.openExternalUrl(DONATION_URL)}
          onReject={() => setSupportPromptVisible(false)}
          onSnooze={() => {
            suppressSupportPromptForThirtyDays();
            setSupportPromptVisible(false);
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
      {languageTransition && <div className="language-loader"><span /></div>}
      {missingComponents && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label={t.componentCheckTitle}><h2>{t.componentCheckTitle}</h2><p>{interpolate(t.missingComponentsMessage, { components: missingComponents.join(settings.language === 'zh-CN' ? '、' : ', ') })}</p><div><button className="primary" onClick={() => setMissingComponents(null)}>{t.confirm}</button></div></div></div>}
      {historyConfirmation && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true"><h2>{historyConfirmation.kind === 'clear' ? t.clearHistoryTitle : t.deleteHistoryTitle}</h2><p>{historyConfirmation.kind === 'clear' ? t.clearHistoryConfirm : t.deleteHistoryConfirm}</p><div><button className="secondary" onClick={() => setHistoryConfirmation(null)}>{t.cancel}</button><button className="primary destructive-confirm" onClick={() => void confirmHistoryAction()}>{t.confirmDelete}</button></div></div></div>}
      {closeDialog && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true"><h2>{t.closeTitle}</h2><p>{t.closeDetail}</p><div><button className="secondary" onClick={() => { setCloseDialog(false); void window.ttcut.confirmClose('cancel'); }}>{t.cancel}</button><button className="secondary" onClick={() => { setCloseDialog(false); void window.ttcut.confirmClose('minimize'); }}>{t.minimize}</button><button className="primary" onClick={() => void window.ttcut.confirmClose('exit')}>{t.exit}</button></div></div></div>}
    </div>
  );
}
