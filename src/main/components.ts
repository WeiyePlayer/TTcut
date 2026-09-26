import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import type { ComponentStatus } from '../shared/contracts';
import { ProcessExecutionError, runProcess, type ProcessResult } from './processes';
import { inspectMacComponents, macMediaComponents } from './macos/runtime';
import { resolveInstallationLayout } from './installation-layout';
import { logLine } from './logger';

const PYTHON_VERSION = '3.12.13';
const NUMPY_VERSION = '2.5.1';
const OPENCV_VERSION = '4.13.0';
const ONNXRUNTIME_VERSION = '1.24.3';

export type AnalysisRuntimeDiagnostics = {
  pythonExecutable: string;
  onnxRuntimeVersion: string | null;
  providers: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export class AnalysisRuntimeValidationError extends Error {
  readonly diagnostics: AnalysisRuntimeDiagnostics;
  constructor(code: string, diagnostics: AnalysisRuntimeDiagnostics, options?: ErrorOptions) {
    super(code, options);
    this.name = 'AnalysisRuntimeValidationError';
    this.diagnostics = diagnostics;
  }
}

export type RuntimeLocation = 'bundled' | 'external';
export type MediaEncoder = 'libopenh264' | 'libx264';
export type ComponentPaths = {
  python: string | null;
  runtimeVariant: RuntimeLocation | null;
  worker: string;
  blurballWeights: string;
  tracknetWeights: string | null;
  tableAnalyzeWeights: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  mediaEncoder: MediaEncoder | 'unavailable';
};

async function exists(value: string): Promise<boolean> {
  try { await access(value); return true; } catch { return false; }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function validateBundledModels(paths: ComponentPaths): Promise<void> {
  const manifestPath = appResource('resources', 'model-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    schema_version?: number;
    opset?: number;
    models?: Array<{ filename?: string; size_bytes?: number; sha256?: string }>;
  };
  const expected = new Map([
    ['blurball_best.onnx', paths.blurballWeights],
    ['table_analyze.onnx', paths.tableAnalyzeWeights],
  ]);
  if (manifest.schema_version !== 2 || manifest.opset !== 20 || manifest.models?.length !== expected.size) {
    throw new Error('MODEL_MANIFEST_INVALID');
  }
  for (const model of manifest.models) {
    const file = model.filename ? expected.get(model.filename) : undefined;
    if (!file || typeof model.size_bytes !== 'number' || !/^[a-f0-9]{64}$/.test(model.sha256 ?? '')) {
      throw new Error('MODEL_MANIFEST_INVALID');
    }
    const fileStat = await stat(file);
    if (fileStat.size !== model.size_bytes || await sha256(file) !== model.sha256) throw new Error('MODEL_HASH_MISMATCH');
    expected.delete(model.filename!);
  }
  if (expected.size) throw new Error('MODEL_MANIFEST_INVALID');
}

function appResource(...parts: string[]): string {
  return path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), ...parts);
}

function windowsRuntime(...parts: string[]): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'windows', ...parts)
    : path.join(app.getAppPath(), '.runtime', 'windows', ...parts);
}

export function managedComponentsRoot(): string {
  if (process.platform === 'darwin') return path.join(app.getPath('userData'), 'data', 'components');
  try { return resolveInstallationLayout().componentRoot; } catch { return path.join(app.getPath('userData'), 'legacy-components'); }
}

async function localTrackNetWeight(): Promise<string | null> {
  if (app.isPackaged || process.env.TTCUT_ENABLE_LOCAL_TRACKNET !== '1') return null;
  const configured = process.env.TTCUT_TRACKNET_WEIGHTS?.trim();
  return configured && await exists(path.resolve(configured)) ? path.resolve(configured) : null;
}

export async function resolveComponents(
  _device: 'auto' | 'directml' | 'cuda' | 'cpu' = 'auto',
): Promise<ComponentPaths> {
  const tracknetWeights = await localTrackNetWeight();
  const externalPython = !app.isPackaged && tracknetWeights ? process.env.TTCUT_PYTHON?.trim() : null;
  const externalFfmpeg = !app.isPackaged ? process.env.TTCUT_FFMPEG?.trim() : null;
  const externalFfprobe = !app.isPackaged ? process.env.TTCUT_FFPROBE?.trim() : null;
  return {
    python: externalPython || windowsRuntime('python', 'python.exe'),
    runtimeVariant: externalPython ? 'external' : 'bundled',
    worker: appResource('worker'),
    blurballWeights: process.env.TTCUT_BLURBALL_WEIGHTS || appResource('resources', 'models', 'blurball_best.onnx'),
    tracknetWeights,
    tableAnalyzeWeights: process.env.TTCUT_TABLE_ANALYZE_WEIGHTS || appResource('resources', 'models', 'table_analyze.onnx'),
    ffmpeg: externalFfmpeg || windowsRuntime('ffmpeg', 'ffmpeg.exe'),
    ffprobe: externalFfprobe || windowsRuntime('ffmpeg', 'ffprobe.exe'),
    mediaEncoder: 'libx264',
  };
}

function parseRuntimeOutput(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error('ANALYSIS_RUNTIME_EMPTY_OUTPUT');
  return JSON.parse(line) as Record<string, unknown>;
}

function diagnostics(python: string, result: ProcessResult, value: Record<string, unknown> = {}): AnalysisRuntimeDiagnostics {
  return {
    pythonExecutable: typeof value.python_executable === 'string' ? value.python_executable : python,
    onnxRuntimeVersion: typeof value.onnxruntime === 'string' ? value.onnxruntime : null,
    providers: Array.isArray(value.providers) ? value.providers.filter((item): item is string => typeof item === 'string') : [],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
  };
}

export function analysisRuntimeDiagnostics(error: unknown): AnalysisRuntimeDiagnostics | null {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AnalysisRuntimeValidationError) return current.diagnostics;
    current = current.cause;
  }
  return null;
}

export function formatAnalysisRuntimeDiagnostics(error: unknown): string | null {
  const value = analysisRuntimeDiagnostics(error);
  if (!value) return null;
  return [
    `python.exe path=${JSON.stringify(value.pythonExecutable)}`,
    `onnxruntime=${JSON.stringify(value.onnxRuntimeVersion)}`,
    `providers=${JSON.stringify(value.providers)}`,
    `exit code=${JSON.stringify(value.exitCode)}`,
    `stdout=${JSON.stringify(value.stdout.slice(0, 7000))}`,
    `stderr=${JSON.stringify(value.stderr.slice(0, 7000))}`,
  ].join('; ');
}

export async function validateAnalysisRuntime(
  python: string,
  _expectedVariant?: unknown,
): Promise<{ version: string; pythonVersion: string; onnxRuntimeVersion: string; acceleration: 'directml' | 'cpu'; variant: 'bundled' }> {
  let result: ProcessResult;
  try {
    result = await runProcess(python, ['-c', [
      'import json,sys,cv2,numpy,onnxruntime as ort',
      'print(json.dumps({"python_executable":sys.executable,"python":sys.version.split()[0],"opencv":cv2.__version__,"numpy":numpy.__version__,"onnxruntime":ort.__version__,"providers":ort.get_available_providers()}))',
    ].join('\n')], { timeoutMs: 30_000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  } catch (error) {
    const raw = error instanceof ProcessExecutionError
      ? { code: error.exitCode ?? -1, stdout: error.stdout, stderr: error.stderr }
      : { code: -1, stdout: '', stderr: String(error) };
    throw new AnalysisRuntimeValidationError('ANALYSIS_RUNTIME_SELF_TEST_FAILED', diagnostics(python, raw), { cause: error });
  }
  let value: Record<string, unknown>;
  try { value = parseRuntimeOutput(result.stdout); } catch (error) {
    throw new AnalysisRuntimeValidationError('ANALYSIS_RUNTIME_SELF_TEST_FAILED', diagnostics(python, result), { cause: error });
  }
  const providers = Array.isArray(value.providers) ? value.providers : [];
  if (value.python !== PYTHON_VERSION || value.numpy !== NUMPY_VERSION || value.opencv !== OPENCV_VERSION
      || value.onnxruntime !== ONNXRUNTIME_VERSION || !providers.includes('CPUExecutionProvider')) {
    throw new AnalysisRuntimeValidationError('ANALYSIS_RUNTIME_VERSION_MISMATCH', diagnostics(python, result, value));
  }
  const acceleration = providers.includes('DmlExecutionProvider') ? 'directml' : 'cpu';
  return {
    version: `Python ${value.python} / ONNX Runtime ${value.onnxruntime}`,
    pythonVersion: String(value.python),
    onnxRuntimeVersion: String(value.onnxruntime),
    acceleration,
    variant: 'bundled',
  };
}

export async function validateAnalysisComponent(python: string, expected?: unknown) {
  return validateAnalysisRuntime(python, expected);
}

export async function activateManagedAnalysisRuntime(_variant: unknown): Promise<void> {
  // Compatibility no-op for old migration helpers. Production uses the immutable bundled runtime.
}

export async function resolveUsableAnalysisComponents(
  device: 'auto' | 'directml' | 'cuda' | 'cpu',
  _activateRuntime = true,
): Promise<ComponentPaths> {
  const paths = await resolveComponents(device);
  if (!paths.python || !await exists(paths.python)) throw new Error('RUNTIME_MISSING');
  if (paths.runtimeVariant === 'external' && paths.tracknetWeights) return paths;
  const runtime = await validateAnalysisRuntime(paths.python);
  if (device === 'directml' && runtime.acceleration !== 'directml') throw new Error('DEVICE_UNAVAILABLE');
  return paths;
}

export async function validateMediaComponent(
  ffmpeg: string,
  ffprobe: string,
  encoder: MediaEncoder = 'libx264',
): Promise<{ version: string; encoder: MediaEncoder }> {
  const [version, probeVersion, build, encoders] = await Promise.all([
    runProcess(ffmpeg, ['-version'], { timeoutMs: 10_000 }),
    runProcess(ffprobe, ['-version'], { timeoutMs: 10_000 }),
    runProcess(ffmpeg, ['-buildconf'], { timeoutMs: 10_000 }),
    runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }),
  ]);
  const requiredEncoder = encoder === 'libx264' ? 'libx264' : 'libopenh264';
  if (!/ffmpeg version/i.test(version.stdout) || !/ffprobe version/i.test(probeVersion.stdout)
      || !new RegExp(`\\b${requiredEncoder}\\b`).test(encoders.stdout)) {
    throw new Error('MEDIA_RUNTIME_INVALID');
  }
  return { version: version.stdout.split(/\r?\n/)[0]?.replace(/^ffmpeg version\s+/, '') ?? 'unknown', encoder };
}

export async function validateX264EightKCapability(ffmpeg: string): Promise<void> {
  try {
    await runProcess(ffmpeg, [
      '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=7680x4320:r=1:d=1',
      '-frames:v', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ], { timeoutMs: 60_000 });
  } catch (error) { throw new Error('X264_8K_SELF_TEST_FAILED', { cause: error }); }
}

export async function resolveUsableMediaComponents(): Promise<Pick<ComponentPaths, 'ffmpeg' | 'ffprobe' | 'mediaEncoder'>> {
  if (process.platform === 'darwin') return macMediaComponents();
  const paths = await resolveComponents();
  if (!paths.ffmpeg || !paths.ffprobe || !await exists(paths.ffmpeg) || !await exists(paths.ffprobe)) {
    throw new Error('MEDIA_COMPONENT_MISSING');
  }
  await validateMediaComponent(paths.ffmpeg, paths.ffprobe);
  return { ffmpeg: paths.ffmpeg, ffprobe: paths.ffprobe, mediaEncoder: 'libx264' };
}

export async function inspectComponentPaths(paths: ComponentPaths): Promise<ComponentStatus> {
  const recordFailure = async (stage: string, error: unknown) => {
    const runtime = formatAnalysisRuntimeDiagnostics(error);
    const processResult = error instanceof ProcessExecutionError ? {
      stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode,
    } : undefined;
    await logLine('app', 'ERROR', `Component check failed (${stage}): ${JSON.stringify({
      paths, error: error instanceof Error ? error.stack ?? error.message : String(error), processResult,
    })}; ${runtime ?? ''}`).catch(() => undefined);
  };
  let analysisVersion: string | null = null;
  let acceleration: 'directml' | 'cpu' | 'unavailable' = 'unavailable';
  let analysisDetail: string | null = null;
  let modelsAvailable = false;
  let modelDetail: string | null = null;
  try { await validateBundledModels(paths); modelsAvailable = true; }
  catch (error) {
    modelDetail = error instanceof Error ? error.message : String(error);
    await recordFailure('models', error);
  }
  if (paths.python && modelsAvailable) {
    try {
      const result = await validateAnalysisRuntime(paths.python);
      analysisVersion = `${result.version} (bundled)`;
      acceleration = result.acceleration;
    } catch (error) {
      analysisDetail = error instanceof Error ? error.message : String(error);
      await recordFailure('analysis runtime', error);
    }
  } else { analysisDetail = !paths.python ? 'ANALYSIS_RUNTIME_MISSING' : modelDetail ?? 'MODEL_RESOURCE_MISSING'; }

  let mediaVersion: string | null = null;
  let mediaDetail: string | null = null;
  if (paths.ffmpeg && paths.ffprobe) {
    try {
      mediaVersion = (await validateMediaComponent(paths.ffmpeg, paths.ffprobe)).version;
      await validateX264EightKCapability(paths.ffmpeg);
    }
    catch (error) {
      mediaDetail = error instanceof Error ? error.message : String(error);
      await recordFailure('media runtime', error);
    }
  } else { mediaDetail = 'MEDIA_RUNTIME_MISSING'; }
  return {
    analysis: {
      available: Boolean(paths.python && modelsAvailable && !analysisDetail),
      version: analysisVersion, path: paths.python, acceleration, detail: analysisDetail,
    },
    media: {
      available: Boolean(paths.ffmpeg && paths.ffprobe && !mediaDetail),
      version: mediaVersion, path: paths.ffmpeg,
      active_encoder: mediaDetail ? 'unavailable' : 'libx264',
      x264_available: !mediaDetail, detail: mediaDetail,
    },
  };
}

export async function inspectComponents(): Promise<ComponentStatus> {
  if (process.platform === 'darwin') return inspectMacComponents();
  return inspectComponentPaths(await resolveComponents());
}
