import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
}));

let loadComponentCatalog: typeof import('../src/main/component-catalog').loadComponentCatalog;
let componentSetupInfo: typeof import('../src/main/component-catalog').componentSetupInfo;

beforeAll(async () => {
  ({ loadComponentCatalog, componentSetupInfo } = await import('../src/main/component-catalog'));
});

describe('production component catalog', () => {
  it('parses all fixed runtime variants and every immutable part', async () => {
    const catalog = await loadComponentCatalog();
    expect(catalog.analysis_runtime.assets.map((asset) => asset.variant)).toEqual(['cpu', 'cu126', 'cu132']);
    expect(catalog.analysis_runtime.assets[0]?.parts).toHaveLength(1);
    expect(catalog.analysis_runtime.assets[1]?.parts).toHaveLength(3);
    expect(catalog.analysis_runtime.assets.slice(0, 2).flatMap((asset) => asset.parts).every((part) => (
      part.url.includes('/analysis-3.12.13-2.12.1-r1/') && /^[a-f0-9]{64}$/.test(part.sha256)
    ))).toBe(true);
    expect(catalog.analysis_runtime.assets[2]?.parts.every((part) => (
      part.url.includes('/analysis-3.12.13-2.12.1-cu132-r1/') && /^[a-f0-9]{64}$/.test(part.sha256)
    ))).toBe(true);
    expect(catalog.tracknet_weight).toMatchObject({
      downloadable: true,
      release_tag: 'tracknet-weight-1.0.0',
      size_bytes: 136_191_005,
      install_directory: 'models',
    });
    expect(catalog.tracknet_weight.url).toContain('/tracknet-weight-1.0.0/TrackNet_best.pt');

    const setup = await componentSetupInfo();
    expect(setup.analysis_offer?.available_for_download).toBe(process.platform === 'win32');
    expect(setup.analysis_offer?.download_size_bytes).toBe(3_172_507_599);
    expect(setup).not.toHaveProperty('offline_import_available');
  });
});
