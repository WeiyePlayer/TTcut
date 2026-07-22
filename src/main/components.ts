import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { ComponentStatus } from '../shared/contracts';
import { sha256File } from './component-assets';
import { loadComponentCatalog } from './component-catalog';
import { runProcess } from './processes';
import {
  ACTIVE_RUNTIME_MANIFEST,
  ANALYSIS_PYTHON_VERSION,
  ANALYSIS_RUNTIME_ID,
  ANALYSIS_RUNTIME_VARIANTS,
  ANALYSIS_TORCH_VERSION,
  analysisRuntimePython,
  isCudaArchitectureSupported,
  expectedTorchVersion,
  isAnalysisRuntimeVariant,
  type AnalysisRuntimeVariant,
} from './runtime-layout';

const ANALYSIS_NUMPY_VERSION = '2.5.1';
const ANALYSIS_OPENCV_VERSION = '4.13.0';

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export type RuntimeLocation = AnalysisRuntimeVariant | 'external' | 'legacy';

export type ComponentPaths = {
  python: string | null;
  runtimeVariant: RuntimeLocation | null;
  worker: string;
  weights: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
};

type RuntimeCandidate = { python: string; variant: RuntimeLocation };

function resource(...parts: string[]): string {
  return path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), ...parts);
}

export function managedComponentsRoot(): string {
  if (!app.isPackaged && process.env.TTCUT_E2E === '1' && process.env.TTCUT_E2E_COMPONENTS_ROOT) {
    return path.resolve(process.env.TTCUT_E2E_COMPONENTS_ROOT);
  }
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? path.join(localAppData, 'TTcutData', 'components')
    : path.join(app.getPath('userData'), 'components');
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

async function resolveWeights(): Promise<string | null> {
  const managedRoot = managedComponentsRoot();
  return firstExisting([
    process.env.TTCUT_TRACKNET_WEIGHTS,
    path.join(managedRoot, 'models', 'TrackNet_best.pt'),
  ].filter((item): item is string => Boolean(item)));
}

export async function resolveComponents(device: 'auto' | 'cuda' | 'cpu' = 'auto'): Promise<ComponentPaths> {
  const managedRoot = managedComponentsRoot();
  const runtimes = await runtimeCandidates(device);
  const media = await Promise.all([
    firstExisting([
      process.env.TTCUT_FFMPEG,
      path.join(managedRoot, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'),
      resource('resources', 'ffmpeg', 'ffmpeg.exe'),
    ].filter((item): item is string => Boolean(item))),
    firstExisting([
      process.env.TTCUT_FFPROBE,
      path.join(managedRoot, 'ffmpeg-8.1', 'bin', 'ffprobe.exe'),
      resource('resources', 'ffmpeg', 'ffprobe.exe'),
    ].filter((item): item is string => Boolean(item))),
  ]);
  return {
    python: runtimes[0]?.python ?? null,
    runtimeVariant: runtimes[0]?.variant ?? null,
    worker: resource('worker'),
    weights: await resolveWeights(),
    ffmpeg: media[0],
    ffprobe: media[1],
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
  weights: string,
  expectedVariant?: AnalysisRuntimeVariant,
): Promise<{ version: string; pythonVersion: string; torchVersion: string; acceleration: 'cuda' | 'cpu'; variant: AnalysisRuntimeVariant }> {
  const catalog = await loadComponentCatalog();
  if (await sha256File(weights) !== catalog.tracknet_weight.sha256) throw new Error('TRACKNET_WEIGHT_HASH_MISMATCH');
  return validateAnalysisRuntime(python, expectedVariant);
}

export async function validateAnalysisRuntime(
  python: string,
  expectedVariant?: AnalysisRuntimeVariant,
): Promise<{ version: string; pythonVersion: string; torchVersion: string; acceleration: 'cuda' | 'cpu'; variant: AnalysisRuntimeVariant }> {
  const result = await runProcess(python, [
    '-c',
    'import cv2,json,numpy,sys,torch;value={"python":sys.version.split()[0],"torch":torch.__version__,"torch_cuda":torch.version.cuda,"opencv":cv2.__version__,"numpy":numpy.__version__,"acceleration":"cuda" if torch.cuda.is_available() else "cpu","cuda_smoke":False,"compiled_arch_list":getattr(torch._C,"_cuda_getArchFlags",lambda:" ")().split()};\nif torch.cuda.is_available():\n value["device_name"]=torch.cuda.get_device_name(0);value["device_capability"]=list(torch.cuda.get_device_capability(0));value["cuda_arch_list"]=torch.cuda.get_arch_list();\n try:\n  x=torch.ones((1,3,4,4),device="cuda");w=torch.ones((1,3,3,3),device="cuda");torch.nn.functional.conv2d(x,w);torch.cuda.synchronize();value["cuda_smoke"]=True\n except Exception as error:value["cuda_smoke_error"]=str(error)\nprint(json.dumps(value))',
  ], { timeoutMs: 30_000 });
  const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  const acceptedTorchVersions = new Set<string>([
    ...ANALYSIS_RUNTIME_VARIANTS.map((variant) => expectedTorchVersion(variant)),
  ]);
  if (value.python !== ANALYSIS_PYTHON_VERSION || typeof value.torch !== 'string' || !acceptedTorchVersions.has(value.torch)) {
    throw new Error('ANALYSIS_RUNTIME_VERSION_MISMATCH');
  }
  if (value.numpy !== ANALYSIS_NUMPY_VERSION || value.opencv !== ANALYSIS_OPENCV_VERSION) throw new Error('ANALYSIS_RUNTIME_VERSION_MISMATCH');
  if (value.acceleration !== 'cuda' && value.acceleration !== 'cpu') throw new Error('ANALYSIS_RUNTIME_SELF_TEST_FAILED');
  const inferredVariant = ANALYSIS_RUNTIME_VARIANTS.find((variant) => value.torch === expectedTorchVersion(variant));
  if (!inferredVariant) throw new Error('ANALYSIS_RUNTIME_VERSION_MISMATCH');
  if (expectedVariant && value.torch !== expectedTorchVersion(expectedVariant)) throw new Error('ANALYSIS_RUNTIME_VARIANT_MISMATCH');
  if (expectedVariant === 'cpu' && (value.torch_cuda !== null || value.acceleration !== 'cpu')) throw new Error('ANALYSIS_RUNTIME_VARIANT_MISMATCH');
  if (expectedVariant && expectedVariant !== 'cpu') {
    const expectedCuda = expectedVariant === 'cu132' ? '13.2' : '12.6';
    if (value.torch_cuda !== expectedCuda || value.acceleration !== 'cuda') throw new Error('CUDA_RUNTIME_SELF_TEST_FAILED');
    const capability = Array.isArray(value.device_capability) && value.device_capability.length === 2
      ? Number(value.device_capability[0]) + Number(value.device_capability[1]) / 10
      : null;
    const archList = Array.isArray(value.cuda_arch_list)
      ? value.cuda_arch_list.filter((item): item is string => typeof item === 'string')
      : Array.isArray(value.compiled_arch_list)
        ? value.compiled_arch_list.filter((item): item is string => typeof item === 'string')
        : [];
    if (capability === null || !isCudaArchitectureSupported(capability, archList)) throw new Error('CUDA_RUNTIME_UNSUPPORTED_ARCHITECTURE');
    if (value.cuda_smoke !== true) throw new Error('CUDA_RUNTIME_SELF_TEST_FAILED');
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
  if (!base.weights) throw new Error('WEIGHT_MISSING');
  const candidates = await runtimeCandidates(device);
  if (!candidates.length) throw new Error('RUNTIME_MISSING');
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const expected = isAnalysisRuntimeVariant(candidate.variant) ? candidate.variant : undefined;
      const validation = await validateAnalysisComponent(candidate.python, base.weights, expected);
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

export async function validateMediaComponent(ffmpeg: string, ffprobe: string): Promise<{ version: string }> {
  const catalog = await loadComponentCatalog();
  const [version, probeVersion, build, encoders] = await Promise.all([
    runProcess(ffmpeg, ['-version'], { timeoutMs: 10_000 }),
    runProcess(ffprobe, ['-version'], { timeoutMs: 10_000 }),
    runProcess(ffmpeg, ['-buildconf'], { timeoutMs: 10_000 }),
    runProcess(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }),
  ]);
  const firstLine = version.stdout.split(/\r?\n/)[0] ?? '';
  const probeFirstLine = probeVersion.stdout.split(/\r?\n/)[0] ?? '';
  if (!firstLine.includes(catalog.ffmpeg.version_line) || !probeFirstLine.includes(catalog.ffmpeg.version_line)) {
    throw new Error('MEDIA_RUNTIME_VERSION_MISMATCH');
  }
  const configuration = `${version.stdout}\n${build.stdout}`;
  for (const flag of catalog.ffmpeg.required_build_flags) {
    if (!configuration.includes(flag)) throw new Error(`MEDIA_RUNTIME_BUILD_FLAG_MISSING:${flag}`);
  }
  for (const encoder of catalog.ffmpeg.required_encoders) {
    if (!new RegExp(`\\b${escapeRegExp(encoder)}\\b`).test(encoders.stdout)) throw new Error(`MEDIA_RUNTIME_ENCODER_MISSING:${encoder}`);
  }
  return { version: firstLine.replace(/^ffmpeg version\s+/, '') };
}

export async function inspectComponentPaths(paths: ComponentPaths): Promise<ComponentStatus> {
  let analysisVersion: string | null = null;
  let acceleration: 'cuda' | 'cpu' | 'unavailable' = 'unavailable';
  let analysisDetail: string | null = null;
  if (paths.python && paths.weights) {
    try {
      const expected = paths.runtimeVariant && isAnalysisRuntimeVariant(paths.runtimeVariant) ? paths.runtimeVariant : undefined;
      const result = await validateAnalysisComponent(paths.python, paths.weights, expected);
      analysisVersion = `${result.version} (${result.variant})`;
      acceleration = result.acceleration;
    } catch (error) {
      analysisDetail = error instanceof Error ? error.message : String(error);
    }
  } else {
    analysisDetail = !paths.python ? 'ANALYSIS_RUNTIME_MISSING' : 'TRACKNET_WEIGHT_MISSING';
  }

  let mediaVersion: string | null = null;
  let mediaDetail: string | null = null;
  if (paths.ffmpeg && paths.ffprobe) {
    try {
      mediaVersion = (await validateMediaComponent(paths.ffmpeg, paths.ffprobe)).version;
    } catch (error) {
      mediaDetail = error instanceof Error ? error.message : String(error);
    }
  } else {
    mediaDetail = 'MEDIA_RUNTIME_MISSING';
  }
  return {
    analysis: {
      available: Boolean(paths.python && paths.weights && !analysisDetail),
      version: analysisVersion,
      path: paths.python,
      acceleration,
      detail: analysisDetail,
    },
    media: {
      available: Boolean(paths.ffmpeg && paths.ffprobe && !mediaDetail),
      version: mediaVersion,
      path: paths.ffmpeg,
      detail: mediaDetail,
    },
  };
}

export async function inspectComponents(): Promise<ComponentStatus> {
  try {
    return inspectComponentPaths(await resolveUsableAnalysisComponents('auto'));
  } catch {
    return inspectComponentPaths(await resolveComponents('auto'));
  }
}
