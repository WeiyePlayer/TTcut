import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { validateImportFiles } from '../src/main/component-import';

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
    expect(catalog.ffmpeg).toMatchObject({
      variant: 'win64-lgpl-shared-8.1',
      install_directory: 'ffmpeg-8.1',
      sha256: 'fcbf0f5c58fec3e516e35ba26d81bc6cbaea09dde76bffd151fa93c0316b0b50',
    });
    expect(catalog.ffmpeg.required_build_flags).toEqual([
      '--enable-shared', '--enable-libopenh264', '--disable-libx264', '--disable-libx265',
    ]);
    expect(catalog.ffmpeg.required_encoders).toEqual(['libopenh264', 'aac']);
    expect(catalog.ffmpeg_x264).toMatchObject({
      variant: 'win64-gpl',
      install_directory: 'ffmpeg-x264-N-125716-g1b1f602699',
      size_bytes: 168_733_210,
      sha256: '6dcf685c2fea98221b3f179961165e9c31f55bead576c4479ae4549858fbf826',
    });

    const setup = await componentSetupInfo();
    expect(setup.analysis_offer?.available_for_download).toBe(process.platform === 'win32');
    expect(setup.analysis_offer?.download_size_bytes).toBe(3_172_507_599);
    expect(setup.media_offer?.download_size_bytes).toBe(70_511_588);
    expect(setup.x264_manual_offer).toMatchObject({
      id: 'media-x264',
      filename: 'ffmpeg-N-125716-g1b1f602699-win64-gpl.zip',
      download_size_bytes: 168_733_210,
    });
    expect(setup).not.toHaveProperty('offline_import_available');
  });

  it.skipIf(!process.env.TTCUT_X264_COMPONENT)('validates the downloaded fixed x264 archive', async () => {
    const archive = path.resolve(process.env.TTCUT_X264_COMPONENT!);
    expect(existsSync(archive)).toBe(true);
    const files = await validateImportFiles([archive], await loadComponentCatalog());
    expect(files).toEqual([expect.objectContaining({ kind: 'media-x264', sourcePath: archive })]);
  });
});
