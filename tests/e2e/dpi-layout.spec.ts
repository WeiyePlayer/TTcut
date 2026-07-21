import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(process.cwd());
const electronPath = process.env.TTCUT_E2E_ELECTRON
  ?? path.join(projectRoot, '.baseline', 'electron-dev', '43.1.1', 'electron.exe');
const outputRoot = path.join(projectRoot, 'output', 'playwright', 'screenshots');

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

async function waitForCdp(port: number, child: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before CDP was ready (${child.exitCode}).\n${stderr.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Electron has not opened the debugging endpoint yet.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for Electron CDP.\n${stderr.join('')}`);
}

async function appPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('file:'));
    if (page) return page;
    await delay(100);
  }
  throw new Error('TTcut renderer page did not appear over CDP.');
}

async function stopElectron(page: Page | null, browser: Browser | null, child: ChildProcess | null): Promise<void> {
  if (page && !page.isClosed()) {
    const requestClose = page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => undefined);
    await Promise.race([requestClose, delay(3_000)]);
  }
  if (browser) {
    const closeBrowser = browser.close().catch(() => undefined);
    await Promise.race([closeBrowser, delay(3_000)]);
  }
  if (child && child.exitCode === null) {
    await Promise.race([once(child, 'exit'), delay(5_000)]);
    if (child.exitCode === null) child.kill();
  }
}

for (const scale of [1.25, 1.5, 2] as const) {
  const percent = Math.round(scale * 100);
  test(`settings remain usable at ${percent}% DPI and minimum window size`, async () => {
    if (!existsSync(electronPath)) throw new Error(`Required Electron runtime is missing: ${electronPath}`);
    await mkdir(outputRoot, { recursive: true });
    const isolatedRoot = path.join(projectRoot, '.baseline', 'e2e', `dpi-${percent}-${Date.now()}`);
    const port = await freePort();
    const stderr: string[] = [];
    let child: ChildProcess | null = null;
    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      child = spawn(electronPath, [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        '--no-sandbox',
        '--disable-gpu',
        `--force-device-scale-factor=${scale}`,
        projectRoot,
      ], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TTCUT_E2E: '1',
          TTCUT_E2E_USER_DATA: path.join(isolatedRoot, 'user-data'),
          TTCUT_E2E_COMPONENTS_ROOT: path.join(isolatedRoot, 'components'),
          TTCUT_E2E_DISABLE_DEV_COMPONENTS: '1',
        },
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
      await waitForCdp(port, child, stderr);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = await appPage(browser);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('.settings-page')).toBeVisible();
      await expect(page.locator('.setup-option').first().locator('.setup-network-hint')).toHaveText('打开虚拟网卡或 TUN 模式加快下载速度');
      await expect(page.locator('.setup-manual .setup-network-hint')).toHaveCount(0);

      await page.evaluate(() => window.resizeTo(840, 520));
      await expect.poll(() => page!.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(839);
      await expect.poll(() => page!.evaluate(() => window.innerHeight)).toBeGreaterThanOrEqual(519);

      const layout = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Missing layout element: ${selector}`);
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const main = document.querySelector('.main-content');
        if (!(main instanceof HTMLElement)) throw new Error('Missing main content.');
        return {
          devicePixelRatio: window.devicePixelRatio,
          width: window.innerWidth,
          height: window.innerHeight,
          documentScrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          mainScrollsVertically: main.scrollHeight > main.clientHeight,
          titlebar: rect('.titlebar'),
          controls: rect('.window-controls'),
          sidebar: rect('.sidebar'),
          main: rect('.main-content'),
          setup: rect('.setup-card'),
        };
      });

      expect(layout.devicePixelRatio).toBeCloseTo(scale, 1);
      expect(layout.width).toBeGreaterThanOrEqual(839);
      expect(layout.width).toBeLessThanOrEqual(843);
      expect(layout.height).toBeGreaterThanOrEqual(519);
      expect(layout.height).toBeLessThanOrEqual(523);
      expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.width);
      expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.width);
      expect(layout.titlebar.right).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.controls.right).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.sidebar.bottom).toBeLessThanOrEqual(layout.height + 1);
      expect(layout.main.right).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.main.width).toBeGreaterThanOrEqual(655);
      expect(layout.setup.left).toBeGreaterThanOrEqual(layout.main.left);
      expect(layout.setup.right).toBeLessThanOrEqual(layout.main.right);
      expect(layout.mainScrollsVertically).toBe(true);

      await page.locator('.main-content').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.locator('.actions-card')).toBeVisible();
      await page.screenshot({ path: path.join(outputRoot, `dpi-${percent}.png`), fullPage: true });
    } finally {
      await stopElectron(page, browser, child);
    }
  });
}
