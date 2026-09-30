import { access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { resolveUsableMediaComponents } from './components';
import { distributionIdentity } from './distribution';

export async function resolveSmallComponents() {
  if (process.platform !== 'win32' || (app.isPackaged && !distributionIdentity().independentBeta)) throw new Error('SMALL_LOCAL_ONLY');
  const root = path.resolve(process.env.TTCUT_MOBILENET_ROOT?.trim() || 'E:/MobileNetV3-Large');
  const python = path.join(root, '.venv-training', 'Scripts', 'python.exe');
  try { await access(python); } catch { throw new Error('SMALL_RUNTIME_MISSING'); }
  const worker = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'worker');
  for (const file of [
    path.join(root, 'huji_student', 'runs', 'manual_p3_20260930_epoch1', 'best.pt'),
    path.join(root, 'config', 'rally_decoder_small_epoch1_refit_6fps_20260930_balanced.json'),
    path.join(root, 'rally_detection', 'pipeline.py'),
    path.join(worker, 'ttcut_worker', 'mobilenet_small.py'),
    path.join(worker, 'ttcut_worker', 'mobilenet_sampling.py'),
  ]) {
    try { await access(file); } catch { throw new Error('SMALL_RESOURCE_MISSING'); }
  }
  const media = await resolveUsableMediaComponents();
  if (!media.ffmpeg || !media.ffprobe) throw new Error('MEDIA_COMPONENT_MISSING');
  return { root, python, worker, media };
}

export async function inspectSmallBackend(): Promise<{ available: boolean; detail: string | null }> {
  try {
    await resolveSmallComponents();
    return { available: true, detail: null };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
