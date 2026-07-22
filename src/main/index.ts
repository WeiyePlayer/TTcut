import path from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  shell,
} from 'electron';
import { analysisResultSchema, appSettingsSchema, calibrationSchema, cutSelectionSchema, historySummarySchema } from '../shared/contracts';
import { IPC } from '../shared/ipc';
import { activateLatestAnalysis, startAnalysis, clearLatestAnalysis } from './analysis';
import { componentSetupInfo, loadComponentCatalog } from './component-catalog';
import { recoverComponentInstallState, startAnalysisComponentInstall, startComponentImport, startMediaComponentInstall } from './component-manager';
import { inspectComponents } from './components';
import { startExport } from './export';
import { getLogDirectory, logLine } from './logger';
import { getHistoryStore } from './history';
import { clearMediaPaths, installMediaProtocol, registerMediaPath } from './media-protocol';
import { probeVideo } from './probe';
import { cancelAllTasks, cancelTask, hasActiveTasks } from './processes';
import { loadSettings, saveSettings } from './settings';
import { handleSquirrelStartup } from './squirrel-startup';
import { assertPlatformCompatible, getPlatformCompatibility } from './platform-compatibility';
import { COMPONENT_ASSETS_RELEASE_URL } from '../shared/urls';

const squirrelStartup = handleSquirrelStartup();

if (!squirrelStartup) {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'ttcut-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

let mainWindow: BrowserWindow | null = null;
let exitApproved = false;

function e2eHarnessEnabled(): boolean {
  return !app.isPackaged && process.env.TTCUT_E2E === '1';
}

if (e2eHarnessEnabled() && process.env.TTCUT_E2E_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.TTCUT_E2E_USER_DATA));
}
if (e2eHarnessEnabled()) app.disableHardwareAcceleration();

function currentWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('WINDOW_UNAVAILABLE');
  return mainWindow;
}

async function selectedVideo(filePath: string) {
  if (path.extname(filePath).toLowerCase() !== '.mp4') throw new Error('INVALID_INPUT');
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('INVALID_INPUT');
  return {
    path: path.resolve(filePath),
    name: path.basename(filePath),
    size: info.size,
    mediaUrl: registerMediaPath(filePath),
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.appBootstrap, async () => {
    const [settings, components, setup, platformCompatibility] = await Promise.all([
      loadSettings(), inspectComponents(), componentSetupInfo(), getPlatformCompatibility(),
    ]);
    const downloadsAllowed = platformCompatibility.status === 'supported';
    return {
      version: app.getVersion(),
      settings,
      components,
      componentSetup: {
        analysis_offer: setup.analysis_offer
          ? { ...setup.analysis_offer, available_for_download: setup.analysis_offer.available_for_download && downloadsAllowed }
          : null,
        media_offer: setup.media_offer
          ? { ...setup.media_offer, available_for_download: setup.media_offer.available_for_download && downloadsAllowed }
          : null,
      },
      platformCompatibility,
      logsPath: getLogDirectory(),
    };
  });
  ipcMain.handle(IPC.settingsSave, (_event, value: unknown) => saveSettings(appSettingsSchema.parse(value)));
  ipcMain.handle(IPC.componentsRefresh, () => inspectComponents());
  ipcMain.handle(IPC.componentsOpenDownloads, async () => {
    const catalog = await loadComponentCatalog();
    await shell.openExternal(COMPONENT_ASSETS_RELEASE_URL);
    await shell.openExternal(catalog.ffmpeg.url);
  });
  ipcMain.handle(IPC.componentsImport, async () => {
    await assertPlatformCompatible();
    const catalog = await loadComponentCatalog();
    if (e2eHarnessEnabled() && process.env.TTCUT_E2E_COMPONENT_IMPORT_FILES) {
      const filePaths = JSON.parse(process.env.TTCUT_E2E_COMPONENT_IMPORT_FILES) as unknown;
      if (!Array.isArray(filePaths) || !filePaths.every((value): value is string => typeof value === 'string')) {
        throw new Error('TTCUT_E2E_COMPONENT_IMPORT_FILES must be a JSON string array.');
      }
      return startComponentImport(currentWindow(), filePaths);
    }
    const extensions = new Set(['pt', 'zip']);
    for (const asset of catalog.analysis_runtime.assets) {
      for (const part of asset.parts) {
        const extension = path.extname(part.asset).slice(1);
        if (extension) extensions.add(extension);
      }
    }
    const result = await dialog.showOpenDialog(currentWindow(), {
      title: 'Import TTcut components',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'TTcut component files', extensions: [...extensions] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return startComponentImport(currentWindow(), result.filePaths);
  });
  ipcMain.handle(IPC.componentsInstallAnalysis, async (_event, consent: unknown) => {
    await assertPlatformCompatible();
    return startAnalysisComponentInstall(currentWindow(), consent);
  });
  ipcMain.handle(IPC.componentsInstallMedia, async (_event, consent: unknown) => {
    await assertPlatformCompatible();
    return startMediaComponentInstall(currentWindow(), consent);
  });
  ipcMain.handle(IPC.videoSelect, async () => {
    if (e2eHarnessEnabled()) {
      const fixture = process.env.TTCUT_E2E_VIDEO;
      if (!fixture) throw new Error('TTCUT_E2E_VIDEO is required by the test harness.');
      return selectedVideo(fixture);
    }
    const result = await dialog.showOpenDialog(currentWindow(), {
      title: 'Select MP4 video', properties: ['openFile'],
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return result.canceled || !result.filePaths[0] ? null : selectedVideo(result.filePaths[0]);
  });
  ipcMain.handle(IPC.videoAcceptDrop, (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('INVALID_INPUT');
    return selectedVideo(value);
  });
  ipcMain.handle(IPC.videoProbe, (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('INVALID_INPUT');
    return probeVideo(value);
  });
  ipcMain.handle(IPC.analysisStart, async (_event, value: unknown) => {
    await assertPlatformCompatible();
    if (!value || typeof value !== 'object') throw new Error('INVALID_REQUEST');
    const record = value as Record<string, unknown>;
    if (typeof record.videoPath !== 'string') throw new Error('INVALID_REQUEST');
    const device = record.device;
    if (device !== 'auto' && device !== 'cuda' && device !== 'cpu') throw new Error('INVALID_REQUEST');
    return startAnalysis(currentWindow(), {
      videoPath: record.videoPath,
      calibration: calibrationSchema.parse(record.calibration),
      device,
    });
  });
  ipcMain.handle(IPC.exportStart, async (_event, value: unknown) => {
    await assertPlatformCompatible();
    return startExport(currentWindow(), cutSelectionSchema.parse(value));
  });
  ipcMain.handle(IPC.historyList, async () => {
    const entries = await getHistoryStore().list(!hasActiveTasks());
    return historySummarySchema.array().parse(entries.map(({ record, coverPath, sourceStatus }) => ({
      schema_version: 1,
      id: record.id,
      analyzed_at: record.analyzed_at,
      video_name: record.source.name,
      rally_count: record.analysis.rallies.length,
      duration_seconds: record.analysis.video.duration_seconds,
      cover_url: coverPath ? registerMediaPath(coverPath, 'image/jpeg') : null,
      source_status: sourceStatus,
    })));
  });
  ipcMain.handle(IPC.historyOpen, async (_event, id: unknown) => {
    if (hasActiveTasks()) throw new Error('TASK_BUSY');
    if (typeof id !== 'string') throw new Error('INVALID_REQUEST');
    const record = await getHistoryStore().open(id);
    const metadata = await probeVideo(record.source.path);
    const analysis = activateLatestAnalysis(analysisResultSchema.parse({ ...record.analysis, video: metadata }));
    return { video: await selectedVideo(record.source.path), analysis };
  });
  ipcMain.handle(IPC.historyDelete, async (_event, id: unknown) => {
    if (hasActiveTasks()) throw new Error('TASK_BUSY');
    if (typeof id !== 'string') throw new Error('INVALID_REQUEST');
    await getHistoryStore().delete(id);
  });
  ipcMain.handle(IPC.historyClear, async () => {
    if (hasActiveTasks()) throw new Error('TASK_BUSY');
    await getHistoryStore().clear();
  });
  ipcMain.handle(IPC.taskCancel, (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') throw new Error('INVALID_REQUEST');
    return cancelTask(taskId);
  });
  ipcMain.handle(IPC.outputReveal, async (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('INVALID_REQUEST');
    if (e2eHarnessEnabled() && process.env.TTCUT_E2E_REVEAL_MARKER) {
      await writeFile(process.env.TTCUT_E2E_REVEAL_MARKER, path.resolve(value), 'utf8');
      return;
    }
    shell.showItemInFolder(path.resolve(value));
  });
  ipcMain.handle(IPC.logsReveal, () => shell.openPath(getLogDirectory()));
  ipcMain.handle(IPC.licensesOpen, () => {
    const license = app.isPackaged
      ? path.join(process.resourcesPath, 'release-metadata', 'THIRD_PARTY_NOTICES.html')
      : path.join(app.getAppPath(), '.runtime', 'release-metadata', 'THIRD_PARTY_NOTICES.html');
    return shell.openPath(license);
  });
  ipcMain.handle(IPC.externalOpen, async (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('INVALID_REQUEST');
    const catalog = await loadComponentCatalog();
    const allowed = new Set([COMPONENT_ASSETS_RELEASE_URL, catalog.analysis_runtime.license_url, catalog.ffmpeg.license_url, catalog.ffmpeg.url]);
    if (!allowed.has(value)) throw new Error('EXTERNAL_URL_REJECTED');
    await shell.openExternal(value);
  });
  ipcMain.handle(IPC.windowMinimize, () => currentWindow().minimize());
  ipcMain.handle(IPC.windowToggleMaximize, () => {
    const window = currentWindow();
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(IPC.windowClose, () => currentWindow().close());
  ipcMain.handle(IPC.windowConfirmClose, async (_event, action: unknown) => {
    const window = currentWindow();
    if (action === 'cancel') return;
    if (action === 'minimize') {
      window.minimize();
      return;
    }
    if (action === 'exit') {
      exitApproved = true;
      await cancelAllTasks();
      window.close();
    }
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 840,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: '#FFFFFF',
    title: 'TTcut',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('close', (event) => {
    if (!exitApproved && hasActiveTasks()) {
      event.preventDefault();
      mainWindow?.webContents.send(IPC.windowCloseRequested);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}

if (!squirrelStartup) app.whenReady().then(async () => {
  const compatibility = await getPlatformCompatibility();
  await logLine('app', compatibility.status === 'supported' ? 'INFO' : 'WARN', `Platform compatibility: ${JSON.stringify(compatibility)}`)
    .catch(() => undefined);
  try {
    await recoverComponentInstallState();
  } catch (error) {
    await logLine('app', 'WARN', `Component recovery could not finish: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      .catch(() => undefined);
  }
  installMediaProtocol();
  registerIpc();
  await createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', async (event) => {
  if (!exitApproved && hasActiveTasks()) {
    event.preventDefault();
    exitApproved = true;
    await cancelAllTasks();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  clearLatestAnalysis();
  clearMediaPaths();
  if (process.platform !== 'darwin') app.quit();
});
