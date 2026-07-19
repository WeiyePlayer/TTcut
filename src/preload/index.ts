import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TTcutApi, AppEvent } from '../shared/api';
import type { AppSettings, Calibration, CutSelectionV1 } from '../shared/contracts';
import { IPC } from '../shared/ipc';

const api: TTcutApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.appBootstrap),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  refreshComponents: () => ipcRenderer.invoke(IPC.componentsRefresh),
  installAnalysisComponent: (consent: true) => ipcRenderer.invoke(IPC.componentsInstallAnalysis, consent),
  installMediaComponent: (consent: true) => ipcRenderer.invoke(IPC.componentsInstallMedia, consent),
  selectVideo: () => ipcRenderer.invoke(IPC.videoSelect),
  pathForDroppedFile: (file: File) => webUtils.getPathForFile(file),
  acceptDroppedVideo: (path: string) => ipcRenderer.invoke(IPC.videoAcceptDrop, path),
  probeVideo: (path: string) => ipcRenderer.invoke(IPC.videoProbe, path),
  startAnalysis: (input: { videoPath: string; calibration: Calibration; device: 'auto' | 'cuda' | 'cpu' }) => (
    ipcRenderer.invoke(IPC.analysisStart, input)
  ),
  startExport: (selection: CutSelectionV1) => ipcRenderer.invoke(IPC.exportStart, selection),
  listHistory: () => ipcRenderer.invoke(IPC.historyList),
  openHistory: (id: string) => ipcRenderer.invoke(IPC.historyOpen, id),
  deleteHistory: (id: string) => ipcRenderer.invoke(IPC.historyDelete, id),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  cancelTask: (taskId: string) => ipcRenderer.invoke(IPC.taskCancel, taskId),
  onTaskEvent: (listener: (event: AppEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value);
    ipcRenderer.on(IPC.taskEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC.taskEvent, wrapped);
  },
  revealOutput: (path: string) => ipcRenderer.invoke(IPC.outputReveal, path),
  revealLogs: () => ipcRenderer.invoke(IPC.logsReveal),
  openLicenses: () => ipcRenderer.invoke(IPC.licensesOpen),
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC.externalOpen, url),
  minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  close: () => ipcRenderer.invoke(IPC.windowClose),
  confirmClose: (action: 'exit' | 'minimize' | 'cancel') => ipcRenderer.invoke(IPC.windowConfirmClose, action),
  onCloseRequested: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on(IPC.windowCloseRequested, wrapped);
    return () => ipcRenderer.removeListener(IPC.windowCloseRequested, wrapped);
  },
};

contextBridge.exposeInMainWorld('ttcut', api);
