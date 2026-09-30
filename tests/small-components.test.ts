import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => 'D:/TTcut' },
  beta: false, access: vi.fn(), media: vi.fn(),
}));
vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('node:fs/promises', () => ({ access: mocks.access, default: { access: mocks.access } }));
vi.mock('../src/main/distribution', () => ({ distributionIdentity: () => ({ independentBeta: mocks.beta }) }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: mocks.media }));
import { resolveSmallComponents } from '../src/main/small-components';

describe('Small local package resources', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('process', { ...process, platform: 'win32', resourcesPath: 'D:/Beta/resources' });
    mocks.app.isPackaged = false;
    mocks.beta = false;
    mocks.access.mockResolvedValue(undefined);
    mocks.media.mockResolvedValue({ ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' });
  });
  it('uses source worker in development', async () => {
    expect((await resolveSmallComponents()).worker).toBe(path.join('D:/TTcut', 'worker'));
  });
  it('uses staged worker in independent Beta', async () => {
    mocks.app.isPackaged = true;
    mocks.beta = true;
    const result = await resolveSmallComponents();
    expect(result.worker).toBe(path.join('D:/Beta/resources', 'worker'));
    expect(mocks.access).toHaveBeenCalledWith(path.join(result.worker, 'ttcut_worker', 'mobilenet_small.py'));
  });
  it('keeps the formal packaged distribution unavailable', async () => {
    mocks.app.isPackaged = true;
    await expect(resolveSmallComponents()).rejects.toThrow('SMALL_LOCAL_ONLY');
  });
  it('reports missing external runtime', async () => {
    mocks.access.mockRejectedValue(new Error('missing'));
    await expect(resolveSmallComponents()).rejects.toThrow('SMALL_RUNTIME_MISSING');
  });
});
