import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentStatus } from '../src/shared/contracts';

const mock = vi.hoisted(() => ({ root: '', inspect: vi.fn(), resolve: vi.fn() }));
vi.mock('../src/main/components', () => ({
  managedComponentsRoot: () => mock.root,
  inspectComponents: mock.inspect,
  resolveComponents: mock.resolve,
}));
import { inspectInstalledComponents, silentlyInspectComponents, startupComponentStatus } from '../src/main/component-status';

const ready: ComponentStatus = {
  analysis: { available: true, version: 'Python / Torch', path: 'python.exe', acceleration: 'cuda', detail: null },
  media: { available: true, version: 'ffmpeg', path: 'ffmpeg.exe', active_encoder: 'libopenh264', x264_available: false, detail: null },
};
const failed: ComponentStatus = {
  analysis: { ...ready.analysis, available: false, detail: 'ANALYSIS_RUNTIME_SELF_TEST_FAILED' },
  media: { ...ready.media, available: false, detail: 'MEDIA_RUNTIME_MISSING' },
};

beforeEach(async () => {
  vi.clearAllMocks();
  mock.root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-component-status-'));
});
afterEach(async () => {
  await rm(mock.root, { recursive: true, force: true });
});

describe('persistent component readiness', () => {
  it('returns installed readiness on startup without running diagnostics or resolving paths', async () => {
    mock.inspect.mockResolvedValue(ready);
    await inspectInstalledComponents();
    mock.inspect.mockClear();
    expect(await startupComponentStatus()).toEqual(ready);
    expect(mock.inspect).not.toHaveBeenCalled();
    expect(mock.resolve).not.toHaveBeenCalled();
  });

  it('retains successful installation status when later checks fail', async () => {
    mock.inspect.mockResolvedValueOnce(ready).mockResolvedValueOnce(failed);
    await inspectInstalledComponents();
    expect(await inspectInstalledComponents()).toEqual(ready);
    expect(await startupComponentStatus()).toEqual(ready);
  });

  it('runs a deduplicated background check without blocking startup or revoking readiness', async () => {
    await writeFile(path.join(mock.root, 'component-status.json'), JSON.stringify(ready));
    let finish!: (status: ComponentStatus) => void;
    mock.inspect.mockReturnValue(new Promise<ComponentStatus>((resolve) => { finish = resolve; }));
    const onError = vi.fn();
    silentlyInspectComponents(onError);
    silentlyInspectComponents(onError);
    expect(await startupComponentStatus()).toEqual(ready);
    expect(mock.inspect).toHaveBeenCalledTimes(1);
    finish(failed);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    // Await the queued persistence before cleaning up the directory.
    mock.inspect.mockResolvedValue(ready);
    await inspectInstalledComponents();
    expect(await startupComponentStatus()).toEqual(ready);
  });

  it('migrates existing component files without subprocess checks, including a corrupt cache', async () => {
    const model = path.join(mock.root, 'model.pt');
    await writeFile(model, 'model');
    await writeFile(path.join(mock.root, 'component-status.json'), 'broken');
    mock.resolve.mockResolvedValue({ python: 'python.exe', runtimeVariant: 'cpu', blurballWeights: model,
      tableAnalyzeWeights: model, ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe', mediaEncoder: 'libopenh264' });
    const result = await startupComponentStatus();
    expect(result.analysis.available).toBe(true);
    expect(result.media.available).toBe(true);
    expect(mock.inspect).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(mock.root, 'component-status.json'), 'utf8'))).toEqual(result);
  });

  it('does not mark a fresh installation with missing components as available', async () => {
    mock.resolve.mockResolvedValue({ python: null, runtimeVariant: null, blurballWeights: 'missing',
      tableAnalyzeWeights: 'missing', ffmpeg: null, ffprobe: null, mediaEncoder: 'unavailable' });
    const result = await startupComponentStatus();
    expect(result.analysis.available).toBe(false);
    expect(result.media.available).toBe(false);
    expect(mock.inspect).not.toHaveBeenCalled();
  });
});
