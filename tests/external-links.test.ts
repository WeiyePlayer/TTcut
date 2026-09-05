// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { COMPONENT_ASSETS_RELEASE_URL, DONATION_URL, GITHUB_URL, RELEASES_URL, WEBSITE_URL } from '../src/shared/urls';

const mocks = vi.hoisted(() => ({ open: vi.fn(), catalog: vi.fn() }));
vi.mock('electron', () => ({ shell: { openExternal: mocks.open } }));
vi.mock('../src/main/component-catalog', () => ({ loadComponentCatalog: mocks.catalog }));
import { openExternalUrl } from '../src/main/external-links';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue(undefined);
});

it.each(['darwin', 'win32'] as const)('opens public links on %s without a component catalog', async platform => {
  mocks.catalog.mockRejectedValue(new Error('catalog unavailable'));
  for (const url of [WEBSITE_URL, GITHUB_URL, DONATION_URL, RELEASES_URL]) {
    await openExternalUrl(url, platform);
    expect(mocks.open).toHaveBeenLastCalledWith(url);
  }
  expect(mocks.catalog).not.toHaveBeenCalled();
});

it.each([null, 42, {}, 'file:///tmp/test', 'javascript:alert(1)', GITHUB_URL + '/unlisted', COMPONENT_ASSETS_RELEASE_URL])('rejects unapproved Mac targets: %s', async value => {
  await expect(openExternalUrl(value, 'darwin')).rejects.toThrow(typeof value === 'string' ? 'EXTERNAL_URL_REJECTED' : 'INVALID_REQUEST');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.catalog).not.toHaveBeenCalled();
});

it('retains catalog-approved Windows links and rejects other targets', async () => {
  const url = 'https://example.com/component-download';
  mocks.catalog.mockResolvedValue({ analysis_runtime: {}, ffmpeg: { url }, ffmpeg_x264: {} });
  await openExternalUrl(url, 'win32');
  expect(mocks.open).toHaveBeenCalledWith(url);
  await expect(openExternalUrl('https://example.com/unlisted', 'win32')).rejects.toThrow('EXTERNAL_URL_REJECTED');
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it('propagates system browser failures', async () => {
  mocks.open.mockRejectedValue(new Error('browser unavailable'));
  await expect(openExternalUrl(WEBSITE_URL, 'darwin')).rejects.toThrow('browser unavailable');
});
