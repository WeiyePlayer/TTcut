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
const blurballWeightsPath = process.env.TTCUT_E2E_BLURBALL_WEIGHTS
  ?? path.join(projectRoot, 'resources', 'models', 'blurball_best.pt');
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

async function createShortVideo(inputPath: string, outputPath: string): Promise<void> {
  const stderr: string[] = [];
  const child = spawn(path.join(ffmpegRoot, 'ffmpeg.exe'), [
    '-y', '-ss', '0', '-i', inputPath, '-t', '3',
    '-vf', 'crop=640:360:350:220', '-an', '-c:v', 'libopenh264', '-b:v', '4M', outputPath,
  ], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Could not create short E2E video (${code}).\n${stderr.join('')}`);
}

async function createCalibrationFailureVideo(outputPath: string): Promise<void> {
  const stderr: string[] = [];
  const child = spawn(path.join(ffmpegRoot, 'ffmpeg.exe'), [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30:d=3',
    '-an', '-c:v', 'libopenh264', '-b:v', '1M', outputPath,
  ], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`Could not create calibration-failure E2E video (${code}).\n${stderr.join('')}`);
}

test('real CUDA analysis, single-rally export, and final preview', async ({}, testInfo) => {
  test.slow();
  for (const filePath of [sourceVideo, pythonPath, blurballWeightsPath, electronPath, path.join(ffmpegRoot, 'ffmpeg.exe'), path.join(ffmpegRoot, 'ffprobe.exe')]) {
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
        TTCUT_BLURBALL_WEIGHTS: blurballWeightsPath,
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
    await expect(page.getByRole('heading', { name: '导出方式', exact: true })).toHaveCount(0);
    await expect(page.getByText('可用', { exact: true })).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByText('GPU 加速', { exact: true })).toBeVisible();
    await page.locator('label[for="settings-language-1"]').click();
    await expect(page.locator('.language-loader')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Export strategy', exact: true })).toHaveCount(0);
    await page.locator('label[for="settings-language-0"]').click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '回合前时间' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '回合后时间' })).toBeVisible();
    await page.locator('label[for="settings-pre-roll-0"]').click();
    await page.locator('label[for="settings-post-roll-0"]').click();
    const analysisPrecision = page.getByRole('radiogroup', { name: '分析精度' });
    await expect(analysisPrecision.getByRole('radio', { name: '默认' })).toBeChecked();
    await page.locator('label[for="settings-blurball-mode-1"]').click();
    await expect(analysisPrecision.getByRole('radio', { name: '高精' })).toBeChecked();

    await page.getByRole('button', { name: '历史剪辑' }).click();
    await expect(page.getByRole('heading', { name: '还没有历史记录' })).toBeVisible();
    await page.getByRole('button', { name: '自动剪辑' }).click();
    await expect(page.getByRole('button', { name: '返回', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '选择或将文件拖到这里' }).click();
    await expect(page.getByRole('heading', { name: '标定球桌' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1280 × 720', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择比赛视频' })).toBeVisible();
    await expect(page.getByRole('button', { name: '返回', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '选择或将文件拖到这里' }).click();
    await expect(page.getByRole('heading', { name: '标定球桌' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.automatic-calibration')).toBeVisible();
    await expect(page.locator('.video-surface')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始分析' })).toBeEnabled();
    await page.screenshot({ path: path.join(screenshotDir, '01-calibration.png'), fullPage: true });

    await page.getByRole('button', { name: '开始分析' }).click();
    await expect(page.getByRole('heading', { name: '正在分析视频' })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    const automaticCalibrationNotice = page.getByText('自动标定不可靠，请改用手动标定。', { exact: true });
    await expect(page.getByRole('heading', { name: '选择剪辑模式' })).toBeVisible({ timeout: 7 * 60 * 1_000 });
    await expect(automaticCalibrationNotice).toHaveCount(0);
    const recognizedRalliesText = page.getByText(/^已识别 \d+ 个有效回合$/, { exact: true });
    await expect(recognizedRalliesText).toBeVisible();
    const recognizedRallies = Number((await recognizedRalliesText.textContent())?.match(/\d+/)?.[0]);
    expect(recognizedRallies).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(screenshotDir, '02-real-analysis.png'), fullPage: true });

    await page.getByRole('button', { name: '历史剪辑' }).click();
    await expect(page.getByText(path.basename(fixtureVideo), { exact: true })).toBeVisible();
    await expect(page.getByText(`${recognizedRallies} 个回合`, { exact: true })).toBeVisible();
    const historyCover = page.locator('.history-cover img');
    await expect(historyCover).toBeVisible();
    await expect.poll(() => historyCover.evaluate((element: HTMLImageElement) => ({ complete: element.complete, width: element.naturalWidth }))).toMatchObject({ complete: true, width: 640 });
    const historyCoverLayout = await historyCover.evaluate((element: HTMLImageElement) => {
      const cover = element.parentElement;
      if (!cover) throw new Error('History cover container is missing.');
      const imageRect = element.getBoundingClientRect();
      const coverRect = cover.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        objectFit: style.objectFit,
        position: style.position,
        imageRect: { x: imageRect.x, y: imageRect.y, width: imageRect.width, height: imageRect.height },
        coverRect: { x: coverRect.x, y: coverRect.y, width: coverRect.width, height: coverRect.height },
      };
    });
    expect(historyCoverLayout).toMatchObject({ objectFit: 'contain', position: 'absolute' });
    expect(Math.abs(historyCoverLayout.imageRect.x - historyCoverLayout.coverRect.x)).toBeLessThan(1);
    expect(Math.abs(historyCoverLayout.imageRect.y - historyCoverLayout.coverRect.y)).toBeLessThan(1);
    expect(Math.abs(historyCoverLayout.imageRect.width - historyCoverLayout.coverRect.width)).toBeLessThan(1);
    expect(Math.abs(historyCoverLayout.imageRect.height - historyCoverLayout.coverRect.height)).toBeLessThan(1);
    const durationBox = await page.locator('.history-info > div span:last-child').boundingBox();
    const deleteBox = await page.locator('.history-delete').boundingBox();
    expect(durationBox).not.toBeNull();
    expect(deleteBox).not.toBeNull();
    expect(durationBox!.x + durationBox!.width).toBeLessThanOrEqual(deleteBox!.x - 4);
    await page.locator('.history-open').click();
    await expect(page.getByRole('heading', { name: '选择剪辑模式' })).toBeVisible();
    await expect(page.getByText(`已识别 ${recognizedRallies} 个有效回合`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /自定义/ }).click();
    const customMonitor = page.locator('.custom-monitor video');
    await expect(customMonitor).toBeVisible();
    await customMonitor.evaluate(async (element: HTMLVideoElement) => {
      if (element.readyState >= 1) return;
      await new Promise<void>((resolve, reject) => {
        element.addEventListener('loadedmetadata', () => resolve(), { once: true });
        element.addEventListener('error', () => reject(new Error('Custom monitor failed to load.')), { once: true });
      });
    });
    await expect(customMonitor).toHaveCSS('object-fit', 'contain');
    await expect(customMonitor).toHaveCSS('object-position', '50% 50%');
    await expect(customMonitor).toHaveCSS('position', 'absolute');
    await expect(page.locator('.custom-monitor')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect.poll(() => customMonitor.evaluate((element: HTMLVideoElement) => element.controls)).toBe(false);
    const customLayout = await page.evaluate(() => {
      const list = document.querySelector('.custom-rally-list')?.getBoundingClientRect();
      const monitor = document.querySelector('.custom-monitor')?.getBoundingClientRect();
      const timeline = document.querySelector('.custom-timeline')?.getBoundingClientRect();
      const timelineTrack = document.querySelector('.timeline-track-window')?.getBoundingClientRect();
      const exportLauncher = document.querySelector('.floating-launch-start')?.getBoundingClientRect();
      const timelineActions = document.querySelector('.custom-timeline-actions')?.getBoundingClientRect();
      const pageBounds = document.querySelector('.custom-cut-page')?.getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
      const titlebar = document.querySelector('.titlebar')?.getBoundingClientRect();
      const main = document.querySelector('.main-content');
      const pageRoot = document.querySelector('.custom-cut-page');
      const listViewport = document.querySelector('.custom-rally-list .table-scroll');
      return {
        listLeft: list?.left ?? 0,
        listRight: list?.right ?? 0,
        monitorLeft: monitor?.left ?? 0,
        monitorRight: monitor?.right ?? 0,
        timelineLeft: timeline?.left ?? 0,
        timelineRight: timeline?.right ?? 0,
        timelineTrackBottom: timelineTrack?.bottom ?? 0,
        exportLauncherTop: exportLauncher?.top ?? 0,
        exportLauncherRightInset: pageBounds && exportLauncher ? pageBounds.right - exportLauncher.right : 0,
        exportLauncherBottomInset: pageBounds && exportLauncher ? pageBounds.bottom - exportLauncher.bottom : 0,
        timelineActionsTop: timelineActions?.top ?? 0,
        sidebarWidth: sidebar?.width ?? 0,
        titlebarLeft: titlebar?.left ?? 0,
        mainOverflow: main ? getComputedStyle(main).overflow : '',
        pageOverflow: pageRoot ? getComputedStyle(pageRoot).overflow : '',
        listOverflow: listViewport ? getComputedStyle(listViewport).overflowY : '',
        pageFits: pageRoot ? pageRoot.scrollHeight <= pageRoot.clientHeight + 1 && pageRoot.scrollWidth <= pageRoot.clientWidth + 1 : false,
      };
    });
    expect(customLayout.monitorLeft).toBeGreaterThan(customLayout.listRight);
    expect(customLayout.timelineLeft).toBeCloseTo(customLayout.monitorLeft, 0);
    expect(customLayout.timelineRight).toBeCloseTo(customLayout.monitorRight, 0);
    expect(customLayout.timelineTrackBottom).toBeLessThanOrEqual(customLayout.exportLauncherTop + 1);
    expect(customLayout.timelineActionsTop).toBeGreaterThanOrEqual(customLayout.timelineTrackBottom);
    expect(customLayout.exportLauncherRightInset).toBeCloseTo(customLayout.exportLauncherBottomInset, 0);
    expect(customLayout.titlebarLeft).toBeCloseTo(customLayout.sidebarWidth, 0);
    expect(customLayout.mainOverflow).toBe('hidden');
    expect(customLayout.pageOverflow).toBe('hidden');
    expect(customLayout.listOverflow).toBe('auto');
    expect(customLayout.pageFits).toBe(true);
    const monitorRatio = await customMonitor.evaluate((element) => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
    expect(monitorRatio).toBeCloseTo(16 / 9, 2);
    await customMonitor.evaluate((element: HTMLVideoElement) => {
      element.muted = true;
      element.pause();
      document.body.focus();
    });
    await page.keyboard.press('Space');
    await expect.poll(() => customMonitor.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(() => customMonitor.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    await expect(page.locator('.timeline-toolbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '增加回合' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '删除回合' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: '增加回合' }).click();
    await expect(page.getByRole('button', { name: '增加回合' })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.custom-workspace').click({ button: 'right' });
    await expect(page.getByRole('button', { name: '增加回合' })).toHaveAttribute('aria-pressed', 'false');
    const timelineViewport = page.locator('.timeline-viewport');
    const timelineAppearance = await page.evaluate(() => {
      const viewport = document.querySelector('.timeline-viewport')!;
      const track = document.querySelector('.timeline-track-window')!;
      const viewportStyle = getComputedStyle(viewport);
      const trackStyle = getComputedStyle(track);
      return {
        scrollbarWidth: viewportStyle.scrollbarWidth,
        overflowX: viewportStyle.overflowX,
        viewportHeight: viewport.getBoundingClientRect().height,
        trackHeight: track.getBoundingClientRect().height,
        trackRadius: trackStyle.borderRadius,
        trackBackground: trackStyle.backgroundColor,
      };
    });
    expect(timelineAppearance).toMatchObject({
      scrollbarWidth: 'none', overflowX: 'auto', viewportHeight: 78, trackHeight: 42, trackRadius: '999px',
    });
    expect(timelineAppearance.trackBackground).not.toBe('rgba(0, 0, 0, 0)');
    const timelineBox = await timelineViewport.boundingBox();
    expect(timelineBox).not.toBeNull();
    await page.mouse.move(timelineBox!.x + timelineBox!.width / 2, timelineBox!.y + timelineBox!.height / 2);
    const initialZoom = Number(await timelineViewport.getAttribute('data-zoom'));
    const layoutBeforeTimelineZoom = await page.evaluate(() => {
      const monitor = document.querySelector('.custom-monitor')!.getBoundingClientRect();
      const video = document.querySelector('.custom-monitor video')!.getBoundingClientRect();
      return {
        monitorWidth: monitor.width,
        monitorHeight: monitor.height,
        videoWidth: video.width,
        videoHeight: video.height,
        devicePixelRatio: window.devicePixelRatio,
        visualScale: window.visualViewport?.scale ?? 1,
      };
    });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -360);
    await page.keyboard.up('Control');
    await expect.poll(async () => Number(await timelineViewport.getAttribute('data-zoom'))).toBeGreaterThan(initialZoom);
    const layoutAfterTimelineZoom = await page.evaluate(() => {
      const monitor = document.querySelector('.custom-monitor')!.getBoundingClientRect();
      const video = document.querySelector('.custom-monitor video')!.getBoundingClientRect();
      return {
        monitorWidth: monitor.width,
        monitorHeight: monitor.height,
        videoWidth: video.width,
        videoHeight: video.height,
        devicePixelRatio: window.devicePixelRatio,
        visualScale: window.visualViewport?.scale ?? 1,
      };
    });
    expect(layoutAfterTimelineZoom.monitorWidth).toBeCloseTo(layoutBeforeTimelineZoom.monitorWidth, 3);
    expect(layoutAfterTimelineZoom.monitorHeight).toBeCloseTo(layoutBeforeTimelineZoom.monitorHeight, 3);
    expect(layoutAfterTimelineZoom.videoWidth).toBeCloseTo(layoutBeforeTimelineZoom.videoWidth, 3);
    expect(layoutAfterTimelineZoom.videoHeight).toBeCloseTo(layoutBeforeTimelineZoom.videoHeight, 3);
    expect(layoutAfterTimelineZoom.devicePixelRatio).toBe(layoutBeforeTimelineZoom.devicePixelRatio);
    expect(layoutAfterTimelineZoom.visualScale).toBe(layoutBeforeTimelineZoom.visualScale);
    const zoomedTrackGeometry = await page.evaluate(() => {
      const viewport = document.querySelector('.timeline-viewport')!.getBoundingClientRect();
      const frame = document.querySelector('.timeline-track-window')!.getBoundingClientRect();
      const content = document.querySelector('.timeline-track')!.getBoundingClientRect();
      return {
        viewportRight: viewport.right,
        frameRight: frame.right,
        frameWidth: frame.width,
        contentWidth: content.width,
        frameOverflow: getComputedStyle(document.querySelector('.timeline-track-window')!).overflow,
      };
    });
    expect(zoomedTrackGeometry.frameRight).toBeCloseTo(zoomedTrackGeometry.viewportRight, 3);
    expect(zoomedTrackGeometry.contentWidth).toBeGreaterThan(zoomedTrackGeometry.frameWidth);
    expect(zoomedTrackGeometry.frameOverflow).toBe('hidden');
    const overflowState = await timelineViewport.evaluate((element: HTMLDivElement) => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft,
    }));
    expect(overflowState.scrollWidth).toBeGreaterThan(overflowState.clientWidth);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => timelineViewport.evaluate((element: HTMLDivElement) => element.scrollLeft)).toBeGreaterThan(overflowState.scrollLeft);
    const afterVerticalWheel = await timelineViewport.evaluate((element: HTMLDivElement) => element.scrollLeft);
    await page.mouse.wheel(-40, 0);
    await expect.poll(() => timelineViewport.evaluate((element: HTMLDivElement) => element.scrollLeft)).toBeLessThan(afterVerticalWheel);
    await expect(page.locator('.timeline-clip')).toHaveCount(recognizedRallies);
    const deletionCandidate = await page.evaluate(() => {
      const viewport = document.querySelector('.timeline-viewport') as HTMLDivElement | null;
      const duration = Number(document.querySelector('.timeline-playhead')?.getAttribute('aria-valuemax'));
      if (!viewport || !Number.isFinite(duration)) return null;
      const oneSecond = Math.max(viewport.clientWidth, viewport.scrollWidth) / duration;
      const clips = [...document.querySelectorAll<HTMLDivElement>('.timeline-clip')].reverse();
      const candidate = clips.find((clip) => Number.parseFloat(clip.style.width) >= oneSecond * 1.5);
      if (!candidate) return null;
      return { clipId: candidate.dataset.clipId };
    });
    expect(deletionCandidate?.clipId).toBeTruthy();
    await page.getByRole('button', { name: '删除回合' }).click();
    const removedDetectedClip = page.locator(`.timeline-clip[data-clip-id="${deletionCandidate!.clipId}"]`);
    await removedDetectedClip.hover();
    await expect(removedDetectedClip).toHaveClass(/delete-target/);
    await removedDetectedClip.click();
    await expect(page.locator('.timeline-clip')).toHaveCount(recognizedRallies - 1);
    const insertionTarget = await page.evaluate(() => {
      const viewport = document.querySelector('.timeline-viewport') as HTMLDivElement | null;
      const track = document.querySelector('.timeline-track-window');
      const duration = Number(document.querySelector('.timeline-playhead')?.getAttribute('aria-valuemax'));
      if (!viewport || !track || !Number.isFinite(duration)) return null;
      const frame = track.getBoundingClientRect();
      const oneSecond = viewport.scrollWidth / duration;
      const clips = [...document.querySelectorAll<HTMLElement>('.timeline-clip')]
        .map((clip) => clip.getBoundingClientRect())
        .map((box) => ({ left: Math.max(frame.left, box.left), right: Math.min(frame.right, box.right) }))
        .filter((box) => box.right > box.left)
        .sort((left, right) => left.left - right.left);
      let gapStart = frame.left;
      for (const clip of [...clips, { left: frame.right, right: frame.right }]) {
        if (clip.left - gapStart >= oneSecond) {
          return { x: gapStart + (clip.left - gapStart - oneSecond) / 2, y: frame.top + frame.height / 2 };
        }
        gapStart = Math.max(gapStart, clip.right);
      }
      return null;
    });
    expect(insertionTarget).not.toBeNull();
    await page.getByRole('button', { name: '增加回合' }).click();
    await page.mouse.click(insertionTarget!.x, insertionTarget!.y);
    await expect(page.locator('.timeline-clip')).toHaveCount(recognizedRallies);
    const manualClip = page.locator('.timeline-clip[data-clip-id^="manual_"]');
    await expect(manualClip).toHaveCount(1);
    await page.getByRole('button', { name: '删除回合' }).click();
    await manualClip.hover();
    await expect(manualClip).toHaveClass(/delete-target/);
    await manualClip.click();
    await expect(page.locator('.timeline-clip')).toHaveCount(recognizedRallies - 1);
    await page.locator('.custom-workspace').click({ button: 'right' });
    await expect(page.getByRole('button', { name: '开始剪辑' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '预览' })).toHaveCount(0);
    await page.getByRole('button', { name: '取消全选' }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始剪辑' })).toBeDisabled();
    const thirdRallyRow = page.locator('tbody tr').nth(2);
    await thirdRallyRow.locator('label.rally-checkbox').click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    const startHandle = page.getByRole('slider', { name: '调整片段开始 3' });
    const endHandle = page.getByRole('slider', { name: '调整片段结束 3' });
    const selectedStart = Number(await startHandle.getAttribute('aria-valuenow'));
    const initialEnd = Number(await endHandle.getAttribute('aria-valuenow'));
    expect(selectedStart).toBeGreaterThanOrEqual(0);
    expect(initialEnd).toBeGreaterThan(selectedStart);

    await thirdRallyRow.click();
    const playback = await customMonitor.evaluate(async (element: HTMLVideoElement) => {
      element.muted = true;
      await new Promise((resolve) => setTimeout(resolve, 220));
      const state = { start: element.currentTime, paused: element.paused, controls: element.controls };
      element.pause();
      return state;
    });
    expect(playback.controls).toBe(false);
    expect(playback.paused).toBe(false);
    expect(playback.start).toBeGreaterThan(selectedStart);
    await expect(thirdRallyRow).toHaveAttribute('data-playback-cue', 'true');
    const cueStyle = await thirdRallyRow.locator('.custom-rally-row-content').evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return { borderRadius: style.borderRadius, borderColor: style.borderColor };
    });
    expect(cueStyle.borderRadius).toBe('8px');
    expect(cueStyle.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    await page.waitForTimeout(650);
    await expect(thirdRallyRow).not.toHaveAttribute('data-playback-cue', 'true');
    const playheadLeft = await page.locator('.timeline-playhead').evaluate((element) => Number.parseFloat(getComputedStyle(element).left));
    expect(playheadLeft).toBeGreaterThan(0);

    const playhead = page.locator('.timeline-playhead');
    const playheadBox = await playhead.boundingBox();
    expect(playheadBox).not.toBeNull();
    const timeBeforeScrub = await customMonitor.evaluate((element: HTMLVideoElement) => element.currentTime);
    await page.mouse.move(playheadBox!.x + playheadBox!.width / 2, playheadBox!.y + 8);
    await page.mouse.down();
    await page.mouse.move(playheadBox!.x + playheadBox!.width / 2 + 30, playheadBox!.y + 8);
    await expect.poll(() => customMonitor.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(timeBeforeScrub);
    await page.mouse.up();

    await endHandle.press('ArrowLeft');
    await expect.poll(async () => Number(await endHandle.getAttribute('aria-valuenow'))).toBeLessThan(initialEnd);
    await page.screenshot({ path: path.join(screenshotDir, '03-custom-timeline-resized.png'), fullPage: true });
    const selectedEnd = Number(await endHandle.getAttribute('aria-valuenow'));
    expect(selectedEnd).toBeLessThan(initialEnd);
    expect(selectedEnd).toBeGreaterThan(selectedStart);

    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: 840, height: 520 });
    const compactLayout = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      monitorRight: document.querySelector('.custom-monitor')!.getBoundingClientRect().right,
      mainRight: document.querySelector('.main-content')!.getBoundingClientRect().right,
      customPage: (() => {
        const element = document.querySelector('.custom-cut-page')!;
        return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      })(),
    }));
    expect(compactLayout.bodyWidth).toBeLessThanOrEqual(compactLayout.viewportWidth);
    expect(compactLayout.bodyHeight).toBeLessThanOrEqual(compactLayout.viewportHeight);
    expect(compactLayout.monitorRight).toBeLessThanOrEqual(compactLayout.mainRight + 1);
    expect(compactLayout.customPage.scrollWidth).toBeLessThanOrEqual(compactLayout.customPage.clientWidth + 1);
    expect(compactLayout.customPage.scrollHeight).toBeLessThanOrEqual(compactLayout.customPage.clientHeight + 1);
    await page.screenshot({ path: path.join(screenshotDir, '03-custom-timeline-compact.png'), fullPage: true });
    if (originalViewport) await page.setViewportSize(originalViewport);
    await expect(page.getByRole('button', { name: '开始剪辑' })).toBeEnabled();
    await page.getByRole('button', { name: '开始剪辑' }).click();
    await expect(page.getByRole('heading', { name: /正在/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '成功导出' })).toBeVisible({ timeout: 120_000 });

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
    expect(previewState.duration).toBeCloseTo(selectedEnd - selectedStart, 0);
    expect(previewState.readyState).toBeGreaterThanOrEqual(1);
    expect(previewState.volume).toBe(0.25);
    expect(previewState.paused).toBe(true);

    await page.getByRole('button', { name: '在文件夹中打开' }).click();
    await expect.poll(() => existsSync(revealMarker)).toBe(true);
    expect((await readFile(revealMarker, 'utf8')).trim()).toBe(outputPath);
    await page.screenshot({ path: path.join(screenshotDir, '03-export-preview.png'), fullPage: true });

    await page.getByRole('button', { name: '历史剪辑' }).click();
    await page.locator('.history-open').click();
    await page.getByRole('button', { name: /自定义/ }).click();
    await page.getByRole('button', { name: '取消全选' }).click();
    const firstRally = page.locator('tbody tr').first();
    await firstRally.locator('label.rally-checkbox').click();
    const customLaunchButton = page.getByRole('button', { name: '开始剪辑' });
    const customExportOptions = page.locator('.custom-export-options');
    await expect.poll(() => customExportOptions.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    await page.locator('.timeline-tool-buttons').hover();
    await expect.poll(() => customExportOptions.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    await customLaunchButton.hover();
    await expect.poll(() => customExportOptions.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    const launchButtonBox = await customLaunchButton.boundingBox();
    const exportOptionsBox = await customExportOptions.boundingBox();
    expect(launchButtonBox).not.toBeNull();
    expect(exportOptionsBox).not.toBeNull();
    await page.mouse.move(launchButtonBox!.x + launchButtonBox!.width / 2, launchButtonBox!.y - 4);
    await expect.poll(() => customExportOptions.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
    await page.mouse.move(exportOptionsBox!.x + exportOptionsBox!.width / 2, exportOptionsBox!.y + exportOptionsBox!.height - 10);
    await page.getByText('分段导出', { exact: true }).click();
    await page.getByText('导出 XML', { exact: true }).click();
    await page.getByRole('button', { name: '开始剪辑' }).click();
    await expect(page.getByRole('heading', { name: '成功导出' })).toBeVisible({ timeout: 120_000 });

    const artifactDirectory = (await page.locator('.output-details strong').first().textContent())?.trim();
    expect(artifactDirectory).toBeTruthy();
    expect(path.dirname(artifactDirectory!)).toBe(fixtureDir);
    const artifacts = await readdir(artifactDirectory!);
    expect(artifacts.sort()).toEqual([
      '001_回合001.mp4',
      `${path.basename(fixtureVideo, path.extname(fixtureVideo))}_TTcut_自定义.xml`,
    ]);
    const rallyVideo = path.join(artifactDirectory!, '001_回合001.mp4');
    expect((await stat(rallyVideo)).size).toBeGreaterThan(100_000);
    const premiereXml = await readFile(path.join(artifactDirectory!, `${path.basename(fixtureVideo, path.extname(fixtureVideo))}_TTcut_自定义.xml`), 'utf8');
    expect(premiereXml).toContain('<xmeml version="4">');
    expect(premiereXml).toContain('<linkclipref>audio-1-1</linkclipref>');
    expect(premiereXml).toContain('<pathurl>file:///');

    await page.getByRole('button', { name: '在文件夹中打开' }).click();
    await expect.poll(() => readFile(revealMarker, 'utf8')).toBe(artifactDirectory);
    await page.screenshot({ path: path.join(screenshotDir, '03-custom-artifact-export.png'), fullPage: true });

    await page.getByRole('button', { name: '剪辑下一个视频' }).click();
    await expect(page.getByRole('heading', { name: '选择比赛视频' })).toBeVisible();
    expect(rendererErrors).toEqual([]);
    await testInfo.attach('real-export', { path: outputPath!, contentType: 'video/mp4' });
    await testInfo.attach('premiere-xml', { body: premiereXml, contentType: 'application/xml' });
  } finally {
    await writeFile(nativeLog, nativeStderr.join(''), { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    if (existsSync(nativeLog)) await testInfo.attach('electron-native-log', { path: nativeLog, contentType: 'text/plain' });
    await stopElectron(page, browser, electronProcess);
  }
});

test('automatic calibration completes serial multi-task analysis and records zero-rally results', async ({}, testInfo) => {
  test.slow();
  for (const filePath of [sourceVideo, pythonPath, blurballWeightsPath, electronPath, path.join(ffmpegRoot, 'ffmpeg.exe'), path.join(ffmpegRoot, 'ffprobe.exe')]) {
    await requireFile(filePath);
  }

  const runId = `multi-task-${Date.now()}`;
  const isolatedRoot = path.join(fixtureDir, runId);
  const isolatedUserData = path.join(isolatedRoot, 'user-data');
  const isolatedComponents = path.join(isolatedRoot, 'components');
  const firstVideo = path.join(isolatedRoot, 'batch-a.mp4');
  const secondVideo = path.join(isolatedRoot, 'batch-b.mp4');
  const nativeLog = path.join(isolatedRoot, 'electron-native.log');
  await mkdir(isolatedRoot, { recursive: true });
  await mkdir(isolatedUserData, { recursive: true });
  await createShortVideo(sourceVideo, firstVideo);
  await copyFile(firstVideo, secondVideo);

  let electronProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const nativeStderr: string[] = [];
  const rendererErrors: string[] = [];
  const dialogs: string[] = [];
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
        TTCUT_E2E_VIDEOS: JSON.stringify([firstVideo, secondVideo]),
        TTCUT_PYTHON: pythonPath,
        TTCUT_BLURBALL_WEIGHTS: blurballWeightsPath,
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
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.waitForLoadState('domcontentloaded');

    await page.locator('.drop-zone').click();
    await expect(page.locator('.multi-task-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.batch-row')).toHaveCount(2);
    const rows = page.locator('.batch-row');
    await expect(rows.nth(0).locator('.batch-cover.processing')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.batch-cover.processing')).toHaveCount(1);
    await expect(rows.nth(1).locator('.batch-cover.processing')).toBeVisible({ timeout: 0 });
    await expect(page.locator('.batch-cover.processing')).toHaveCount(1);
    await expect(page.locator('.batch-start')).toBeEnabled({ timeout: 0 });
    await rows.nth(0).locator('.batch-cover').click();
    const preview = page.locator('.batch-preview');
    await expect(preview).toBeVisible();
    await preview.locator('video').evaluate((video) => {
      const media = video as HTMLVideoElement;
      if (media.readyState >= 1) return;
      return new Promise<void>((resolve) => media.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    });
    const previewBox = await preview.boundingBox();
    const previewMediaBox = await preview.locator('.batch-preview-media').boundingBox();
    const previewVideoBox = await preview.locator('video').boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const fixedChrome = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
      const titlebar = document.querySelector('.titlebar')?.getBoundingClientRect();
      return {
        sidebarRight: sidebar?.right ?? 0,
        titlebarBottom: titlebar?.bottom ?? 0,
      };
    });
    const intrinsicRatio = await preview.locator('video').evaluate((video) => {
      const media = video as HTMLVideoElement;
      return media.videoWidth / media.videoHeight;
    });
    expect(previewBox?.width).toBeGreaterThan(850);
    expect(previewMediaBox?.width).toBeGreaterThan(800);
    expect(previewVideoBox?.width).toBeGreaterThan(800);
    expect(previewBox?.x ?? 0).toBeGreaterThanOrEqual(fixedChrome.sidebarRight);
    expect(previewMediaBox?.x ?? 0).toBeGreaterThanOrEqual(fixedChrome.sidebarRight);
    expect(previewBox?.y ?? 0).toBeGreaterThanOrEqual(fixedChrome.titlebarBottom);
    expect(previewBox ? previewBox.y + previewBox.height : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(viewport.height + 1);
    expect(previewBox && previewVideoBox ? previewVideoBox.y + previewVideoBox.height : Number.POSITIVE_INFINITY).toBeLessThanOrEqual((previewBox?.y ?? 0) + (previewBox?.height ?? 0));
    expect(intrinsicRatio).toBeCloseTo(16 / 9, 2);
    expect(previewMediaBox ? previewMediaBox.width / previewMediaBox.height : 0).toBeCloseTo(intrinsicRatio, 2);
    expect(previewVideoBox ? previewVideoBox.width / previewVideoBox.height : 0).toBeCloseTo(intrinsicRatio, 2);
    await expect(preview.locator('video')).toHaveCSS('object-fit', 'contain');
    await preview.locator('.preview-close').click();
    for (const row of await page.locator('.batch-row').all()) {
      await row.locator('.batch-mode-options button').nth(2).click();
    }
    await page.locator('.batch-start').click();
    await expect(page.locator('.batch-row.done')).toHaveCount(2, { timeout: 5 * 60 * 1_000 });
    await expect(page.locator('.batch-row.analyzing')).toHaveCount(0);

    const history = await page.evaluate(() => window.ttcut.listHistory());
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.video_name).sort()).toEqual(['batch-a.mp4', 'batch-b.mp4']);
    expect(history.every((entry) => entry.rally_count === 0 && entry.completion_kind === 'analysis')).toBe(true);
    expect(rendererErrors).toEqual([]);
    expect(dialogs).toEqual([]);
    await testInfo.attach('multi-task-history', {
      body: Buffer.from(JSON.stringify(history, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await writeFile(nativeLog, nativeStderr.join(''), { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    if (existsSync(nativeLog)) await testInfo.attach('multi-task-electron-native-log', { path: nativeLog, contentType: 'text/plain' });
    await stopElectron(page, browser, electronProcess);
  }
});

test('manual calibration accepts unordered points and redraws the polygon while dragging', async ({}, testInfo) => {
  for (const filePath of [sourceVideo, pythonPath, blurballWeightsPath, electronPath, path.join(ffmpegRoot, 'ffmpeg.exe'), path.join(ffmpegRoot, 'ffprobe.exe')]) {
    await requireFile(filePath);
  }

  const isolatedRoot = path.join(fixtureDir, `manual-polygon-${Date.now()}`);
  const nativeLog = path.join(isolatedRoot, 'electron-native.log');
  await mkdir(isolatedRoot, { recursive: true });
  await mkdir(screenshotDir, { recursive: true });
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
        TTCUT_E2E: '1',
        TTCUT_E2E_USER_DATA: path.join(isolatedRoot, 'user-data'),
        TTCUT_E2E_COMPONENTS_ROOT: path.join(isolatedRoot, 'components'),
        TTCUT_E2E_VIDEO: sourceVideo,
        TTCUT_PYTHON: pythonPath,
        TTCUT_BLURBALL_WEIGHTS: blurballWeightsPath,
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

    await page.getByRole('button', { name: '设置' }).click();
    await page.locator('label[for="settings-calibration-0"]').click();
    await expect(page.getByRole('radio', { name: '手动' })).toBeChecked();
    await page.getByRole('button', { name: '自动剪辑' }).click();
    await page.locator('.drop-zone').click();
    await expect(page.getByRole('heading', { name: '标定球桌' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('逐个标记球台四个角点，顺序不限。标满四点后可拖动微调。')).toBeVisible();

    for (const pointIndex of [2, 0, 3, 1]) {
      const [x, y] = calibrationPoints[pointIndex]!;
      await clickSourcePoint(page, x, y);
    }
    const polygon = page.locator('.calibration-polygon polygon');
    await expect(polygon).toBeVisible();
    const pointsBeforeDrag = await polygon.getAttribute('points');
    const firstPoint = page.getByRole('button', { name: 'Calibration point 1' });
    const firstPointBox = await firstPoint.boundingBox();
    if (!firstPointBox) throw new Error('First calibration point has no visible bounding box.');
    await page.mouse.move(firstPointBox.x + firstPointBox.width / 2, firstPointBox.y + firstPointBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstPointBox.x + firstPointBox.width / 2 - 12, firstPointBox.y + firstPointBox.height / 2 - 8);
    await page.mouse.up();
    await expect.poll(() => polygon.getAttribute('points')).not.toBe(pointsBeforeDrag);
    await expect(page.getByRole('button', { name: /^Calibration point / })).toHaveCount(4);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
    const screenshotPath = path.join(screenshotDir, 'manual-calibration-polygon.png');
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach('manual-calibration-polygon', { path: screenshotPath, contentType: 'image/png' });
  } finally {
    if (existsSync(nativeLog)) await testInfo.attach('manual-calibration-electron-native-log', { path: nativeLog, contentType: 'text/plain' });
    await stopElectron(page, browser, electronProcess);
  }
});

test('failed batch calibration can be repaired manually and returned to the running queue', async ({}, testInfo) => {
  test.slow();
  for (const filePath of [sourceVideo, pythonPath, blurballWeightsPath, electronPath, path.join(ffmpegRoot, 'ffmpeg.exe'), path.join(ffmpegRoot, 'ffprobe.exe')]) {
    await requireFile(filePath);
  }

  const runId = `multi-task-manual-${Date.now()}`;
  const isolatedRoot = path.join(fixtureDir, runId);
  const isolatedUserData = path.join(isolatedRoot, 'user-data');
  const isolatedComponents = path.join(isolatedRoot, 'components');
  const failedVideo = path.join(isolatedRoot, 'calibration-failure.mp4');
  const readyVideo = path.join(isolatedRoot, 'calibration-success.mp4');
  const nativeLog = path.join(isolatedRoot, 'electron-native.log');
  await mkdir(isolatedRoot, { recursive: true });
  await mkdir(isolatedUserData, { recursive: true });
  await createCalibrationFailureVideo(failedVideo);
  await createShortVideo(sourceVideo, readyVideo);

  let electronProcess: ChildProcess | null = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const nativeStderr: string[] = [];
  const rendererErrors: string[] = [];
  const dialogs: string[] = [];
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
        TTCUT_E2E_VIDEOS: JSON.stringify([failedVideo, readyVideo]),
        TTCUT_PYTHON: pythonPath,
        TTCUT_BLURBALL_WEIGHTS: blurballWeightsPath,
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
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.waitForLoadState('domcontentloaded');

    await page.locator('.drop-zone').click();
    await expect(page.locator('.multi-task-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('标定失败')).toBeVisible({ timeout: 0 });
    await expect(page.getByText('手动标定')).toBeVisible();
    await expect(page.getByText('AUTO_CALIBRATION_FAILED')).toHaveCount(0);
    const failedCoverVideoStyle = await page.getByRole('button', { name: 'calibration-failure.mp4 手动标定' })
      .locator('video')
      .evaluate((element) => ({
        filter: getComputedStyle(element).filter,
        opacity: getComputedStyle(element).opacity,
      }));
    expect(failedCoverVideoStyle.filter).toContain('blur(8px)');
    expect(failedCoverVideoStyle.opacity).toBe('0.66');

    await page.getByRole('button', { name: 'calibration-failure.mp4 手动标定' }).click();
    await expect(page.getByRole('heading', { name: '标定球桌' })).toBeVisible();
    for (const pointIndex of [2, 0, 3, 1]) {
      const [x, y] = calibrationPoints[pointIndex]!;
      await clickSourcePoint(page, x, y);
    }
    const calibrationPolygon = page.locator('.calibration-polygon polygon');
    await expect(calibrationPolygon).toBeVisible();
    const polygonBeforeDrag = await calibrationPolygon.getAttribute('points');
    const firstPoint = page.getByRole('button', { name: 'Calibration point 1' });
    const firstPointBox = await firstPoint.boundingBox();
    if (!firstPointBox) throw new Error('First calibration point has no visible bounding box.');
    await page.mouse.move(firstPointBox.x + firstPointBox.width / 2, firstPointBox.y + firstPointBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstPointBox.x + firstPointBox.width / 2 - 12, firstPointBox.y + firstPointBox.height / 2 - 8);
    await page.mouse.up();
    await expect.poll(() => calibrationPolygon.getAttribute('points')).not.toBe(polygonBeforeDrag);
    const finishCalibration = page.getByRole('button', { name: '完成标定' });
    await expect(finishCalibration).toBeEnabled();
    await finishCalibration.click();
    await expect(page.getByRole('heading', { name: '多任务剪辑' })).toBeVisible();
    await expect(page.locator('.batch-start')).toBeEnabled({ timeout: 0 });

    for (const row of await page.locator('.batch-row').all()) {
      await row.locator('.batch-mode-options button').nth(2).click();
    }
    await page.locator('.batch-start').click();
    await expect(page.locator('.batch-row.done')).toHaveCount(2, { timeout: 5 * 60 * 1_000 });

    const history = await page.evaluate(() => window.ttcut.listHistory());
    expect(history.map((entry) => entry.video_name).sort()).toEqual([
      'calibration-failure.mp4',
      'calibration-success.mp4',
    ]);
    expect(rendererErrors).toEqual([]);
    expect(dialogs).toEqual([]);
    await testInfo.attach('multi-task-manual-history', {
      body: Buffer.from(JSON.stringify(history, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await writeFile(nativeLog, nativeStderr.join(''), { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    if (existsSync(nativeLog)) await testInfo.attach('multi-task-manual-electron-native-log', { path: nativeLog, contentType: 'text/plain' });
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
    await requireFile(path.join(projectRoot, 'resources', 'models', 'blurball_best.pt'));
    await requireFile(status.media.path!);
    await requireFile(path.join(path.dirname(status.media.path!), 'ffprobe.exe'));
    expect(rendererErrors).toEqual([]);

    const manifests = await readdir(path.join(isolatedComponents, '.manifests'));
    expect(manifests.some((name) => name.startsWith('analysis-cu126-'))).toBe(true);
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
