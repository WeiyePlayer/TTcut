import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { app, BrowserWindow, net } from 'electron';
import type { PendingComponentImport } from '../shared/api';
import { IPC } from '../shared/ipc';
import type { ComponentPaths } from './components';
import {
  inspectComponentPaths,
  inspectComponents,
  managedComponentsRoot,
  activateManagedAnalysisRuntime,
  resolveUsableAnalysisComponents,
  validateAnalysisRuntime,
  validateMediaComponent,
} from './components';
import { loadComponentCatalog } from './component-catalog';
import { getLogPath, logLine } from './logger';
import { beginExternalTask, endExternalTask, runProcess } from './processes';
import {
  ANALYSIS_RUNTIME_VARIANTS,
  analysisRuntimeDirectory,
  cudaVariantForComputeCapability,
  type AnalysisRuntimeVariant,
  type CudaRuntimeVariant,
} from './runtime-layout';
import { assembleAssetParts, sha256File } from './component-assets';
import { withDownloadRetries } from './component-download';
import {
  cacheAndCollectRuntimeImports,
  validateImportFiles,
  type ImportableComponentFile,
} from './component-import';

const INSTALLABLE_DIRECTORIES = new Set([
  ...ANALYSIS_RUNTIME_VARIANTS.map(analysisRuntimeDirectory),
  'models',
  'ffmpeg-8.1',
]);

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

async function validateAnalysisRuntimeLicenses(runtimeRoot: string): Promise<void> {
  const files = (await walkFiles(runtimeRoot)).map((file) => path.relative(runtimeRoot, file).replaceAll('\\', '/').toLowerCase());
  const requirements = [
    (file: string) => file === 'license.txt',
    (file: string) => /torch-[^/]+\.dist-info\/(?:licenses\/)?license/.test(file),
    (file: string) => /numpy-[^/]+\.dist-info\/licenses\/license/.test(file),
    (file: string) => /opencv_python-[^/]+\.dist-info\/license/.test(file),
  ];
  if (!requirements.every((requirement) => files.some(requirement))) throw new Error('ANALYSIS_RUNTIME_LICENSES_MISSING');
}

async function validateMediaLicense(mediaRoot: string): Promise<void> {
  const license = path.join(mediaRoot, 'LICENSE.txt');
  const metadata = await stat(license).catch(() => null);
  if (!metadata?.isFile() || metadata.size < 1_000) throw new Error('MEDIA_RUNTIME_LICENSE_MISSING');
}

function sendProgress(window: BrowserWindow, taskId: string, stage: string, percent: number, current?: number, total?: number): void {
  window.webContents.send(IPC.taskEvent, {
    type: 'progress',
    data: {
      taskId,
      kind: 'setup',
      stage,
      percent: Math.max(0, Math.min(99, percent)),
      ...(current === undefined ? {} : { current }),
      ...(total === undefined ? {} : { total }),
    },
  });
}

function setupErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'SETUP_CANCELLED';
  const message = error instanceof Error ? error.message : String(error);
  if (/^[A-Z][A-Z0-9_:-]+$/.test(message)) return message.split(':')[0] ?? 'COMPONENT_SETUP_FAILED';
  return 'COMPONENT_SETUP_FAILED';
}

async function getDownloadResponse(
  source: URL,
  offset: number,
  signal: AbortSignal,
): Promise<Response> {
  if (source.protocol !== 'https:') throw new Error('COMPONENT_DOWNLOAD_REDIRECT_REJECTED');
  return net.fetch(source.toString(), {
    method: 'GET',
    redirect: 'follow',
    credentials: 'omit',
    headers: {
      'User-Agent': `TTcut/${app.getVersion()}`,
      ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
    },
    signal,
    bypassCustomProtocolHandlers: true,
  });
}

async function downloadOnce(
  url: string,
  destination: string,
  expectedSize: number,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  let offset = await stat(destination).then((value) => value.size, () => 0);
  if (offset > expectedSize) {
    await rm(destination, { force: true });
    offset = 0;
  }
  if (offset === expectedSize) {
    onProgress(offset, expectedSize);
    return;
  }

  const response = await getDownloadResponse(new URL(url), offset, signal);
  const status = response.status;
  if (status !== 200 && status !== 206) {
    await response.body?.cancel();
    throw new Error(`COMPONENT_DOWNLOAD_HTTP_${status}`);
  }
  if (offset > 0 && status !== 206) offset = 0;
  if (status === 206) {
    const contentRange = response.headers.get('content-range');
    if (!contentRange?.startsWith(`bytes ${offset}-`)) {
      await response.body?.cancel();
      throw new Error('COMPONENT_DOWNLOAD_RANGE_MISMATCH');
    }
  }
  if (!response.body) throw new Error('COMPONENT_DOWNLOAD_SIZE_MISMATCH');

  let completed = offset;
  const tracker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      completed += chunk.length;
      onProgress(completed, expectedSize);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    tracker,
    createWriteStream(destination, { flags: offset > 0 ? 'a' : 'w' }),
    { signal },
  );
  if ((await stat(destination)).size !== expectedSize) throw new Error('COMPONENT_DOWNLOAD_SIZE_MISMATCH');
}

async function downloadWithCurlOnce(
  url: string,
  destination: string,
  expectedSize: number,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  let currentSize = await stat(destination).then((value) => value.size, () => 0);
  if (currentSize > expectedSize) {
    await rm(destination, { force: true });
    currentSize = 0;
  }
  if (currentSize === expectedSize) {
    onProgress(currentSize, expectedSize);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('curl.exe', [
      '--fail',
      '--location',
      '--max-redirs', '5',
      '--proto', '=https',
      '--proto-redir', '=https',
      '--connect-timeout', '20',
      '--retry', '5',
      '--retry-delay', '2',
      '--retry-max-time', '180',
      '--retry-all-errors',
      '--speed-limit', '1024',
      '--speed-time', '30',
      '--continue-at', '-',
      '--output', destination,
      '--silent',
      '--show-error',
      '--user-agent', `TTcut/${app.getVersion()}`,
      '--url', url,
    ], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let lastObservedSize = currentSize;
    let lastProgressAt = Date.now();
    let stalled = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    const terminate = () => terminateProcessTree(child);
    const poll = setInterval(() => {
      void stat(destination).then((value) => {
        const completed = Math.min(value.size, expectedSize);
        onProgress(completed, expectedSize);
        if (completed > lastObservedSize) {
          lastObservedSize = completed;
          lastProgressAt = Date.now();
        }
      }, () => undefined).finally(() => {
        if (!stalled && Date.now() - lastProgressAt >= 60_000) {
          stalled = true;
          terminate();
        }
      });
    }, 500);
    const abort = () => terminate();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      clearInterval(poll);
      signal.removeEventListener('abort', abort);
      reject(signal.aborted ? Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' }) : error);
    });
    child.once('close', (code) => {
      clearInterval(poll);
      signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          reject(Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' }));
          return;
        }
        if (stalled) {
          reject(new Error('COMPONENT_CURL_STALLED'));
          return;
        }
      if (code !== 0) {
        reject(new Error(`COMPONENT_CURL_EXIT_${code ?? -1}: ${stderr.trim()}`));
        return;
      }
      void stat(destination).then((value) => {
        onProgress(value.size, expectedSize);
        if (value.size !== expectedSize) reject(new Error('COMPONENT_DOWNLOAD_SIZE_MISMATCH'));
        else resolve();
      }, reject);
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  child.kill('SIGKILL');
  if (process.platform !== 'win32' || !child.pid) return;
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  killer.once('error', () => undefined);
}

async function downloadWithResume(
  url: string,
  destination: string,
  expectedSize: number,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
  onRetry: (error: unknown, failedAttempt: number, maxAttempts: number) => void | Promise<void>,
): Promise<void> {
  await withDownloadRetries(
    () => process.platform === 'win32'
      ? downloadWithCurlOnce(url, destination, expectedSize, signal, onProgress)
      : downloadOnce(url, destination, expectedSize, signal, onProgress),
    signal,
    { onRetry },
  );
}

async function commitComponentDirectories(stagingRoot: string, directories: string[], taskId: string): Promise<void> {
  const root = managedComponentsRoot();
  const backupRoot = path.join(root, '.backup', taskId);
  await mkdir(root, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const installed: string[] = [];
  const backedUp: string[] = [];
  try {
    for (const name of directories) {
      if (!INSTALLABLE_DIRECTORIES.has(name)) throw new Error('COMPONENT_INSTALL_TARGET_REJECTED');
      const parts = name.split('/');
      const source = path.join(stagingRoot, ...parts);
      if (!await exists(source)) throw new Error(`COMPONENT_INSTALL_SOURCE_MISSING:${name}`);
      const target = path.join(root, ...parts);
      const backup = path.join(backupRoot, ...parts);
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(path.dirname(backup), { recursive: true });
      if (await exists(target)) {
        await rename(target, backup);
        backedUp.push(name);
      }
      await rename(source, target);
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse()) await rm(path.join(root, ...name.split('/')), { recursive: true, force: true });
    for (const name of backedUp.reverse()) {
      const parts = name.split('/');
      const backup = path.join(backupRoot, ...parts);
      const target = path.join(root, ...parts);
      if (await exists(backup)) {
        await mkdir(path.dirname(target), { recursive: true });
        await rename(backup, target);
      }
    }
    throw error;
  }
  await rm(backupRoot, { recursive: true, force: true });
}

async function preferredCudaVariant(): Promise<CudaRuntimeVariant | null> {
  try {
    const result = await runProcess('nvidia-smi.exe', ['--query-gpu=compute_cap', '--format=csv,noheader'], { timeoutMs: 10_000 });
    const capability = Number.parseFloat(result.stdout.split(/\r?\n/)[0]?.trim() ?? '');
    if (!Number.isFinite(capability)) return null;
    return cudaVariantForComputeCapability(capability);
  } catch {
    return null;
  }
}

async function installOnlineTrackNetWeight(
  window: BrowserWindow,
  taskId: string,
  signal: AbortSignal,
  progressBase: number,
  progressSpan: number,
): Promise<void> {
  const catalog = await loadComponentCatalog();
  const asset = catalog.tracknet_weight;
  if (!asset.downloadable) throw new Error('TRACKNET_WEIGHT_DOWNLOAD_UNAVAILABLE');
  const root = managedComponentsRoot();
  const target = path.join(root, asset.install_directory, asset.filename);
  if (await exists(target) && await sha256File(target) === asset.sha256) {
    sendProgress(window, taskId, 'verify', progressBase + progressSpan);
    return;
  }

  const download = path.join(root, '.downloads', `${asset.filename}.download`);
  const staging = path.join(root, '.staging', taskId);
  sendProgress(window, taskId, 'download', progressBase, 0, asset.size_bytes);
  await downloadWithResume(
    asset.url,
    download,
    asset.size_bytes,
    signal,
    (current) => sendProgress(
      window,
      taskId,
      'download',
      progressBase + current / asset.size_bytes * progressSpan * 0.82,
      current,
      asset.size_bytes,
    ),
    (error, failedAttempt, maxAttempts) => logLine(
      taskId,
      'WARN',
      `TrackNet weight download attempt ${failedAttempt}/${maxAttempts} failed; preserving partial data and retrying: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  sendProgress(window, taskId, 'verify', progressBase + progressSpan * 0.86);
  if (await sha256File(download) !== asset.sha256) {
    await rm(download, { force: true });
    throw new Error('TRACKNET_WEIGHT_HASH_MISMATCH');
  }
  if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });

  await rm(staging, { recursive: true, force: true });
  const stagedDirectory = path.join(staging, asset.install_directory);
  await mkdir(stagedDirectory, { recursive: true });
  await copyFile(download, path.join(stagedDirectory, asset.filename));
  sendProgress(window, taskId, 'install', progressBase + progressSpan * 0.94);
  await commitComponentDirectories(staging, [asset.install_directory], taskId);
  await rm(staging, { recursive: true, force: true });
  const manifestRoot = path.join(root, '.manifests');
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(path.join(manifestRoot, `analysis-weight-${asset.sha256.slice(0, 12)}.json`), JSON.stringify({
    schema_version: 1,
    installed_at: new Date().toISOString(),
    weight: asset,
  }, null, 2), 'utf8');
}

async function installOnlineAnalysisRuntime(
  window: BrowserWindow,
  taskId: string,
  signal: AbortSignal,
  variant: AnalysisRuntimeVariant,
  progressBase: number,
  progressSpan: number,
): Promise<void> {
  const catalog = await loadComponentCatalog();
  const asset = catalog.analysis_runtime.assets.find((candidate) => candidate.variant === variant);
  if (!asset) throw new Error(`ANALYSIS_RUNTIME_ASSET_MISSING:${variant}`);
  const root = managedComponentsRoot();
  const downloadRoot = path.join(root, '.downloads');
  const download = path.join(downloadRoot, `${asset.asset}.assembled`);
  const staging = path.join(root, '.staging', taskId);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  sendProgress(window, taskId, 'download', progressBase, 0, asset.size_bytes);
  const downloadedParts: string[] = [];
  let completedParts = 0;
  for (const part of asset.parts) {
    const partDownload = path.join(downloadRoot, `${part.asset}.download`);
    await downloadWithResume(
      part.url,
      partDownload,
      part.size_bytes,
      signal,
      (current) => {
        const completed = completedParts + current;
        sendProgress(window, taskId, 'download', progressBase + completed / asset.size_bytes * progressSpan * 0.72, completed, asset.size_bytes);
      },
      (error, failedAttempt, maxAttempts) => logLine(taskId, 'WARN', `Download attempt ${failedAttempt}/${maxAttempts} failed; preserving partial data and retrying: ${error instanceof Error ? error.message : String(error)}`),
    );
    if (await sha256File(partDownload) !== part.sha256) {
      await rm(partDownload, { force: true });
      throw new Error('COMPONENT_DOWNLOAD_PART_HASH_MISMATCH');
    }
    completedParts += part.size_bytes;
    downloadedParts.push(partDownload);
  }
  sendProgress(window, taskId, 'verify', progressBase + progressSpan * 0.74);
  await assembleAssetParts(downloadedParts, download, asset.size_bytes);
  if (await sha256File(download) !== asset.sha256) {
    await rm(download, { force: true });
    throw new Error('COMPONENT_DOWNLOAD_HASH_MISMATCH');
  }
  if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
  sendProgress(window, taskId, 'extract', progressBase + progressSpan * 0.8);
  await runProcess('tar.exe', ['-xf', download, '-C', staging], { timeoutMs: 300_000 });
  const extracted = path.join(staging, asset.archive_root);
  const normalized = path.join(staging, ...asset.install_directory.split('/'));
  if (!await exists(extracted)) throw new Error('COMPONENT_ARCHIVE_LAYOUT_MISMATCH');
  await mkdir(path.dirname(normalized), { recursive: true });
  await rename(extracted, normalized);
  sendProgress(window, taskId, 'self_test', progressBase + progressSpan * 0.86);
  await validateAnalysisRuntimeLicenses(normalized);
  try {
    await validateAnalysisRuntime(path.join(normalized, 'python.exe'), variant);
  } catch (error) {
    if (variant !== 'cpu') throw new Error('CUDA_RUNTIME_SELF_TEST_FAILED', { cause: error });
    throw error;
  }
  if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
  sendProgress(window, taskId, 'install', progressBase + progressSpan * 0.94);
  await commitComponentDirectories(staging, [asset.install_directory], taskId);
  await activateManagedAnalysisRuntime(variant);
  const manifestRoot = path.join(root, '.manifests');
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(path.join(manifestRoot, `analysis-${asset.variant}-${asset.sha256.slice(0, 12)}.json`), JSON.stringify({
    schema_version: 1,
    installed_at: new Date().toISOString(),
    runtime: catalog.analysis_runtime,
    asset,
    weight: catalog.tracknet_weight,
  }, null, 2), 'utf8');
}

type SetupTaskResult = {
  imported: Array<'analysis' | 'media'>;
  pendingImports: PendingComponentImport[];
};

function runSetupTask(
  window: BrowserWindow,
  taskId: string,
  work: (signal: AbortSignal) => Promise<SetupTaskResult>,
): string {
  const controller = new AbortController();
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  beginExternalTask(taskId, async () => {
    controller.abort();
    await completion;
  });

  void work(controller.signal).then(async ({ imported, pendingImports }) => {
    const components = await inspectComponents();
    window.webContents.send(IPC.taskEvent, { type: 'component-result', taskId, data: components, imported, pendingImports });
  }).catch(async (error: unknown) => {
    const code = setupErrorCode(error);
    await logLine(taskId, 'ERROR', error instanceof Error ? `${error.stack ?? error.message}` : String(error));
    window.webContents.send(IPC.taskEvent, {
      type: 'error',
      taskId,
      code,
      message: code,
      logPath: getLogPath(taskId),
    });
  }).finally(() => {
    endExternalTask(taskId);
    complete();
  });
  return taskId;
}

export async function startAnalysisComponentInstall(window: BrowserWindow, consent: unknown): Promise<string> {
  if (consent !== true) throw new Error('COMPONENT_CONSENT_REQUIRED');
  const catalog = await loadComponentCatalog();
  if (process.platform !== 'win32') throw new Error('COMPONENT_PLATFORM_UNSUPPORTED');
  if (catalog.analysis_runtime.assets.length !== ANALYSIS_RUNTIME_VARIANTS.length) throw new Error('ANALYSIS_RUNTIME_CATALOG_INCOMPLETE');
  const taskId = randomUUID();
  return runSetupTask(window, taskId, async (signal) => {
    await installOnlineTrackNetWeight(window, taskId, signal, 0, 12);
    const existing = await resolveUsableAnalysisComponents('auto').catch(() => null);
    const existingVariant = existing?.runtimeVariant;
    if (existingVariant && ANALYSIS_RUNTIME_VARIANTS.includes(existingVariant as AnalysisRuntimeVariant)) {
      await activateManagedAnalysisRuntime(existingVariant as AnalysisRuntimeVariant);
      sendProgress(window, taskId, 'complete', 99);
      return { imported: ['analysis'], pendingImports: [] };
    }
    const cudaVariant = await preferredCudaVariant();
    if (cudaVariant) {
      try {
        await installOnlineAnalysisRuntime(window, taskId, signal, cudaVariant, 12, 54);
        sendProgress(window, taskId, 'complete', 99);
        return { imported: ['analysis'], pendingImports: [] };
      } catch (error) {
        if (signal.aborted || !['CUDA_RUNTIME_SELF_TEST_FAILED', 'CUDA_RUNTIME_UNSUPPORTED_ARCHITECTURE'].includes(setupErrorCode(error))) throw error;
        await logLine(taskId, 'WARN', `${cudaVariant} runtime installation/self-test failed; falling back to CPU: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await installOnlineAnalysisRuntime(window, taskId, signal, 'cpu', cudaVariant ? 66 : 12, cudaVariant ? 32 : 86);
    sendProgress(window, taskId, 'complete', 99);
    return { imported: ['analysis'], pendingImports: [] };
  });
}

export async function startMediaComponentInstall(window: BrowserWindow, consent: unknown): Promise<string> {
  if (consent !== true) throw new Error('COMPONENT_CONSENT_REQUIRED');
  const catalog = await loadComponentCatalog();
  if (process.platform !== 'win32') throw new Error('COMPONENT_PLATFORM_UNSUPPORTED');
  const taskId = randomUUID();
  return runSetupTask(window, taskId, async (signal) => {
    const root = managedComponentsRoot();
    const download = path.join(root, '.downloads', `${catalog.ffmpeg.asset}.part`);
    const staging = path.join(root, '.staging', taskId);
    try {
      sendProgress(window, taskId, 'download', 0, 0, catalog.ffmpeg.size_bytes);
      await downloadWithResume(
        catalog.ffmpeg.url,
        download,
        catalog.ffmpeg.size_bytes,
        signal,
        (current, total) => {
          sendProgress(window, taskId, 'download', current / total * 72, current, total);
        },
        (error, failedAttempt, maxAttempts) => logLine(taskId, 'WARN', `Download attempt ${failedAttempt}/${maxAttempts} failed; preserving partial data and retrying: ${error instanceof Error ? error.message : String(error)}`),
      );
      sendProgress(window, taskId, 'verify', 74);
      if (await sha256File(download) !== catalog.ffmpeg.sha256) {
        await rm(download, { force: true });
        throw new Error('COMPONENT_DOWNLOAD_HASH_MISMATCH');
      }
      if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
      await mkdir(staging, { recursive: true });
      sendProgress(window, taskId, 'extract', 80);
      await runProcess('tar.exe', ['-xf', download, '-C', staging], { timeoutMs: 120_000 });
      const extracted = path.join(staging, catalog.ffmpeg.archive_root);
      const normalized = path.join(staging, catalog.ffmpeg.install_directory);
      if (!await exists(extracted)) throw new Error('COMPONENT_ARCHIVE_LAYOUT_MISMATCH');
      await rename(extracted, normalized);
      sendProgress(window, taskId, 'self_test', 88);
      await validateMediaLicense(normalized);
      await validateMediaComponent(path.join(normalized, 'bin', 'ffmpeg.exe'), path.join(normalized, 'bin', 'ffprobe.exe'));
      if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
      sendProgress(window, taskId, 'install', 96);
      await commitComponentDirectories(staging, [catalog.ffmpeg.install_directory], taskId);
      const manifestRoot = path.join(root, '.manifests');
      await mkdir(manifestRoot, { recursive: true });
      await writeFile(path.join(manifestRoot, `media-${catalog.ffmpeg.release_tag}.json`), JSON.stringify({
        schema_version: 1,
        installed_at: new Date().toISOString(),
        ffmpeg: catalog.ffmpeg,
      }, null, 2), 'utf8');
      sendProgress(window, taskId, 'complete', 99);
      return { imported: ['media'], pendingImports: [] };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

async function prepareImportedRuntime(
  window: BrowserWindow,
  taskId: string,
  signal: AbortSignal,
  staging: string,
  files: Extract<ImportableComponentFile, { kind: 'runtime-part' }>[],
  progress: number,
): Promise<AnalysisRuntimeVariant> {
  const asset = files[0]!.asset;
  const assembled = path.join(staging, `${asset.asset}.assembled`);
  sendProgress(window, taskId, 'extract', progress);
  await assembleAssetParts(files.sort((left, right) => left.part.asset.localeCompare(right.part.asset)).map((file) => file.sourcePath), assembled, asset.size_bytes);
  if (await sha256File(assembled) !== asset.sha256) {
    await rm(assembled, { force: true });
    throw new Error('COMPONENT_IMPORT_ARCHIVE_HASH_MISMATCH');
  }
  if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
  await runProcess('tar.exe', ['-xf', assembled, '-C', staging], { timeoutMs: 300_000 });
  const extracted = path.join(staging, asset.archive_root);
  const normalized = path.join(staging, ...asset.install_directory.split('/'));
  if (!await exists(extracted)) throw new Error('COMPONENT_ARCHIVE_LAYOUT_MISMATCH');
  await mkdir(path.dirname(normalized), { recursive: true });
  await rename(extracted, normalized);
  sendProgress(window, taskId, 'self_test', progress + 4);
  await validateAnalysisRuntimeLicenses(normalized);
  await validateAnalysisRuntime(path.join(normalized, 'python.exe'), asset.variant);
  if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
  return asset.variant;
}

export async function startComponentImport(window: BrowserWindow, filePaths: string[]): Promise<string> {
  if (process.platform !== 'win32') throw new Error('COMPONENT_PLATFORM_UNSUPPORTED');
  const catalog = await loadComponentCatalog();
  const taskId = randomUUID();
  return runSetupTask(window, taskId, async (signal) => {
    const root = managedComponentsRoot();
    const staging = path.join(root, '.staging', taskId);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      sendProgress(window, taskId, 'verify', 0, 0, filePaths.length);
      const files = await validateImportFiles(filePaths, catalog, (completed, total) => {
        sendProgress(window, taskId, 'verify', completed / total * 35, completed, total);
      });
      if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });

      const runtimeImports = await cacheAndCollectRuntimeImports(
        files,
        catalog,
        path.join(root, '.downloads'),
        taskId,
      );
      const pendingImports = runtimeImports.flatMap((group) => group.pending ? [group.pending] : []);

      const directories: string[] = [];
      const installedVariants: AnalysisRuntimeVariant[] = [];
      const weight = files.find((file): file is Extract<ImportableComponentFile, { kind: 'weight' }> => file.kind === 'weight');
      if (weight) {
        const target = path.join(staging, weight.asset.install_directory, weight.asset.filename);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(weight.sourcePath, target);
        directories.push(weight.asset.install_directory);
      }

      const runtimeGroups = new Map<AnalysisRuntimeVariant, Extract<ImportableComponentFile, { kind: 'runtime-part' }>[] >(
        runtimeImports.filter((group) => group.pending === null).map((group) => [group.variant, group.files]),
      );
      for (const variant of ANALYSIS_RUNTIME_VARIANTS) {
        const group = runtimeGroups.get(variant);
        if (!group) continue;
        try {
          await prepareImportedRuntime(window, taskId, signal, staging, group, 45 + installedVariants.length * 18);
          directories.push(group[0]!.asset.install_directory);
          installedVariants.push(variant);
        } catch (error) {
          if (variant === 'cpu' || !['CUDA_RUNTIME_SELF_TEST_FAILED', 'CUDA_RUNTIME_UNSUPPORTED_ARCHITECTURE'].includes(setupErrorCode(error)) || !runtimeGroups.has('cpu')) throw error;
          await rm(path.join(staging, ...group[0]!.asset.install_directory.split('/')), { recursive: true, force: true });
          await logLine(taskId, 'WARN', `Imported CUDA runtime failed self-test; using imported CPU runtime: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const media = files.find((file): file is Extract<ImportableComponentFile, { kind: 'media' }> => file.kind === 'media');
      if (media) {
        sendProgress(window, taskId, 'extract', 80);
        await runProcess('tar.exe', ['-xf', media.sourcePath, '-C', staging], { timeoutMs: 120_000 });
        const extracted = path.join(staging, media.asset.archive_root);
        const normalized = path.join(staging, media.asset.install_directory);
        if (!await exists(extracted)) throw new Error('COMPONENT_ARCHIVE_LAYOUT_MISMATCH');
        await rename(extracted, normalized);
        sendProgress(window, taskId, 'self_test', 86);
        await validateMediaLicense(normalized);
        await validateMediaComponent(path.join(normalized, 'bin', 'ffmpeg.exe'), path.join(normalized, 'bin', 'ffprobe.exe'));
        directories.push(media.asset.install_directory);
      }

      if (directories.length === 0 && pendingImports.length === 0) throw new Error('COMPONENT_IMPORT_NO_FILES');
      if (signal.aborted) throw Object.assign(new Error('SETUP_CANCELLED'), { name: 'AbortError' });
      if (directories.length > 0) {
        sendProgress(window, taskId, 'install', 94);
        await commitComponentDirectories(staging, [...new Set(directories)], taskId);
      }

      const manifestRoot = path.join(root, '.manifests');
      await mkdir(manifestRoot, { recursive: true });
      if (weight) {
        await writeFile(path.join(manifestRoot, `analysis-weight-${weight.asset.sha256.slice(0, 12)}.json`), JSON.stringify({
          schema_version: 1,
          installed_at: new Date().toISOString(),
          weight: weight.asset,
        }, null, 2), 'utf8');
      }
      for (const variant of installedVariants) {
        const asset = runtimeGroups.get(variant)![0]!.asset;
        await activateManagedAnalysisRuntime(variant);
        await writeFile(path.join(manifestRoot, `analysis-${asset.variant}-${asset.sha256.slice(0, 12)}.json`), JSON.stringify({
          schema_version: 1,
          installed_at: new Date().toISOString(),
          runtime: catalog.analysis_runtime,
          asset,
          weight: catalog.tracknet_weight,
        }, null, 2), 'utf8');
      }
      if (media) {
        await writeFile(path.join(manifestRoot, `media-${media.asset.release_tag}.json`), JSON.stringify({
          schema_version: 1,
          installed_at: new Date().toISOString(),
          ffmpeg: media.asset,
        }, null, 2), 'utf8');
      }
      sendProgress(window, taskId, 'complete', 99);
      return {
        imported: [
          ...(weight || installedVariants.length ? ['analysis' as const] : []),
          ...(media ? ['media' as const] : []),
        ],
        pendingImports,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export async function recoverComponentInstallState(): Promise<void> {
  const root = managedComponentsRoot();
  const backupBase = path.join(root, '.backup');
  if (await exists(backupBase)) {
    const tasks = await readdir(backupBase, { withFileTypes: true });
    for (const task of tasks) {
      if (!task.isDirectory() || !/^[0-9a-f-]{36}$/i.test(task.name)) continue;
      const backupRoot = path.join(backupBase, task.name);
      for (const name of INSTALLABLE_DIRECTORIES) {
        const parts = name.split('/');
        const backup = path.join(backupRoot, ...parts);
        if (!await exists(backup)) continue;
        const target = path.join(root, ...parts);
        if (!await exists(target)) {
          await mkdir(path.dirname(target), { recursive: true });
          await rename(backup, target);
        }
        else await rm(backup, { recursive: true, force: true });
      }
      await rm(backupRoot, { recursive: true, force: true });
    }
  }
  await rm(path.join(root, '.staging'), { recursive: true, force: true });
}

export async function inspectManagedStagingForTests(paths: ComponentPaths) {
  return inspectComponentPaths(paths);
}
