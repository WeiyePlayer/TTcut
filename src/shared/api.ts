import type {
  AnalysisResultV1,
  AppSettings,
  BlurBallAnalysisMode,
  Calibration,
  CalibrationChoice,
  TableAnalysis,
  ComponentStatus,
  ComponentSetupInfo,
  CutSelectionV1,
  ExportResult,
  ExportTimingInfo,
  ExportRequest,
  HistorySummaryV1,
  PlatformCompatibility,
  TaskProgress,
  VideoMetadata,
  UpdateState,
} from './contracts';

export type { ExportTimingInfo } from './contracts';

export type SelectedVideo = {
  path: string;
  name: string;
  size: number;
  mediaUrl: string;
};

export type BootstrapData = {
  windowState?: { visible: boolean };
  capabilities?: { managedComponents: boolean; nativeWindow: boolean; shutdown: boolean; automaticUpdates: boolean };
  version: string;
  settings: AppSettings;
  components: ComponentStatus;
  componentSetup: ComponentSetupInfo;
  platformCompatibility: PlatformCompatibility;
  logsPath: string;
};

export type PendingComponentImport = {
  variant: 'cpu' | 'cu126' | 'cu132';
  receivedParts: number;
  totalParts: number;
  missingAssets: string[];
};

export type AppEvent =
  | { type: 'progress'; data: TaskProgress }
  | { type: 'analysis-result'; taskId: string; analysisId: string; calibration: Calibration; data: AnalysisResultV1 }
  | { type: 'calibration-result'; taskId: string; calibration: Calibration; tableAnalysis: TableAnalysis }
  | { type: 'export-result'; taskId: string; data: ExportResult }
  | {
    type: 'component-result';
    taskId: string;
    data: ComponentStatus;
    imported: Array<'analysis' | 'media'>;
    pendingImports: PendingComponentImport[];
  }
  | {
    type: 'error';
    taskId: string;
    code: string;
    message: string;
    logPath?: string;
    recoveredOutputPath?: string;
    timing?: ExportTimingInfo;
  };

export type HistoryOpenResultV1 = {
  analysisId: string;
  video: SelectedVideo;
  analysis: AnalysisResultV1;
  calibration: Calibration;
};

export interface TTcutApi {
  readonly platform?: string;
  preparePreview?(mediaUrl: string, taskId: string): Promise<string>;
  onPreviewProgress?(listener: (value: { taskId: string; percent: number }) => void): () => void;
  bootstrap(): Promise<BootstrapData>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  refreshComponents(): Promise<ComponentStatus>;
  importComponents(): Promise<string | null>;
  openComponentDownloads(): Promise<void>;
  openX264Download(): Promise<void>;
  installAnalysisComponent(consent: true): Promise<string>;
  installMediaComponent(consent: true): Promise<string>;
  selectVideo(): Promise<SelectedVideo | null>;
  selectVideos(): Promise<SelectedVideo[]>;
  pathForDroppedFile(file: File): string;
  acceptDroppedVideo(path: string): Promise<SelectedVideo>;
  probeVideo(path: string): Promise<VideoMetadata>;
  startAutoCalibration(input: {
    videoPath: string;
    device: 'auto' | 'cuda' | 'cpu';
  }): Promise<string>;
  startAnalysis(input: {
    videoPath: string;
    calibrationChoice: CalibrationChoice;
    device: 'auto' | 'cuda' | 'cpu';
    historyVisibility: 'visible' | 'deferred';
    analysisMode: BlurBallAnalysisMode;
    normalizeVariableFrameRate: boolean;
    blurballConfidenceThreshold: number;
    blurballStage1ConfidenceThreshold: number;
    blurballStage2ConfidenceThreshold: number;
  }): Promise<string>;
  startExport(input: ExportRequest): Promise<string>;
  listHistory(): Promise<HistorySummaryV1[]>;
  openHistory(id: string): Promise<HistoryOpenResultV1>;
  deleteHistory(id: string): Promise<void>;
  deleteAnalysis(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  onTaskEvent(listener: (event: AppEvent) => void): () => void;
  revealOutput(path: string): Promise<void>;
  openOutputDirectory(path: string): Promise<void>;
  revealLogs(): Promise<void>;
  openLicenses(): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  restartToUpdate(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  confirmClose(action: 'exit' | 'minimize' | 'cancel'): Promise<void>;
  shutdownSystem(): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
}
