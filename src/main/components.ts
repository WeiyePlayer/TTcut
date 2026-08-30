import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { ComponentStatus } from '../shared/contracts';
import { loadComponentCatalog } from './component-catalog';
import { ProcessExecutionError, runProcess, type ProcessResult } from './processes';
import {
  ACTIVE_RUNTIME_MANIFEST,
  ANALYSIS_PYTHON_VERSION,
  ANALYSIS_RUNTIME_ID,
  ANALYSIS_RUNTIME_VARIANTS,
  ANALYSIS_TORCH_VERSION,
  analysisRuntimePython,
  expectedTorchVersion,
  isAnalysisRuntimeVariant,
  type AnalysisRuntimeVariant,
} from './runtime-layout';
import { isLocalForgePackage, resolveInstallationLayout } from './installation-layout';

const ANALYSIS_NUMPY_VERSION = '2.5.1';
const ANALYSIS_OPENCV_VERSION = '4.13.0';

export type AnalysisRuntimeDiagnostics = {
  pythonExecutable: string;
  torchVersion: string | null;
  torchCudaVersion: string | null;
  cudaAvailable: boolean | null;
  gpuName: string | null;
  gpuCapability: unknown[] | null;
  cudaArchList: unknown[] | null;
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

function parseRuntimeOutput(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const json = lines.at(-1);
  if (!json) throw new Error('ANALYSIS_RUNTIME_EMPTY_OUTPUT');
  return JSON.parse(json) as Record<string, unknown>;
}

function runtimeDiagnostics(
  python: string,
  result: { stdout: string; stderr: string; exitCode: number | null },
  value: Record<string, unknown> = {},
): AnalysisRuntimeDiagnostics {
  return {
    pythonExecutable: typeof value.python_executable === 'string' ? value.python_executable : python,
    torchVersion: typeof value.torch === 'string' ? value.torch : null,
    torchCudaVersion: typeof value.torch_cuda === 'string' ? value.torch_cuda : null,
    cudaAvailable: typeof value.cuda_available === 'boolean' ? value.cuda_available : null,
    gpuName: typeof value.device_name === 'string' ? value.device_name : null,
    gpuCapability: Array.isArray(value.device_capability) ? value.device_capability : null,
    cudaArchList: Array.isArray(value.cuda_arch_list) ? value.cuda_arch_list : null,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function runtimeFailure(
  code: string,
  python: string,
  result: ProcessResult,
  value: Record<string, unknown>,
  cause?: unknown,
): AnalysisRuntimeValidationError {
  return new AnalysisRuntimeValidationError(
    code,
    runtimeDiagnostics(python, { ...result, exitCode: result.code }, value),
    cause === undefined ? undefined : { cause },
  );
}

function diagnosticsFromError(python: string, error: unknown): AnalysisRuntimeDiagnostics {
  if (error instanceof AnalysisRuntimeValidationError) return error.diagnostics;
  if (error instanceof ProcessExecutionError) {
    let value: Record<string, unknown> = {};
    try {
      value = parseRuntimeOutput(error.stdout);
    } catch {
      // The raw streams below remain the source of truth when Python emitted no valid JSON.
    }
    return runtimeDiagnostics(python, {
      stdout: error.stdout,
      stderr: error.stderr,
      exitCode: error.exitCode,
    }, value);
  }
  return runtimeDiagnostics(python, {
    stdout: '',
    stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    exitCode: null,
  });
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
  const diagnostics = analysisRuntimeDiagnostics(error);
  if (!diagnostics) return null;
  const boundedStream = (value: string): string => {
    const maximumLength = 7_000;
    if (value.length <= maximumLength) return value;
    return `${value.slice(0, maximumLength)}...[truncated ${value.length - maximumLength} chars]`;
  };
  return [
    `python.exe path=${JSON.stringify(diagnostics.pythonExecutable)}`,
    `torch.__version__=${JSON.stringify(diagnostics.torchVersion)}`,
    `torch.version.cuda=${JSON.stringify(diagnostics.torchCudaVersion)}`,
    `torch.cuda.is_available()=${JSON.stringify(diagnostics.cudaAvailable)}`,
    `GPU name=${JSON.stringify(diagnostics.gpuName)}`,
    `GPU capability=${JSON.stringify(diagnostics.gpuCapability)}`,
    `torch.cuda.get_arch_list()=${JSON.stringify(diagnostics.cudaArchList)}`,
    `exit code=${JSON.stringify(diagnostics.exitCode)}`,
    `stdout=${JSON.stringify(boundedStream(diagnostics.stdout))}`,
    `stderr=${JSON.stringify(boundedStream(diagnostics.stderr))}`,
  ].join('; ');
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export type RuntimeLocation = AnalysisRuntimeVariant | 'external' | 'legacy';
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

type RuntimeCandidate = { python: string; variant: RuntimeLocation };
type MediaCandidate = { ffmpeg: string; ffprobe: string; encoder: MediaEncoder };

function resource(...parts: string[]): string {
  return path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), ...parts);
}

async function modelResource(filename: string): Promise<string> {
  const bundled = resource('resources', 'models', filename);
  if (!app.isPackaged || !isLocalForgePackage(path.dirname(process.execPath))) return bundled;

  try {
    const installed = path.join(resolveInstallationLayout().appRoot, 'resources', 'resources', 'models', filename);
    return await firstExisting([bundled, installed]) ?? bundled;
  } catch {
    // A standalone local package has no registered install to reuse; its missing model remains visible to setup.
    return bundled;
  }
}

async function localTrackNetWeight(): Promise<string | null> {
  if (app.isPackaged || process.env.TTCUT_ENABLE_LOCAL_TRACKNET !== '1') return null;
  const configured = process.env.TTCUT_TRACKNET_WEIGHTS?.trim();
  if (!configured) return null;
  const weight = path.resolve(configured);
  return await exists(weight) ? weight : null;
}

export function managedComponentsRoot(): string {
  if (!app.isPackaged && process.env.TTCUT_E2E === '1' && process.env.TTCUT_E2E_COMPONENTS_ROOT) {
    return path.resolve(process.env.TTCUT_E2E_COMPONENTS_ROOT);
  }
  return resolveInstallationLayout().componentRoot;
}

function requestedVariants(device: 'auto' | 'cuda' | 'cpu'): AnalysisRuntimeVariant[] {
  if (device === 'cpu') return ['cpu'];
  if (device === 'cuda') return ['cu132', 'cu126'];
  return ['cu132', 'cu126', 'cpu'];
}

async function runtimeCandidates(device: 'auto' | 'cuda' | 'cpu'): Promise<RuntimeCandidate[]> {
  const managedRoot = managedComponentsRoot();
  const allowDevelopmentFallbacks = !app.isPackaged && !(
    process.env.TTCUT_E2E === '1' && process.env.TTCUT_E2E_DISABLE_DEV_COMPONENTS === '1'
  );
  const candidates: RuntimeCandidate[] = [];
  if (process.env.TTCUT_PYTHON) candidates.push({ python: process.env.TTCUT_PYTHON, variant: 'external' });
  for (const variant of requestedVariants(device)) {
    candidates.push({ python: path.join(managedRoot, ...analysisRuntimePython(variant).split('/')), variant });
  }
  if (allowDevelopmentFallbacks) {
    candidates.push({ python: path.join(managedRoot, 'python-3.12.13', 'python.exe'), variant: 'legacy' });
  }
  const seen = new Set<string>();
  const available: RuntimeCandidate[] = [];
  for (const candidate of candidates) {
    const key = path.resolve(candidate.python).toLowerCase();
    if (seen.has(key) || !await exists(candidate.python)) continue;
    seen.add(key);
    available.push(candidate);
  }
  return available;
}

async function firstExisting(values: string[]): Promise<string | null> {
  for (const value of values) if (await exists(value)) return value;
  return null;
}

async function mediaCandidates(): Promise<MediaCandidate[]> {
  const managedRoot = managedComponentsRoot();
  const raw: MediaCandidate[] = [];
  if (process.env.TTCUT_FFMPEG && process.env.TTCUT_FFPROBE) {
    raw.push({ ffmpeg: process.env.TTCUT_FFMPEG, ffprobe: process.env.TTCUT_FFPROBE, encoder: 'libopenh264' });
  }
  raw.push(
    {
      ffmpeg: path.join(managedRoot, 'ffmpeg-x264-N-125716-g1b1f602699', 'bin', 'ffmpeg.exe'),
      ffprobe: path.join(managedRoot, 'ffmpeg-x264-N-125716-g1b1f602699', 'bin', 'ffprobe.exe'),
      encoder: 'libx264',
    },
    {
      ffmpeg: path.join(managedRoot, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'),
      ffprobe: path.join(managedRoot, 'ffmpeg-8.1', 'bin', 'ffprobe.exe'),
      encoder: 'libopenh264',
    },
    {
      ffmpeg: resource('resources', 'ffmpeg', 'ffmpeg.exe'),
      ffprobe: resource('resources', 'ffmpeg', 'ffprobe.exe'),
      encoder: 'libopenh264',
    },
  );
  const available: MediaCandidate[] = [];
  for (const candidate of raw) {
    if (await exists(candidate.ffmpeg) && await exists(candidate.ffprobe)) available.push(candidate);
  }
  return available;
}

export async function resolveComponents(device: 'auto' | 'cuda' | 'cpu' = 'auto'): Promise<ComponentPaths> {
  const runtimes = await runtimeCandidates(device);
  const media = (await mediaCandidates())[0] ?? null;
  return {
    python: runtimes[0]?.python ?? null,
    runtimeVariant: runtimes[0]?.variant ?? null,
    worker: resource('worker'),
    blurballWeights: process.env.TTCUT_BLURBALL_WEIGHTS || await modelResource('blurball_best.pt'),
    tracknetWeights: await localTrackNetWeight(),
    tableAnalyzeWeights: process.env.TTCUT_TABLE_ANALYZE_WEIGHTS || await modelResource('table_analyze.pt'),
    ffmpeg: media?.ffmpeg ?? null,
    ffprobe: media?.ffprobe ?? null,
    mediaEncoder: media?.encoder ?? 'unavailable',
  };
}

export async function activateManagedAnalysisRuntime(variant: AnalysisRuntimeVariant): Promise<void> {
  const root = managedComponentsRoot();
  await mkdir(root, { recursive: true });
  const target = path.join(root, ACTIVE_RUNTIME_MANIFEST);
  const temporary = `${target}.partial`;
  await writeFile(temporary, JSON.stringify({
    schema_version: 1,
    runtime_id: ANALYSIS_RUNTIME_ID,
    variant,
    activated_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  await rename(temporary, target);
}

export async function validateAnalysisComponent(
  python: string,
  expectedVariant?: AnalysisRuntimeVariant,
): Promise<{ version: string; pythonVersion: string; torchVersion: string; acceleration: 'cuda' | 'cpu'; variant: AnalysisRuntimeVariant }> {
  return validateAnalysisRuntime(python, expectedVariant);
}

export async function validateAnalysisRuntime(
  python: string,
  expectedVariant?: AnalysisRuntimeVariant,
): Promise<{ version: string; pythonVersion: string; torchVersion: string; acceleration: 'cuda' | 'cpu'; variant: AnalysisRuntimeVariant }> {
  let result: ProcessResult;
  try {
    result = await runProcess(python, [
      '-c',
      'import json,sys\nvalue={"python_executable":sys.executable,"python":sys.version.split()[0],"torch":None,"torch_cuda":None,"opencv":None,"numpy":None,"acceleration":None,"cuda_available":None,"cuda_smoke":False,"device_name":None,"device_capability":None,"cuda_arch_list":None,"compiled_arch_list":None}\ntry:\n import cv2,numpy,torch\n value.update({"torch":torch.__version__,"torch_cuda":torch.version.cuda,"opencv":cv2.__version__,"numpy":numpy.__version__})\n value["cuda_available"]=torch.cuda.is_available();value["acceleration"]="cuda" if value["cuda_available"] else "cpu";value["compiled_arch_list"]=getattr(torch._C,"_cuda_getArchFlags",lambda:" ")().split();value["cuda_arch_list"]=torch.cuda.get_arch_list()\n if value["cuda_available"]:\n  value["device_name"]=torch.cuda.get_device_name(0);value["device_capability"]=list(torch.cuda.get_device_capability(0))\n  try:\n   x=torch.ones((1,3,4,4),device="cuda");w=torch.ones((1,3,3,3),device="cuda");torch.nn.functional.conv2d(x,w);torch.cuda.synchronize();value["cuda_smoke"]=True\n  except Exception as error:value["cuda_smoke_error"]=str(error)\nexcept Exception as error:\n value["diagnostic_error"]=repr(error);print(json.dumps(value),flush=True);raise\nprint(json.dumps(value),flush=True)',
    ], {
      timeoutMs: 30_000,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
  } catch (error) {
    const code = expectedVariant && expectedVariant !== 'cpu'
      ? 'CUDA_RUNTIME_SELF_TEST_FAILED'
      : 'ANALYSIS_RUNTIME_SELF_TEST_FAILED';
    throw new AnalysisRuntimeValidationError(code, diagnosticsFromError(python, error), { cause: error });
  }
  let value: Record<string, unknown>;
  try {
    value = parseRuntimeOutput(result.stdout);
  } catch (error) {
    const code = expectedVariant && expectedVariant !== 'cpu'
      ? 'CUDA_RUNTIME_SELF_TEST_FAILED'
      : 'ANALYSIS_RUNTIME_SELF_TEST_FAILED';
    throw runtimeFailure(code, python, result, {}, error);
  }
  const acceptedTorchVersions = new Set<string>([
    ...ANALYSIS_RUNTIME_VARIANTS.map((variant) => expectedTorchVersion(variant)),
  ]);
  if (value.python !== ANALYSIS_PYTHON_VERSION || typeof value.torch !== 'string' || !acceptedTorchVersions.has(value.torch)) {
    throw runtimeFailure('ANALYSIS_RUNTIME_VERSION_MISMATCH', python, result, value);
  }
  if (value.numpy !== ANALYSIS_NUMPY_VERSION || value.opencv !== ANALYSIS_OPENCV_VERSION) throw runtimeFailure('ANALYSIS_RUNTIME_VERSION_MISMATCH', python, result, value);
  if (value.acceleration !== 'cuda' && value.acceleration !== 'cpu') throw runtimeFailure('ANALYSIS_RUNTIME_SELF_TEST_FAILED', python, result, value);
  const inferredVariant = ANALYSIS_RUNTIME_VARIANTS.find((variant) => value.torch === expectedTorchVersion(variant));
  if (!inferredVariant) throw runtimeFailure('ANALYSIS_RUNTIME_VERSION_MISMATCH', python, result, value);
  if (expectedVariant && value.torch !== expectedTorchVersion(expectedVariant)) throw runtimeFailure('ANALYSIS_RUNTIME_VARIANT_MISMATCH', python, result, value);
  if (expectedVariant === 'cpu' && (value.torch_cuda !== null || value.acceleration !== 'cpu')) throw runtimeFailure('ANALYSIS_RUNTIME_VARIANT_MISMATCH', python, result, value);
  if (expectedVariant && expectedVariant !== 'cpu') {
    const expectedCuda = expectedVariant === 'cu132' ? '13.2' : '12.6';
    if (value.torch_cuda !== expectedCuda || value.acceleration !== 'cuda') throw runtimeFailure('CUDA_RUNTIME_SELF_TEST_FAILED', python, result, value);
    const capability = Array.isArray(value.device_capability) && value.device_capability.length === 2
      ? Number(value.device_capability[0]) + Number(value.device_capability[1]) / 10
      : null;
    if (capability === null) throw runtimeFailure('CUDA_RUNTIME_UNSUPPORTED_ARCHITECTURE', python, result, value);
    if (value.cuda_smoke !== true) throw runtimeFailure('CUDA_RUNTIME_SELF_TEST_FAILED', python, result, value);
  }
  return {
    version: `Python ${value.python} / PyTorch ${value.torch}`,
    pythonVersion: String(value.python),
    torchVersion: value.torch,
    acceleration: value.acceleration,
    variant: expectedVariant ?? inferredVariant,
  };
}

export async function resolveUsableAnalysisComponents(device: 'auto' | 'cuda' | 'cpu'): Promise<ComponentPaths> {
  const base = await resolveComponents(device);
  const candidates = await runtimeCandidates(device);
  if (!candidates.length) throw new Error('RUNTIME_MISSING');
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const expected = isAnalysisRuntimeVariant(candidate.variant) ? candidate.variant : undefined;
      const validation = await validateAnalysisComponent(candidate.python, expected);
      if (device === 'cuda' && validation.acceleration !== 'cuda') throw new Error('DEVICE_UNAVAILABLE');
      if (device === 'cpu' && validation.acceleration !== 'cpu') throw new Error('DEVICE_UNAVAILABLE');
      if (isAnalysisRuntimeVariant(candidate.variant)) await activateManagedAnalysisRuntime(candidate.variant);
      return { ...base, python: candidate.python, runtimeVariant: candidate.variant };
    } catch (error) {
      lastError = error;
    }
  }
  if (device === 'cuda') throw new Error('DEVICE_UNAVAILABLE', { cause: lastError ?? undefined });
  throw lastError instanceof Error ? lastError : new Error('ANALYSIS_RUNTIME_SELF_TEST_FAILED');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function validateMediaComponent(
  ffmpeg: string,
  ffprobe: string,
  encoder: MediaEncoder = 'libopenh264',
): Promise<{ version: string; encoder: MediaEncoder }> {
  const catalog = await loadComponentCatalog();
  const asset = encoder === 'libx264' ? catalog.ffmpeg_x264 : catalog.ffmpeg;
  const [version, probeVersion, build, encoders] = await Promise.all([
    runProcess(ffmpeg, ['-version'], { timeoutMs: 10_000 }),
    runProcess(ffprobe, ['-version'], { timeoutMs: 10_000 }),
    runProcess(ffmpeg, ['-buildconf'], { timeoutMs: 10_000 }),
    runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }),
  ]);
  const firstLine = version.stdout.split(/\r?\n/)[0] ?? '';
  const probeFirstLine = probeVersion.stdout.split(/\r?\n/)[0] ?? '';
  if (!firstLine.includes(asset.version_line) || !probeFirstLine.includes(asset.version_line)) {
    throw new Error('MEDIA_RUNTIME_VERSION_MISMATCH');
  }
  const configuration = `${version.stdout}\n${build.stdout}`;
  for (const flag of asset.required_build_flags) {
    if (!configuration.includes(flag)) throw new Error(`MEDIA_RUNTIME_BUILD_FLAG_MISSING:${flag}`);
  }
  for (const requiredEncoder of asset.required_encoders) {
    if (!new RegExp(`\\b${escapeRegExp(requiredEncoder)}\\b`).test(encoders.stdout)) throw new Error(`MEDIA_RUNTIME_ENCODER_MISSING:${requiredEncoder}`);
  }
  return { version: firstLine.replace(/^ffmpeg version\s+/, ''), encoder };
}

export async function validateX264EightKCapability(ffmpeg: string): Promise<void> {
  try {
    await runProcess(ffmpeg, [
      '-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=7680x4320:r=1:d=1',
      '-frames:v', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ], { timeoutMs: 60_000 });
  } catch (error) {
    throw new Error('X264_8K_SELF_TEST_FAILED', { cause: error });
  }
}

export async function resolveUsableMediaComponents(): Promise<Pick<ComponentPaths, 'ffmpeg' | 'ffprobe' | 'mediaEncoder'>> {
  let lastError: unknown = null;
  for (const candidate of await mediaCandidates()) {
    try {
      await validateMediaComponent(candidate.ffmpeg, candidate.ffprobe, candidate.encoder);
      return { ffmpeg: candidate.ffmpeg, ffprobe: candidate.ffprobe, mediaEncoder: candidate.encoder };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('MEDIA_COMPONENT_MISSING');
}

export async function inspectComponentPaths(paths: ComponentPaths, x264Available = false): Promise<ComponentStatus> {
  let analysisVersion: string | null = null;
  let acceleration: 'cuda' | 'cpu' | 'unavailable' = 'unavailable';
  let analysisDetail: string | null = null;
  const modelsAvailable = await exists(paths.blurballWeights)
    && await exists(paths.tableAnalyzeWeights);
  if (paths.python && modelsAvailable) {
    try {
      const expected = paths.runtimeVariant && isAnalysisRuntimeVariant(paths.runtimeVariant) ? paths.runtimeVariant : undefined;
      const result = await validateAnalysisComponent(paths.python, expected);
      analysisVersion = `${result.version} (${result.variant})`;
      acceleration = result.acceleration;
    } catch (error) {
      analysisDetail = error instanceof Error ? error.message : String(error);
    }
  } else {
    analysisDetail = !paths.python ? 'ANALYSIS_RUNTIME_MISSING' : 'MODEL_RESOURCE_MISSING';
  }

  let mediaVersion: string | null = null;
  let mediaDetail: string | null = null;
  if (paths.ffmpeg && paths.ffprobe) {
    try {
      mediaVersion = (await validateMediaComponent(
        paths.ffmpeg,
        paths.ffprobe,
        paths.mediaEncoder === 'libx264' ? 'libx264' : 'libopenh264',
      )).version;
    } catch (error) {
      mediaDetail = error instanceof Error ? error.message : String(error);
    }
  } else {
    mediaDetail = 'MEDIA_RUNTIME_MISSING';
  }
  return {
    analysis: {
      available: Boolean(paths.python && modelsAvailable && !analysisDetail),
      version: analysisVersion,
      path: paths.python,
      acceleration,
      detail: analysisDetail,
    },
    media: {
      available: Boolean(paths.ffmpeg && paths.ffprobe && !mediaDetail),
      version: mediaVersion,
      path: paths.ffmpeg,
      active_encoder: mediaDetail ? 'unavailable' : paths.mediaEncoder,
      x264_available: x264Available || (!mediaDetail && paths.mediaEncoder === 'libx264'),
      detail: mediaDetail,
    },
  };
}

export async function inspectComponents(): Promise<ComponentStatus> {
  const raw = await resolveComponents('auto');
  const usableMedia = await resolveUsableMediaComponents().catch(() => null);
  const paths = usableMedia ? { ...raw, ...usableMedia } : raw;
  const catalog = await loadComponentCatalog();
  const x264Root = path.join(managedComponentsRoot(), catalog.ffmpeg_x264.install_directory, 'bin');
  const x264Ffmpeg = path.join(x264Root, 'ffmpeg.exe');
  const x264Ffprobe = path.join(x264Root, 'ffprobe.exe');
  const x264Available = await validateMediaComponent(x264Ffmpeg, x264Ffprobe, 'libx264')
    .then(() => true)
    .catch(() => false);
  try {
    const analysis = await resolveUsableAnalysisComponents('auto');
    return inspectComponentPaths({
      ...analysis,
      ffmpeg: paths.ffmpeg,
      ffprobe: paths.ffprobe,
      mediaEncoder: paths.mediaEncoder,
    }, x264Available);
  } catch {
    return inspectComponentPaths(paths, x264Available);
  }
}
