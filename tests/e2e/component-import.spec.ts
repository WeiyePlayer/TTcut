import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(process.cwd());
const electronPath = process.env.TTCUT_E2E_ELECTRON
  ?? path.join(projectRoot, '.baseline', 'electron-dev', '43.1.1', 'electron.exe');
const componentSource = process.env.TTCUT_COMPONENT_IMPORT_SOURCE ?? 'D:\\DOCUMENTS\\test';
const componentsRoot = process.env.TTCUT_COMPONENT_IMPORT_ROOT
  ?? path.join(projectRoot, '.baseline', 'e2e-component-import-components');
const userData = path.join(projectRoot, 'output', 'playwright', 'component-import-user-data');
const screenshot = path.join(projectRoot, 'output', 'playwright', 'component-import-settings.png');
const importFiles = [
  'TrackNet_best.pt',
  'ttcut-analysis-3.12.13-2.12.1-cpu.zip',
  'ttcut-analysis-3.12.13-2.12.1-cu126.zip.part001',
  'ttcut-analysis-3.12.13-2.12.1-cu126.zip.part002',
  'ttcut-analysis-3.12.13-2.12.1-cu126.zip.part003',
  'ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip',
].map((name) => path.join(componentSource, name));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a CDP port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForPage(port: number, child: ChildProcess, stderr: string[]): Promise<{ browser: Browser; page: Page }> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before startup (${child.exitCode}).\n${stderr.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        while (Date.now() < deadline) {
          const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith('file:'));
          if (page) return { browser, page };
          await delay(100);
        }
      }
    } catch {
      // Electron is still starting.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for TTcut.\n${stderr.join('')}`);
}

test('imports and configures the real local components', async () => {
  test.setTimeout(30 * 60 * 1_000);
  expect(existsSync(electronPath), `Missing Electron runtime: ${electronPath}`).toBe(true);
  for (const file of importFiles) expect(existsSync(file), `Missing import asset: ${file}`).toBe(true);
  await mkdir(userData, { recursive: true });

  const port = await freePort();
  const stderr: string[] = [];
  const child = spawn(electronPath, [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-sandbox',
    '--disable-gpu',
    projectRoot,
  ], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TTCUT_E2E: '1',
      TTCUT_E2E_USER_DATA: userData,
      TTCUT_E2E_COMPONENTS_ROOT: componentsRoot,
      TTCUT_E2E_DISABLE_DEV_COMPONENTS: '1',
      TTCUT_E2E_COMPONENT_IMPORT_FILES: JSON.stringify(importFiles),
    },
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));

  let browser: Browser | null = null;
  let page: Page | null = null;
  try {
    ({ browser, page } = await waitForPage(port, child, stderr));
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: '导入组件', exact: true }).click();
    await expect(page.locator('.setup-progress')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.setup-outcome.success')).toBeVisible({ timeout: 30 * 60 * 1_000 });

    const status = await page.evaluate(() => window.ttcut.refreshComponents());
    expect(status.analysis.available).toBe(true);
    expect(status.media.available).toBe(true);
    expect(status.analysis.path).toContain(path.join('analysis-runtime', '3.12.13-2.12.1'));
    expect(status.media.path).toBe(path.join(componentsRoot, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'));
    expect(existsSync(path.join(componentsRoot, 'models', 'TrackNet_best.pt'))).toBe(true);
    expect(existsSync(path.join(componentsRoot, 'analysis-runtime', '3.12.13-2.12.1', 'cpu', 'python.exe'))).toBe(true);
    expect(existsSync(path.join(componentsRoot, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'))).toBe(true);
    expect(existsSync(path.join(componentsRoot, '.manifests', 'media-autobuild-2026-07-17-13-22.json'))).toBe(true);
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    if (page && !page.isClosed()) await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (child.exitCode === null) child.kill();
  }
});
