import { expect, test } from '@playwright/test';
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(process.cwd());
const sourceVideo = process.env.TTCUT_E2E_VIDEO
  ?? path.join(projectRoot, '.baseline', 'fixtures', '1-193.mp4');
const pythonPath = process.env.TTCUT_E2E_PYTHON
  ?? path.join(projectRoot, '.baseline', 'analysis-runtime', 'python.exe');
const weightsPath = process.env.TTCUT_E2E_WEIGHTS
  ?? path.join(projectRoot, '.baseline', 'weight-assets', 'TrackNet_best.pt');
const ffmpegRoot = process.env.TTCUT_E2E_FFMPEG_ROOT
  ?? path.join(projectRoot, '.baseline', 'components', 'ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1', 'bin');
const electronPath = process.env.TTCUT_E2E_ELECTRON
  ?? path.join(projectRoot, '.baseline', 'electron-dev', '43.1.1', 'electron.exe');
const fixtureDir = path.join(projectRoot, '.baseline', 'e2e');
const fixtureVideo = path.join(fixtureDir, '1-193-e2e.mp4');
const screenshotDir = path.join(projectRoot, 'output', 'playwright', 'screenshots');

const calibrationPoints = [
  [695, 303],
  [934, 315],
  [831, 413],
  [466, 381],
] as const;

async function requireFile(filePath: string): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`Required real E2E file is missing: ${filePath}`);
}

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
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url().startsWith('file:'));
    if (page) return page;
    await delay(100);
  }
  throw new Error('TTcut renderer page did not appear over CDP.');
}

async function connectCdp(port: number, child: ChildProcess, stderr: string[]): Promise<Browser> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await delay(100);
      throw new Error(`Electron exited during CDP connection (${child.exitCode}).\n${stderr.join('')}`);
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`Could not connect to Electron CDP: ${String(lastError)}\n${stderr.join('')}`);
}

async function clickSourcePoint(page: Page, x: number, y: number): Promise<void> {
  const video = page.locator('.video-surface video');
  const box = await video.boundingBox();
  if (!box) throw new Error('Calibration video has no visible bounding box.');
  const scale = Math.min(box.width / 1280, box.height / 720);
  const renderedWidth = 1280 * scale;
  const renderedHeight = 720 * scale;
  await page.mouse.click(
    box.x + (box.width - renderedWidth) / 2 + x * scale,
    box.y + (box.height - renderedHeight) / 2 + y * scale,
  );
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

test('real CUDA analysis, single-rally export, and final preview', async ({}, testInfo) => {
  test.slow();
  for (const filePath of [sourceVideo, pythonPath, weightsPath, electronPath, path.join(ffmpegRoot, 'ffmpeg.exe'), path.join(ffmpegRoot, 'ffprobe.exe')]) {
    await requireFile(filePath);
  }
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(screenshotDir, { recursive: true });
  if (!existsSync(fixtureVideo) || (await stat(fixtureVideo)).size !== (await stat(sourceVideo)).size) {
    await copyFile(sourceVideo, fixtureVideo);
  }

  const isolatedUserData = path.join(fixtureDir, `user-data-${Date.now()}`);
  const isolatedComponents = path.join(fixtureDir, 'components');
  const revealMarker = path.join(fixtureDir, `reveal-${Date.now()}.txt`);
  const nativeLog = path.join(fixtureDir, `electron-native-${Date.now()}.log`);
  await mkdir(isolatedUserData, { recursive: true });

  let electronProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const nativeStderr: string[] = [];
  const rendererErrors: string[] = [];
  try {
    const port = await freePort();
    electronProcess = spawn(electronPath, [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-logging=file',
      `--log-file=${nativeLog}`,
      projectRoot,
    ], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        TTCUT_E2E: '1',
        TTCUT_E2E_USER_DATA: isolatedUserData,
        TTCUT_E2E_COMPONENTS_ROOT: isolatedComponents,
        TTCUT_E2E_VIDEO: fixtureVideo,
        TTCUT_E2E_REVEAL_MARKER: revealMarker,
        TTCUT_PYTHON: pythonPath,
        TTCUT_TRACKNET_WEIGHTS: weightsPath,
        TTCUT_FFMPEG: path.join(ffmpegRoot, 'ffmpeg.exe'),
        TTCUT_FFPROBE: path.join(ffmpegRoot, 'ffprobe.exe'),
      },
    });
    electronProcess.stderr?.setEncoding('utf8');
    electronProcess.stderr?.on('data', (chunk: string) => nativeStderr.push(chunk));
    await waitForCdp(port, electronProcess, nativeStderr);
    browser = await connectCdp(port, electronProcess, nativeStderr);
    page = await appPage(browser);
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    await page.waitForLoadState('domcontentloaded');

    const rendererSecurity = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      nodeRequire: typeof (window as typeof window & { require?: unknown }).require,
      nodeProcess: typeof (window as typeof window & { process?: unknown }).process,
      api: typeof window.ttcut,
    }));
    expect(rendererSecurity.width).toBeGreaterThanOrEqual(1179);
    expect(rendererSecurity.width).toBeLessThanOrEqual(1181);
    expect(rendererSecurity.height).toBeGreaterThanOrEqual(759);
    expect(rendererSecurity.height).toBeLessThanOrEqual(761);
    expect(rendererSecurity).toMatchObject({ nodeRequire: 'undefined', nodeProcess: 'undefined', api: 'object' });
    await expect(page.getByRole('heading', { name: '选择比赛视频' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('TrackNetV3');
    await expect(page.locator('body')).not.toContainText('PyTorch');

    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByText('可用', { exact: true })).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByText('GPU 加速', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('.language-loader')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: '简体中文' }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '回合前时间' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '回合后时间' })).toBeVisible();
    await page.locator('.timing-setting-card').first().getByRole('button').first().click();
    await page.locator('.timing-setting-card').nth(1).getByRole('button').first().click();

    await page.getByRole('button', { name: '历史剪辑' }).click();
    await expect(page.getByRole('heading', { name: '还没有历史记录' })).toBeVisible();
    await page.getByRole('button', { name: '自动剪辑' }).click();
    await expect(page.getByRole('button', { name: '返回', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /选择 MP4 视频/ }).click();
    await expect(page.getByRole('heading', { name: '标定球桌' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1280 × 720', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择比赛视频' })).toBeVisible();
    await expect(page.getByRole('button', { name: '返回', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /选择 MP4 视频/ }).click();
    await expect(page.getByRole('heading', { name: '标定球桌' })).toBeVisible({ timeout: 30_000 });
    const calibrationVideo = page.locator('.video-surface video');
    await calibrationVideo.evaluate(async (element: HTMLVideoElement) => {
      if (element.readyState >= 1) return;
      await new Promise<void>((resolve, reject) => {
        element.addEventListener('loadedmetadata', () => resolve(), { once: true });
        element.addEventListener('error', () => reject(new Error('Input preview failed to load.')), { once: true });
      });
    });
    for (const [x, y] of calibrationPoints) await clickSourcePoint(page, x, y);
    for (let index = 1; index <= 4; index += 1) {
      await expect(page.getByRole('button', { name: `Calibration point ${index}` })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: '开始分析' })).toBeEnabled();
    await page.screenshot({ path: path.join(screenshotDir, '01-calibration.png'), fullPage: true });

    await page.getByRole('button', { name: '开始分析' }).click();
    await expect(page.getByRole('heading', { name: '正在分析视频' })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await expect(page.getByRole('heading', { name: '选择剪辑模式' })).toBeVisible({ timeout: 7 * 60 * 1_000 });
    await expect(page.getByText('已识别 47 个有效回合', { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, '02-real-analysis.png'), fullPage: true });

    await page.getByRole('button', { name: '历史剪辑' }).click();
    await expect(page.getByText(path.basename(fixtureVideo), { exact: true })).toBeVisible();
    await expect(page.getByText('47 个回合', { exact: true })).toBeVisible();
    const historyCover = page.locator('.history-cover img');
    await expect(historyCover).toBeVisible();
    await expect.poll(() => historyCover.evaluate((element: HTMLImageElement) => ({ complete: element.complete, width: element.naturalWidth }))).toMatchObject({ complete: true, width: 640 });
    const durationBox = await page.locator('.history-info > div span:last-child').boundingBox();
    const deleteBox = await page.locator('.history-delete').boundingBox();
    expect(durationBox).not.toBeNull();
    expect(deleteBox).not.toBeNull();
    expect(durationBox!.x + durationBox!.width).toBeLessThanOrEqual(deleteBox!.x - 4);
    await page.locator('.history-open').click();
    await expect(page.getByRole('heading', { name: '选择剪辑模式' })).toBeVisible();
    await expect(page.getByText('已识别 47 个有效回合', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /自定义/ }).click();
    await expect(page.getByRole('button', { name: '开始剪辑' })).toBeDisabled();
    await page.locator('tbody input[type="checkbox"]').first().check();
    const thirdRallyRow = page.locator('tbody tr').nth(2);
    await expect(thirdRallyRow).toContainText('00:00:32.065');
    await expect(thirdRallyRow).toContainText('00:00:37.937');
    await thirdRallyRow.getByRole('button', { name: '预览' }).click();
    const rallyPreview = page.getByRole('dialog', { name: '回合预览' });
    await expect(rallyPreview).toBeVisible();
    await expect(rallyPreview).toContainText('第 3 回合');
    await expect(rallyPreview).toContainText('00:00:31.065 – 00:00:38.937');
    const rallyPreviewState = await rallyPreview.locator('video').evaluate(async (element: HTMLVideoElement) => {
      if (element.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          element.addEventListener('loadedmetadata', () => resolve(), { once: true });
          element.addEventListener('error', () => reject(new Error('Rally preview failed to load.')), { once: true });
        });
      }
      if (element.seeking) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Rally preview seek did not finish.')), 10_000);
          element.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
      const startTime = element.currentTime;
      element.muted = true;
      await element.play();
      await new Promise((resolve) => setTimeout(resolve, 200));
      element.pause();
      return { controls: element.controls, readyState: element.readyState, startTime, currentTime: element.currentTime };
    });
    expect(rallyPreviewState.controls).toBe(true);
    expect(rallyPreviewState.readyState).toBeGreaterThanOrEqual(1);
    expect(rallyPreviewState.startTime).toBeGreaterThanOrEqual(31.015);
    expect(rallyPreviewState.startTime).toBeLessThanOrEqual(31.115);
    expect(rallyPreviewState.currentTime).toBeGreaterThan(rallyPreviewState.startTime);
    await rallyPreview.getByRole('button', { name: '关闭预览' }).click();
    await expect(rallyPreview).toBeHidden();
    await expect(page.getByRole('button', { name: '开始剪辑' })).toBeEnabled();
    await page.getByRole('button', { name: '开始剪辑' }).click();
    await expect(page.getByRole('heading', { name: /正在/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '成功导出' })).toBeVisible({ timeout: 2 * 60 * 1_000 });

    const outputDetails = page.locator('.output-details strong');
    const outputPath = (await outputDetails.nth(1).textContent())?.trim();
    expect(outputPath).toBeTruthy();
    const outputInfo = await stat(outputPath!);
    expect(outputInfo.size).toBeGreaterThan(100_000);
    expect(path.dirname(outputPath!)).toBe(fixtureDir);
    const partials = (await readdir(fixtureDir)).filter((name) => name.endsWith('.partial.mp4'));
    expect(partials).toEqual([]);

    const previewState = await page.locator('video.output-preview').evaluate(async (element: HTMLVideoElement) => {
      if (element.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          element.addEventListener('loadedmetadata', () => resolve(), { once: true });
          element.addEventListener('error', () => reject(new Error('Final preview failed to load.')), { once: true });
        });
      }
      element.volume = 0.25;
      element.muted = true;
      await element.play();
      await new Promise((resolve) => setTimeout(resolve, 250));
      element.pause();
      element.currentTime = Math.min(0.5, element.duration / 2);
      return { controls: element.controls, duration: element.duration, readyState: element.readyState, volume: element.volume, paused: element.paused };
    });
    expect(previewState.controls).toBe(true);
    expect(previewState.duration).toBeGreaterThan(2);
    expect(previewState.readyState).toBeGreaterThanOrEqual(1);
    expect(previewState.volume).toBe(0.25);
    expect(previewState.paused).toBe(true);

    await page.getByRole('button', { name: '在文件夹中打开' }).click();
    await expect.poll(() => existsSync(revealMarker)).toBe(true);
    expect((await readFile(revealMarker, 'utf8')).trim()).toBe(outputPath);
    await page.screenshot({ path: path.join(screenshotDir, '03-export-preview.png'), fullPage: true });

    await page.getByRole('button', { name: '剪辑下一个视频' }).click();
    await expect(page.getByRole('heading', { name: '选择比赛视频' })).toBeVisible();
    expect(rendererErrors).toEqual([]);
    await testInfo.attach('real-export', { path: outputPath!, contentType: 'video/mp4' });
  } finally {
    await writeFile(nativeLog, nativeStderr.join(''), { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    if (existsSync(nativeLog)) await testInfo.attach('electron-native-log', { path: nativeLog, contentType: 'text/plain' });
    await stopElectron(page, browser, electronProcess);
  }
});

test('first-run media component consent, install, self-test, and refresh', async ({}, testInfo) => {
  test.slow();
  const archive = path.join(projectRoot, '.baseline', 'downloads', 'ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1.zip');
  await requireFile(archive);
  await requireFile(electronPath);

  const runId = `component-install-${Date.now()}`;
  const isolatedUserData = path.join(fixtureDir, runId, 'user-data');
  const isolatedComponents = path.join(fixtureDir, runId, 'components');
  const cachedArchive = path.join(isolatedComponents, '.downloads', `${path.basename(archive)}.part`);
  const nativeLog = path.join(fixtureDir, runId, 'electron-native.log');
  await mkdir(path.dirname(cachedArchive), { recursive: true });
  await mkdir(isolatedUserData, { recursive: true });
  await copyFile(archive, cachedArchive);

  let electronProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const nativeStderr: string[] = [];
  const rendererErrors: string[] = [];
  try {
    const port = await freePort();
    electronProcess = spawn(electronPath, [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-logging=file',
      `--log-file=${nativeLog}`,
      projectRoot,
    ], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TTCUT_E2E: '1',
        TTCUT_E2E_USER_DATA: isolatedUserData,
        TTCUT_E2E_COMPONENTS_ROOT: isolatedComponents,
        TTCUT_E2E_DISABLE_DEV_COMPONENTS: '1',
      },
    });
    electronProcess.stderr?.setEncoding('utf8');
    electronProcess.stderr?.on('data', (chunk: string) => nativeStderr.push(chunk));
    await waitForCdp(port, electronProcess, nativeStderr);
    browser = await connectCdp(port, electronProcess, nativeStderr);
    page = await appPage(browser);
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByText('语言', { exact: true })).toBeVisible();
    await expect(page.getByText('zh-CN · en', { exact: true })).toHaveCount(0);
    await expect(page.getByText('导入离线组件目录', { exact: true })).toHaveCount(0);
    await expect(page.getByText('TrackNet_best.pt', { exact: true })).toHaveCount(0);
    await expect(page.getByText('ffb5469161c4bd39a5a7e745c3d13f076b2c5e575f33279ea62f1e5803245a52', { exact: true })).toHaveCount(0);
    const settingsFontSize = await page.getByRole('heading', { name: '设置', exact: true })
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(settingsFontSize).toBe('28px');
    const textStartX = async (locator: ReturnType<Page['locator']>) => locator.evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error('Expected a text node.');
      const range = document.createRange();
      range.selectNodeContents(text);
      return range.getBoundingClientRect().x;
    });
    const componentHeadingX = await textStartX(page.getByRole('heading', { name: '本地组件', exact: true }));
    const analysisHeadingX = await textStartX(page.getByText('分析组件', { exact: true }));
    expect(Math.abs(componentHeadingX - analysisHeadingX)).toBeLessThanOrEqual(1);
    await expect(page.locator('.component-row .status')).toHaveCount(2);
    await expect(page.locator('.component-row').filter({ hasText: '视频处理组件' }).locator('.status')).toHaveText('未安装');
    await expect(page.getByText('网络只用于下载你明确同意安装的固定版本组件', { exact: false })).toBeVisible();
    await page.locator('.setup-option').filter({ hasText: '安装视频处理组件' })
      .getByRole('button', { name: '同意并安装' }).click();
    await expect(page.getByText('组件安装和自检已完成。', { exact: true })).toBeVisible({ timeout: 3 * 60 * 1_000 });
    await expect(page.locator('.component-row').filter({ hasText: '视频处理组件' }).locator('.status')).toHaveText('可用');

    const status = await page.evaluate(() => window.ttcut.refreshComponents());
    expect(status.analysis.available).toBe(false);
    expect(status.media.available).toBe(true);
    expect(status.media.path).toBe(path.join(isolatedComponents, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'));
    await requireFile(path.join(isolatedComponents, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'));
    await requireFile(path.join(isolatedComponents, 'ffmpeg-8.1', 'bin', 'ffprobe.exe'));
    const installManifest = path.join(isolatedComponents, '.manifests', 'media-autobuild-2026-07-17-13-22.json');
    await requireFile(installManifest);
    expect((await stat(cachedArchive)).size).toBe(70_511_588);
    expect(rendererErrors).toEqual([]);
    const settingsScreenshot = path.join(isolatedUserData, 'settings-layout.png');
    await page.screenshot({ path: settingsScreenshot, fullPage: true });
    await testInfo.attach('settings-layout', { path: settingsScreenshot, contentType: 'image/png' });
    await testInfo.attach('component-install-manifest', { path: installManifest, contentType: 'application/json' });
  } finally {
    await writeFile(nativeLog, nativeStderr.join(''), { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    if (existsSync(nativeLog)) await testInfo.attach('component-electron-native-log', { path: nativeLog, contentType: 'text/plain' });
    await stopElectron(page, browser, electronProcess);
  }
});

test('online analysis resume followed by media component install', async ({}, testInfo) => {
  test.skip(process.env.TTCUT_RUN_ONLINE_COMPONENT_TEST !== '1', 'Set TTCUT_RUN_ONLINE_COMPONENT_TEST=1 to run the multi-gigabyte online component test.');
  test.setTimeout(35 * 60 * 1_000);
  await requireFile(electronPath);

  const liveDownloads = process.env.TTCUT_E2E_COMPONENT_CACHE_ROOT
    ?? path.join(process.env.LOCALAPPDATA ?? '', 'TTcutData', 'components', '.downloads');
  const preservedParts = [
    'ttcut-analysis-3.12.13-2.12.1-cu126.zip.part001.download',
    'ttcut-analysis-3.12.13-2.12.1-cu126.zip.part002.download',
  ];
  for (const part of preservedParts) await requireFile(path.join(liveDownloads, part));

  const runId = `online-components-${Date.now()}`;
  const isolatedRoot = path.join(fixtureDir, runId);
  const isolatedUserData = path.join(isolatedRoot, 'user-data');
  const isolatedComponents = path.join(isolatedRoot, 'components');
  const isolatedDownloads = path.join(isolatedComponents, '.downloads');
  const nativeLog = path.join(isolatedRoot, 'electron-native.log');
  await mkdir(isolatedDownloads, { recursive: true });
  await mkdir(isolatedUserData, { recursive: true });
  for (const asset of await readdir(liveDownloads)) {
    if (!asset.endsWith('.download') && !asset.endsWith('.part')) continue;
    await copyFile(path.join(liveDownloads, asset), path.join(isolatedDownloads, asset));
  }

  let electronProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const nativeStderr: string[] = [];
  const rendererErrors: string[] = [];
  try {
    const port = await freePort();
    electronProcess = spawn(electronPath, [
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-gpu',
      '--enable-logging=file',
      `--log-file=${nativeLog}`,
      projectRoot,
    ], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TTCUT_E2E: '1',
        TTCUT_E2E_USER_DATA: isolatedUserData,
        TTCUT_E2E_COMPONENTS_ROOT: isolatedComponents,
        TTCUT_E2E_DISABLE_DEV_COMPONENTS: '1',
      },
    });
    electronProcess.stderr?.setEncoding('utf8');
    electronProcess.stderr?.on('data', (chunk: string) => nativeStderr.push(chunk));
    await waitForCdp(port, electronProcess, nativeStderr);
    browser = await connectCdp(port, electronProcess, nativeStderr);
    page = await appPage(browser);
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    await page.waitForLoadState('domcontentloaded');

    const analysisOption = page.locator('.setup-option').filter({ hasText: '安装分析组件' });
    await expect(analysisOption).toBeVisible();
    await analysisOption.getByRole('button', { name: '同意并安装' }).click();
    await expect(page.locator('.setup-progress')).toBeVisible();
    await expect(page.getByText('组件安装和自检已完成。', { exact: true })).toBeVisible({ timeout: 28 * 60 * 1_000 });
    await expect(page.locator('.component-row').filter({ hasText: '分析组件' }).locator('.status')).toHaveText('可用');

    const mediaOption = page.locator('.setup-option').filter({ hasText: '安装视频处理组件' });
    await expect(mediaOption).toBeVisible();
    await mediaOption.getByRole('button', { name: '同意并安装' }).click();
    await expect(page.locator('.setup-progress')).toBeVisible();
    await expect(page.getByText('组件安装和自检已完成。', { exact: true })).toBeVisible({ timeout: 5 * 60 * 1_000 });
    await expect(page.locator('.component-row').filter({ hasText: '视频处理组件' }).locator('.status')).toHaveText('可用');

    const status = await page.evaluate(() => window.ttcut.refreshComponents());
    expect(status.analysis.available).toBe(true);
    expect(status.media.available).toBe(true);
    await requireFile(status.analysis.path!);
    await requireFile(path.join(isolatedComponents, 'models', 'TrackNet_best.pt'));
    await requireFile(status.media.path!);
    await requireFile(path.join(path.dirname(status.media.path!), 'ffprobe.exe'));
    expect(rendererErrors).toEqual([]);

    const manifests = await readdir(path.join(isolatedComponents, '.manifests'));
    expect(manifests.some((name) => name.startsWith('analysis-cu126-'))).toBe(true);
    expect(manifests.some((name) => name.startsWith('analysis-weight-'))).toBe(true);
    expect(manifests).toContain('media-autobuild-2026-07-17-13-22.json');
    await testInfo.attach('online-component-manifests', {
      body: Buffer.from(JSON.stringify(manifests, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await writeFile(nativeLog, nativeStderr.join(''), { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    if (existsSync(nativeLog)) await testInfo.attach('online-component-electron-native-log', { path: nativeLog, contentType: 'text/plain' });
    await stopElectron(page, browser, electronProcess);
  }
});
