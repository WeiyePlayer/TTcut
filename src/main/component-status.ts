import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { componentStatusSchema, type ComponentStatus } from '../shared/contracts';
import { inspectComponents, managedComponentsRoot, resolveComponents } from './components';

// Installation readiness persists independently of transient diagnostic failures.
let writes = Promise.resolve();
let backgroundCheck: Promise<void> | undefined;

async function readStatus(): Promise<ComponentStatus | null> {
  try {
    return componentStatusSchema.parse(JSON.parse(await readFile(
      path.join(managedComponentsRoot(), 'component-status.json'), 'utf8',
    )));
  } catch {
    return null;
  }
}

function rememberStatus(status: ComponentStatus): Promise<ComponentStatus> {
  let result = status;
  const root = managedComponentsRoot();
  writes = writes.catch(() => undefined).then(async () => {
    const previous = await readStatus();
    result = {
      analysis: !status.analysis.available && previous?.analysis.available ? previous.analysis : status.analysis,
      media: !status.media.available && previous?.media.available ? previous.media : status.media,
    };
    await mkdir(root, { recursive: true });
    const target = path.join(root, 'component-status.json');
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2), 'utf8');
    await rename(temporary, target);
  });
  // A read-only component directory must not prevent use of installed components.
  return writes.catch(() => undefined).then(() => result);
}

export async function inspectInstalledComponents(): Promise<ComponentStatus> {
  const status = await inspectComponents();
  return process.platform === 'darwin' ? status : rememberStatus(status);
}

export async function startupComponentStatus(): Promise<ComponentStatus> {
  // macOS ships one immutable runtime inside the app bundle, so its current
  // manifest is authoritative. The persisted component store is Windows-only.
  if (process.platform === 'darwin') return inspectComponents();
  const previous = await readStatus();
  if (previous) return previous;
  // Migrate existing installations without running Python or FFmpeg on startup.
  const paths = await resolveComponents();
  const models = await Promise.all([paths.blurballWeights, paths.tableAnalyzeWeights].map(
    (file) => access(file).then(() => true, () => false),
  ));
  const analysisAvailable = Boolean(paths.python && models.every(Boolean));
  const mediaAvailable = Boolean(paths.ffmpeg && paths.ffprobe);
  return rememberStatus({
    analysis: {
      available: analysisAvailable, version: null, path: paths.python,
      acceleration: analysisAvailable ? (paths.runtimeVariant === 'cpu' ? 'cpu' : 'unavailable') : 'unavailable',
      detail: analysisAvailable ? null : 'ANALYSIS_RUNTIME_MISSING',
    },
    media: {
      available: mediaAvailable, version: null, path: paths.ffmpeg,
      active_encoder: paths.mediaEncoder,
      x264_available: paths.mediaEncoder === 'libx264',
      detail: mediaAvailable ? null : 'MEDIA_RUNTIME_MISSING',
    },
  });
}

export function silentlyInspectComponents(onError: (error: unknown) => void): void {
  if (process.platform === 'darwin') return;
  if (backgroundCheck) return;
  backgroundCheck = inspectComponents().then(async (status) => {
    for (const component of [status.analysis, status.media]) {
      if (component.detail) onError(new Error(component.detail));
    }
    await rememberStatus(status);
  }).catch(onError).finally(() => { backgroundCheck = undefined; });
}
