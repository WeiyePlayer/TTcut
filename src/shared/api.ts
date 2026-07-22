import type {
  AnalysisResultV1,
  AppSettings,
  Calibration,
  ComponentStatus,
  ComponentSetupInfo,
  CutSelectionV1,
  ExportResult,
  HistorySummaryV1,
  PlatformCompatibility,
  TaskProgress,
  VideoMetadata,
} from './contracts';

export type SelectedVideo = {
  path: string;
  name: string;
  size: number;
  mediaUrl: string;
};

export type BootstrapData = {
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
  | { type: 'analysis-result'; taskId: string; data: AnalysisResultV1 }
  | { type: 'export-result'; taskId: string; data: ExportResult }
  | {
    type: 'component-result';
    taskId: string;
    data: ComponentStatus;
    imported: Array<'analysis' | 'media'>;
    pendingImports: PendingComponentImport[];
  }
  | { type: 'error'; taskId: string; code: string; message: string; logPath?: string };

export type HistoryOpenResultV1 = {
  video: SelectedVideo;
  analysis: AnalysisResultV1;
};

export interface TTcutApi {
  bootstrap(): Promise<BootstrapData>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  refreshComponents(): Promise<ComponentStatus>;
  importComponents(): Promise<string | null>;
  openComponentDownloads(): Promise<void>;
  installAnalysisComponent(consent: true): Promise<string>;
  installMediaComponent(consent: true): Promise<string>;
  selectVideo(): Promise<SelectedVideo | null>;
  pathForDroppedFile(file: File): string;
  acceptDroppedVideo(path: string): Promise<SelectedVideo>;
  probeVideo(path: string): Promise<VideoMetadata>;
  startAnalysis(input: { videoPath: string; calibration: Calibration; device: 'auto' | 'cuda' | 'cpu' }): Promise<string>;
  startExport(selection: CutSelectionV1): Promise<string>;
  listHistory(): Promise<HistorySummaryV1[]>;
  openHistory(id: string): Promise<HistoryOpenResultV1>;
  deleteHistory(id: string): Promise<void>;
  clearHistory(): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  onTaskEvent(listener: (event: AppEvent) => void): () => void;
  revealOutput(path: string): Promise<void>;
  revealLogs(): Promise<void>;
  openLicenses(): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  confirmClose(action: 'exit' | 'minimize' | 'cancel'): Promise<void>;
  onCloseRequested(listener: () => void): () => void;
}
