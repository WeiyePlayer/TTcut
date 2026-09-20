import type {
  AnalysisResultV1,
  BatchExportRequest,
  BatchExportResult,
  AppSettings,
  Calibration,
  CalibrationChoice,
  TableAnalysis,
  ComponentStatus,
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
  platformCompatibility: PlatformCompatibility;
  logsPath: string;
};

export type AppEvent =
  | { type: 'progress'; data: TaskProgress }
  | { type: 'analysis-result'; taskId: string; analysisId: string; calibration: Calibration; data: AnalysisResultV1 }
  | { type: 'calibration-result'; taskId: string; calibration: Calibration; tableAnalysis: TableAnalysis }
  | { type: 'export-result'; taskId: string; data: ExportResult }
  | { type: 'batch-export-result'; taskId: string; data: BatchExportResult }
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
  selectVideo(): Promise<SelectedVideo | null>;
  selectVideos(): Promise<SelectedVideo[]>;
  pathForDroppedFile(file: File): string;
  acceptDroppedVideo(path: string): Promise<SelectedVideo>;
  probeVideo(path: string): Promise<VideoMetadata>;
  prepareVideoPreview(mediaUrl: string): Promise<string>;
  startAutoCalibration(input: {
    videoPath: string;
    device: 'auto' | 'directml' | 'cuda' | 'cpu';
  }): Promise<string>;
  startAnalysis(input: {
    videoPath: string;
    calibrationChoice: CalibrationChoice;
    device: 'auto' | 'directml' | 'cuda' | 'cpu';
    historyVisibility: 'visible' | 'deferred';
    normalizeVariableFrameRate: boolean;
  }): Promise<string>;
  startExport(input: ExportRequest): Promise<string>;
  startBatchExport(input: BatchExportRequest): Promise<string>;
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
  downloadUpdate(version: string): Promise<UpdateState>;
  skipUpdate(version: string): Promise<UpdateState>;
  restartToUpdate(): Promise<void>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  confirmClose(action: 'exit' | 'minimize' | 'cancel'): Promise<void>;
  shutdownSystem(): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
}
