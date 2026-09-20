import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentStatus } from '../src/shared/contracts';

const mock = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('../src/main/components', () => ({ inspectComponents: mock.inspect }));
import { inspectInstalledComponents, silentlyInspectComponents, startupComponentStatus } from '../src/main/component-status';

const ready: ComponentStatus = {
  analysis: { available: true, version: 'Python 3.12.13 / ONNX Runtime 1.24.3', path: 'python.exe', acceleration: 'directml', detail: null },
  media: { available: true, version: 'ffmpeg', path: 'ffmpeg.exe', active_encoder: 'libx264', x264_available: true, detail: null },
};

beforeEach(() => { mock.inspect.mockReset(); });

describe('bundled component readiness', () => {
  it('rechecks immutable bundled components for startup and manual inspection', async () => {
    mock.inspect.mockResolvedValue(ready);
    await expect(startupComponentStatus()).resolves.toEqual(ready);
    await expect(inspectInstalledComponents()).resolves.toEqual(ready);
    expect(mock.inspect).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a background recheck and reports each damaged component', async () => {
    let finish!: (status: ComponentStatus) => void;
    mock.inspect.mockReturnValue(new Promise<ComponentStatus>((resolve) => { finish = resolve; }));
    const onError = vi.fn();
    silentlyInspectComponents(onError);
    silentlyInspectComponents(onError);
    expect(mock.inspect).toHaveBeenCalledTimes(1);
    finish({
      analysis: { ...ready.analysis, available: false, detail: 'ANALYSIS_RUNTIME_SELF_TEST_FAILED' },
      media: { ...ready.media, available: false, detail: 'MEDIA_RUNTIME_MISSING' },
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
  });
});
