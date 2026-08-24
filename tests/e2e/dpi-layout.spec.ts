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

      const componentActionLayout = await page.evaluate(() => {
        const manual = document.querySelector('.setup-manual');
        const label = manual?.querySelector('strong');
        const actions = manual?.querySelector('.setup-manual-actions');
        if (!(label instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error('Missing manual component actions.');
        const labelBox = label.getBoundingClientRect();
        const actionsBox = actions.getBoundingClientRect();
        return {
          labelRight: labelBox.right,
          actionsLeft: actionsBox.left,
          verticalOffset: Math.abs(labelBox.top + labelBox.height / 2 - (actionsBox.top + actionsBox.height / 2)),
          buttonWraps: Array.from(actions.querySelectorAll('button')).some((button) => button.scrollHeight > button.clientHeight),
        };
      });
      expect(componentActionLayout.actionsLeft).toBeGreaterThan(componentActionLayout.labelRight);
      expect(componentActionLayout.verticalOffset).toBeLessThan(2);
      expect(componentActionLayout.buttonWraps).toBe(false);

      await page.locator('.main-content').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.locator('.actions-card')).toBeVisible();
      await page.screenshot({ path: path.join(outputRoot, `dpi-${percent}.png`), fullPage: true });
    } finally {
      await stopElectron(page, browser, child);
    }
  });
}

test('neutral controls use the shared hover surface without overriding semantic states', async () => {
  if (!existsSync(electronPath)) throw new Error(`Required Electron runtime is missing: ${electronPath}`);
  await mkdir(outputRoot, { recursive: true });
  const isolatedRoot = path.join(projectRoot, '.baseline', 'e2e', `hover-colors-${Date.now()}`);
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
      ...(process.env.TTCUT_E2E_ENABLE_GPU === '1' ? [] : ['--disable-gpu']),
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
    await expect(page.locator('.settings-heading .eyebrow')).toHaveCount(0);
    const aboutCardLayout = await page.locator('.about-card').evaluate((card) => {
      const brand = card.querySelector('.about-brand');
      const actions = card.querySelector('.about-actions');
      if (!(brand instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error('Missing about-card content.');
      const brandBox = brand.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      return {
        actionsLeft: actionsBox.left,
        brandRight: brandBox.right,
        verticalOffset: Math.abs(brandBox.top + brandBox.height / 2 - (actionsBox.top + actionsBox.height / 2)),
      };
    });
    expect(aboutCardLayout.actionsLeft).toBeGreaterThan(aboutCardLayout.brandRight);
    expect(aboutCardLayout.verticalOffset).toBeLessThan(2);
    const aboutActionRows = await page.locator('.about-actions').evaluate((actions) => {
      const rowSizes = () => {
        const rows: Array<{ top: number; count: number }> = [];
        for (const button of actions.querySelectorAll('button')) {
          const top = button.getBoundingClientRect().top;
          const row = rows.find((candidate) => Math.abs(candidate.top - top) < 1);
          if (row) row.count += 1;
          else rows.push({ top, count: 1 });
        }
        return rows.sort((a, b) => a.top - b.top).map(({ count }) => count);
      };

      const defaultRows = rowSizes();
      const card = actions.closest('.about-card');
      if (!(card instanceof HTMLElement)) throw new Error('Missing about card.');
      card.style.width = '480px';
      card.style.gridTemplateColumns = '1fr';
      const compactRows = rowSizes();
      card.style.removeProperty('width');
      card.style.removeProperty('grid-template-columns');
      return { defaultRows, compactRows };
    });
    expect(aboutActionRows.defaultRows).toEqual([5]);
    expect(aboutActionRows.compactRows).toEqual([3, 2]);
    await expect(page.locator('.timing-settings-card')).toHaveCount(1);
    await expect(page.locator('.timing-settings-card').getByRole('heading', { name: '回合前时间' })).toBeVisible();
    await expect(page.locator('.timing-settings-card').getByRole('heading', { name: '回合后时间' })).toBeVisible();
    const timingControlLayout = await page.locator('.timing-settings-card').evaluate((card) => {
      const setting = card.querySelector('.timing-setting');
      const heading = setting?.querySelector('h2');
      const toggle = setting?.querySelector('.timing-toggle');
      const calibrationToggle = document.querySelector('.setting-card .glass-radio-group');
      if (!(heading instanceof HTMLElement) || !(toggle instanceof HTMLElement) || !(calibrationToggle instanceof HTMLElement)) throw new Error('Missing timing or calibration controls.');
      const headingBox = heading.getBoundingClientRect();
      const toggleBox = toggle.getBoundingClientRect();
      return {
        calibrationHeight: calibrationToggle.getBoundingClientRect().height,
        headingRight: headingBox.right,
        toggleHeight: toggleBox.height,
        toggleLeft: toggleBox.left,
        verticalOffset: Math.abs(toggleBox.top + toggleBox.height / 2 - (headingBox.top + headingBox.height / 2)),
      };
    });
    expect(timingControlLayout.toggleLeft).toBeGreaterThan(timingControlLayout.headingRight);
    expect(timingControlLayout.verticalOffset).toBeLessThan(48);
    expect(timingControlLayout.toggleHeight).toBeCloseTo(timingControlLayout.calibrationHeight, 0);
    const preRollToggle = page.getByRole('radiogroup', { name: '回合前时间' });
    const postRollToggle = page.getByRole('radiogroup', { name: '回合后时间' });
    await expect(preRollToggle.getByRole('radio', { name: '短', exact: true })).toBeVisible();
    await expect(preRollToggle.getByRole('radio', { name: '中', exact: true })).toBeVisible();
    await expect(preRollToggle.getByRole('radio', { name: '长', exact: true })).toBeVisible();
    await expect(preRollToggle.getByRole('radio', { name: '中', exact: true })).toBeChecked();
    await expect(postRollToggle.getByRole('radio', { name: '极短', exact: true })).toBeVisible();
    await expect(postRollToggle.getByRole('radio', { name: '短', exact: true })).toBeVisible();
    await expect(postRollToggle.getByRole('radio', { name: '短', exact: true })).toBeChecked();
    await expect(preRollToggle.getByRole('radio', { name: '1.5 s' })).toHaveCount(0);
    const analysisPrecision = page.locator('.detector-settings-card');
    await expect(analysisPrecision.getByRole('heading', { name: '分析精度' })).toBeVisible();
    await expect(analysisPrecision).toContainText('高精模式识别精度很高，花费时间增长。');
    await expect(analysisPrecision.getByRole('slider')).toHaveCount(0);
    const analysisPrecisionOrder = await analysisPrecision.evaluate((card) => {
      const siblings = Array.from(card.parentElement?.children ?? []);
      const index = siblings.indexOf(card);
      const language = siblings.findIndex((item) => item.classList.contains('setting-card') && item.textContent?.includes('语言'));
      const calibration = siblings.findIndex((item) => item.classList.contains('setting-card') && item.textContent?.includes('球台标定'));
      return { index, language, calibration };
    });
    expect(analysisPrecisionOrder.index).toBe(analysisPrecisionOrder.language + 1);
    expect(analysisPrecisionOrder.calibration).toBe(analysisPrecisionOrder.index + 1);
    const analysisMode = page.getByRole('radiogroup', { name: '分析精度' });
    await expect(analysisMode.getByRole('radio', { name: '默认' })).toBeChecked();
    await expect(analysisMode.getByRole('radio', { name: '高精' })).toBeVisible();
    await page.locator('label[for="settings-blurball-mode-1"]').click();
    await expect(analysisPrecision.getByRole('slider')).toHaveCount(0);
    await page.locator('label[for="settings-blurball-mode-0"]').click();
    await expect(analysisPrecision.getByRole('slider')).toHaveCount(0);
    const contactAuthor = page.getByRole('button', { name: '联系作者' });
    await expect(contactAuthor).toBeVisible();
    await expect(page.locator('.contact-author-qr')).toBeHidden();
    await contactAuthor.hover();
    await expect(page.locator('.contact-author-qr')).toBeVisible();
    await expect(page.locator('.contact-author-qr img')).toHaveAttribute('alt', '联系作者微信二维码');
    const contactAuthorAlignment = await page.locator('.contact-author').evaluate((container) => {
      const button = container.querySelector('button');
      const popup = container.querySelector('.contact-author-qr');
      if (!(button instanceof HTMLElement) || !(popup instanceof HTMLElement)) throw new Error('Missing contact-author button or QR popup.');
      const buttonBox = button.getBoundingClientRect();
      const popupBox = popup.getBoundingClientRect();
      return {
        buttonCenter: buttonBox.left + buttonBox.width / 2,
        popupCenter: popupBox.left + popupBox.width / 2,
      };
    });
    expect(Math.abs(contactAuthorAlignment.buttonCenter - contactAuthorAlignment.popupCenter)).toBeLessThan(1);
    await page.screenshot({ path: path.join(outputRoot, 'contact-author-qr-open.png'), fullPage: true });
    await page.locator('.timing-settings-card').screenshot({ path: path.join(outputRoot, 'timing-controls.png') });
    await page.locator('.detector-settings-card').screenshot({ path: path.join(outputRoot, 'analysis-precision-control.png') });
    await page.getByRole('button', { name: '历史剪辑' }).click();
    await expect(page.locator('.history-page')).toBeVisible();
    await expect(page.locator('.history-header .eyebrow')).toHaveCount(0);
    await page.getByRole('button', { name: '自动剪辑' }).click();
    await expect(page.getByRole('heading', { name: '选择比赛视频' })).toBeVisible();
    await expect(page.locator('.center-stage .eyebrow')).toHaveCount(0);
    await expect(page.locator('.drop-zone .drop-icon')).toBeVisible();
    await expect(page.locator('.drop-zone strong')).toHaveCSS('font-weight', '400');
    await page.locator('.center-stage').screenshot({ path: path.join(outputRoot, 'home-upload.png') });
    const captureHelp = page.getByRole('button', { name: '推荐视频拍摄视角' });
    await expect(captureHelp).toBeVisible();
    await expect(page.locator('.capture-help-card')).toBeHidden();
    await captureHelp.hover();
    await expect(page.locator('.capture-help-card')).toBeVisible();
    await expect(page.locator('.capture-help-card')).toContainText('推荐视频拍摄视角');
    await expect(page.locator('.capture-help-card img')).toHaveAttribute('alt', '推荐视频拍摄视角示意图');
    await page.screenshot({ path: path.join(outputRoot, 'capture-guide-open.png'), fullPage: true });
    await page.screenshot({ path: path.join(outputRoot, 'without-blue-ttcut.png'), fullPage: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.locator('.settings-page')).toBeVisible();

    await page.locator('.settings-page').evaluate((settingsPage) => {
      const fixture = document.createElement('section');
      fixture.id = 'hover-color-fixture';
      fixture.className = 'card';
      fixture.setAttribute('style', 'margin-top:14px;padding:18px;display:flex;flex-wrap:wrap;gap:10px;align-items:center');
      fixture.innerHTML = `
        <button class="workflow-back" type="button">Back</button>
        <button class="preview-close" type="button">×</button>
        <button class="secondary" type="button">Secondary</button>
        <button class="secondary disabled-probe" type="button" disabled>Disabled</button>
        <button class="primary" type="button">Primary</button>
        <button class="primary destructive-confirm" type="button">Delete</button>
        <div class="about-actions"><button class="secondary donate-button" type="button">Donate</button></div>
        <button class="drop-zone" type="button" style="width:120px;min-height:60px;margin:0;padding:8px">Drop</button>
        <button class="mode-card mode-probe" type="button"><span class="radio-dot"></span><strong>Mode</strong><small>Neutral</small></button>
        <button class="mode-card selected mode-selected-probe" type="button"><span class="radio-dot"></span><strong>Selected</strong><small>Mode</small></button>
        <div class="segmented"><button class="segmented-probe" type="button">Segment</button><button class="selected segmented-selected-probe" type="button">Selected</button></div>
        <div class="glass-radio-group" style="--glass-option-count:2;--glass-selected-index:1"><input id="radio-probe" name="radio-probe" type="radio"><label for="radio-probe">Radio</label><input id="radio-selected-probe" name="radio-probe" type="radio" checked><label for="radio-selected-probe">Selected</label><span class="glass-glider"></span></div>
        <label class="export-checkbox"><input type="checkbox" checked><span class="export-checkbox-control"><span class="export-checkbox-gloss"></span></span><span class="export-checkbox-text">Export</span></label>
        <label class="rally-checkbox"><input type="checkbox" checked><span class="rally-checkbox-control"></span></label>
        <div class="batch-mode-options"><button class="batch-mode-probe" type="button">Batch</button><button class="selected batch-mode-selected-probe" type="button">Selected</button></div>
      `;
      settingsPage.appendChild(fixture);

      const rallyFixture = document.createElement('section');
      rallyFixture.id = 'rally-list-layout-fixture';
      rallyFixture.className = 'custom-rally-list';
      rallyFixture.setAttribute('style', 'width:280px;height:420px;margin-top:14px');
      const rows = Array.from({ length: 42 }, (_, index) => `
        <tr><td class="custom-rally-check"><label class="rally-checkbox"><input type="checkbox" ${index % 2 === 0 ? 'checked' : ''}><span class="rally-checkbox-control"></span></label></td><td><div class="custom-rally-meta"><strong>Rally ${index + 1}</strong><span>Bounces 3</span></div><div class="custom-rally-times"><span>00:00.0</span><div class="custom-rally-duration"><strong>5.5s</strong><i></i></div><span>00:05.5</span></div></td></tr>`).join('');
      rallyFixture.innerHTML = `<div class="table-tools"><strong>42 / 42</strong></div><div class="custom-rally-scroll-shell"><div class="table-scroll"><table class="custom-rally-table"><tbody>${rows}</tbody></table></div></div>`;
      settingsPage.appendChild(rallyFixture);
    });

    const hoverColor = async (selector: string, expected: string) => {
      const locator = page!.locator(selector);
      await locator.hover({ force: true });
      await expect.poll(() => locator.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(expected);
    };

    for (const selector of [
      '#hover-color-fixture .workflow-back',
      '#hover-color-fixture .preview-close',
      '#hover-color-fixture .secondary:not(.disabled-probe):not(.donate-button)',
      '.sidebar nav button:not(.active):first-child',
      '.window-controls button[aria-label="Minimize"]',
      '#hover-color-fixture .mode-probe',
      '#hover-color-fixture .segmented-probe',
      '#hover-color-fixture .batch-mode-probe',
    ]) {
      await hoverColor(selector, 'rgb(231, 232, 232)');
    }

    await expect.poll(() => page!.locator('.sidebar button.active').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(231, 232, 232)');
    await hoverColor('#hover-color-fixture .disabled-probe', 'rgb(255, 255, 255)');
    await hoverColor('#hover-color-fixture .mode-selected-probe', 'rgb(248, 251, 255)');
    await hoverColor('#hover-color-fixture .segmented-selected-probe', 'rgb(255, 255, 255)');
    await expect(page.locator('#hover-color-fixture .glass-radio-group')).toBeVisible();
    await expect(page.locator('#hover-color-fixture .glass-radio-group')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('#hover-color-fixture .glass-radio-group input:checked')).toHaveCount(1);
    await expect(page.locator('#hover-color-fixture .glass-radio-group .glass-glider')).toHaveCSS('border-radius', '16px');
    await expect(page.locator('#hover-color-fixture .export-checkbox-control')).toHaveCSS('width', '16px');
    await expect(page.locator('#hover-color-fixture .export-checkbox-control svg')).toHaveCount(0);
    await expect(page.locator('#hover-color-fixture .rally-checkbox-control')).toHaveCSS('width', '14px');
    await expect(page.locator('#hover-color-fixture .rally-checkbox-control svg')).toHaveCount(0);
    await expect(page.locator('#hover-color-fixture .rally-checkbox .export-checkbox-gloss')).toHaveCount(0);
    const rallyListLayout = await page.locator('#rally-list-layout-fixture .table-scroll').evaluate((scroll) => {
      const table = scroll.querySelector('table');
      const firstRow = scroll.querySelector('tbody tr:first-child');
      const lastRow = scroll.querySelector('tbody tr:last-child');
      if (!(table instanceof HTMLElement) || !(firstRow instanceof HTMLElement) || !(lastRow instanceof HTMLElement)) throw new Error('Missing rally-list fixture rows.');
      const initial = {
        clientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
        tableHeight: table.getBoundingClientRect().height,
        firstRowTop: firstRow.getBoundingClientRect().top,
        scrollTop: scroll.getBoundingClientRect().top,
      };
      scroll.scrollTop = scroll.scrollHeight;
      const afterScroll = {
        lastRowBottom: lastRow.getBoundingClientRect().bottom,
        scrollBottom: scroll.getBoundingClientRect().bottom,
      };
      return { initial, afterScroll };
    });
    expect(rallyListLayout.initial.clientHeight).toBeGreaterThan(200);
    expect(rallyListLayout.initial.scrollHeight).toBeGreaterThan(rallyListLayout.initial.clientHeight);
    expect(rallyListLayout.initial.tableHeight).toBeGreaterThan(rallyListLayout.initial.clientHeight);
    expect(rallyListLayout.initial.firstRowTop).toBeGreaterThanOrEqual(rallyListLayout.initial.scrollTop - 1);
    expect(rallyListLayout.afterScroll.lastRowBottom).toBeLessThanOrEqual(rallyListLayout.afterScroll.scrollBottom + 1);
    const rallyScroll = page.locator('#rally-list-layout-fixture .table-scroll');
    const rallyCheckboxes = page.locator('#rally-list-layout-fixture .rally-checkbox');
    for (const index of [0, 20, 41]) {
      await rallyCheckboxes.nth(index).scrollIntoViewIfNeeded();
      await rallyCheckboxes.nth(index).click();
      const toggledLayout = await rallyScroll.evaluate((scroll) => {
        const viewport = scroll.getBoundingClientRect();
        const rows = Array.from(scroll.querySelectorAll('tbody tr'));
        return {
          clientHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          visibleRows: rows.filter((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > viewport.top && box.top < viewport.bottom;
          }).length,
        };
      });
      expect(toggledLayout.scrollHeight).toBeGreaterThan(toggledLayout.clientHeight);
      expect(toggledLayout.visibleRows).toBeGreaterThan(3);
    }
    await page.locator('#rally-list-layout-fixture').screenshot({ path: path.join(outputRoot, 'rally-list-controls.png') });
    await hoverColor('#hover-color-fixture .batch-mode-selected-probe', 'rgb(255, 255, 255)');
    await hoverColor('#hover-color-fixture .primary:not(.destructive-confirm)', 'rgb(35, 105, 216)');
    await hoverColor('#hover-color-fixture .destructive-confirm', 'rgb(163, 33, 23)');
    await hoverColor('#hover-color-fixture .donate-button', 'rgb(255, 239, 173)');
    await hoverColor('.drop-zone', 'rgb(247, 250, 255)');
    await hoverColor('#hover-color-fixture .secondary:not(.disabled-probe):not(.donate-button)', 'rgb(231, 232, 232)');

    await page.screenshot({ path: path.join(outputRoot, 'uiverse-controls.png'), fullPage: true });
  } finally {
    await stopElectron(page, browser, child);
  }
});
