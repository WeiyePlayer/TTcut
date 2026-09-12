import { shell } from 'electron';
import { loadComponentCatalog } from './component-catalog';
import { COMPONENT_ASSETS_RELEASE_URL, DONATION_URL, GITHUB_URL, RELEASES_URL, WEBSITE_URL } from '../shared/urls';

const publicLinks = new Set([WEBSITE_URL, GITHUB_URL, RELEASES_URL, DONATION_URL]);

export async function openExternalUrl(value: unknown, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (typeof value !== 'string') throw new Error('INVALID_REQUEST');
  // About/support links are independent of downloadable Windows components.
  if (!publicLinks.has(value)) {
    if (platform === 'darwin') throw new Error('EXTERNAL_URL_REJECTED');
    const catalog = await loadComponentCatalog();
    const componentLinks = new Set([
      COMPONENT_ASSETS_RELEASE_URL,
      catalog.analysis_runtime.license_url,
      catalog.ffmpeg.license_url,
      catalog.ffmpeg.url,
      catalog.ffmpeg_x264.license_url,
      catalog.ffmpeg_x264.source_url,
    ]);
    if (!componentLinks.has(value)) throw new Error('EXTERNAL_URL_REJECTED');
  }
  await shell.openExternal(value);
}
