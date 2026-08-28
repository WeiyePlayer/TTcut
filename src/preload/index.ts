import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TTcutApi, AppEvent } from '../shared/api';
import type { AppSettings, BlurBallAnalysisMode, CalibrationChoice, ExportRequest, RallyRecognitionMethod } from '../shared/contracts';
import { IPC } from '../shared/ipc';

const api: TTcutApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.appBootstrap),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  refreshComponents: () => ipcRenderer.invoke(IPC.componentsRefresh),
  importComponents: () => ipcRenderer.invoke(IPC.componentsImport),
  openComponentDownloads: () => ipcRenderer.invoke(IPC.componentsOpenDownloads),
  openX264Download: () => ipcRenderer.invoke(IPC.componentsOpenX264Download),
  installAnalysisComponent: (consent: true) => ipcRenderer.invoke(IPC.componentsInstallAnalysis, consent),
  installMediaComponent: (consent: true) => ipcRenderer.invoke(IPC.componentsInstallMedia, consent),
  selectVideo: () => ipcRenderer.invoke(IPC.videoSelect),
  selectVideos: () => ipcRenderer.invoke(IPC.videosSelect),
  pathForDroppedFile: (file: File) => webUtils.getPathForFile(file),
  acceptDroppedVideo: (path: string) => ipcRenderer.invoke(IPC.videoAcceptDrop, path),
  probeVideo: (path: string) => ipcRenderer.invoke(IPC.videoProbe, path),
  startAutoCalibration: (input: { videoPath: string; device: 'auto' | 'cuda' | 'cpu' }) => (
    ipcRenderer.invoke(IPC.calibrationStart, input)
  ),
  startAnalysis: (input: { videoPath: string; calibrationChoice: CalibrationChoice; device: 'auto' | 'cuda' | 'cpu'; historyVisibility: 'visible' | 'deferred'; analysisMode: BlurBallAnalysisMode; rallyRecognitionMethod: RallyRecognitionMethod; blurballConfidenceThreshold: number; blurballStage1ConfidenceThreshold: number; blurballStage2ConfidenceThreshold: number }) => (
    ipcRenderer.invoke(IPC.analysisStart, input)
  ),
  startExport: (input: ExportRequest) => ipcRenderer.invoke(IPC.exportStart, input),
  listHistory: () => ipcRenderer.invoke(IPC.historyList),
  openHistory: (id: string) => ipcRenderer.invoke(IPC.historyOpen, id),
  deleteHistory: (id: string) => ipcRenderer.invoke(IPC.historyDelete, id),
  deleteAnalysis: (id: string) => ipcRenderer.invoke(IPC.analysisDelete, id),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  cancelTask: (taskId: string) => ipcRenderer.invoke(IPC.taskCancel, taskId),
  onTaskEvent: (listener: (event: AppEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value);
    ipcRenderer.on(IPC.taskEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC.taskEvent, wrapped);
  },
  revealOutput: (path: string) => ipcRenderer.invoke(IPC.outputReveal, path),
  openOutputDirectory: (path: string) => ipcRenderer.invoke(IPC.outputDirectoryOpen, path),
  revealLogs: () => ipcRenderer.invoke(IPC.logsReveal),
  openLicenses: () => ipcRenderer.invoke(IPC.licensesOpen),
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC.externalOpen, url),
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGetState),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  restartToUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on(IPC.updateState, wrapped);
    return () => ipcRenderer.removeListener(IPC.updateState, wrapped);
  },
  minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  close: () => ipcRenderer.invoke(IPC.windowClose),
  confirmClose: (action: 'exit' | 'minimize' | 'cancel') => ipcRenderer.invoke(IPC.windowConfirmClose, action),
  shutdownSystem: () => ipcRenderer.invoke(IPC.systemShutdown),
  onCloseRequested: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on(IPC.windowCloseRequested, wrapped);
    return () => ipcRenderer.removeListener(IPC.windowCloseRequested, wrapped);
  },
};

contextBridge.exposeInMainWorld('ttcut', api);
