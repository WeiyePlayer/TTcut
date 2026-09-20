import { shell } from 'electron';
import { DONATION_URL, GITHUB_URL, RELEASES_URL, WEBSITE_URL } from '../shared/urls';

const publicLinks = new Set([WEBSITE_URL, GITHUB_URL, RELEASES_URL, DONATION_URL]);

export async function openExternalUrl(value: unknown, _platform: NodeJS.Platform = process.platform): Promise<void> {
  if (typeof value !== 'string') throw new Error('INVALID_REQUEST');
  if (!publicLinks.has(value)) throw new Error('EXTERNAL_URL_REJECTED');
  await shell.openExternal(value);
}
