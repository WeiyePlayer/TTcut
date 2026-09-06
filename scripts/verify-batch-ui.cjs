const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

(async () => {
  const project = process.cwd();
  const output = path.join(project, 'output', 'playwright', `batch-merge-${Date.now()}`);
  await fs.mkdir(output, { recursive: true });
  const userData = path.join(output, 'user-data');
  await fs.mkdir(path.join(userData, 'history', 'records'), { recursive: true });
  const validationRoot = path.join(project, 'output', 'batch-export-validation');
  const fixtureDirectories = await fs.readdir(validationRoot);
  let fixture;
  for (const directory of fixtureDirectories) {
    if (await fs.stat(path.join(validationRoot, directory, 'validation.json')).catch(() => null)) fixture = path.join(validationRoot, directory);
  }
  assert(fixture, 'Run the real merged-media integration check first');
  const files = ['red.mp4', 'green.mp4'].map((name) => path.join(output, name));
  await Promise.all(files.map((file) => fs.copyFile(path.join(fixture, path.basename(file)), file)));
  const resources = path.join(project, 'out/TTcut-darwin-arm64/TTcut.app/Contents/Resources');
  const productionApp = path.join(output, 'app');
  asar.extractAll(path.join(resources, 'app.asar'), productionApp);
  await fs.mkdir(path.join(productionApp, '.runtime'), { recursive: true });
  await fs.symlink(path.join(resources, 'runtime'), path.join(productionApp, '.runtime', 'macos'));
  // Execute the exact packaged production resources with the development Electron
  // harness: the signed app disables Node inspect and E2E environment overrides.
  const ffmpegRoot = path.join(resources, 'runtime', 'bin');
  const electron = await _electron.launch({
    executablePath: path.join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [productionApp],
    env: { ...process.env, TTCUT_E2E: '1', TTCUT_E2E_USER_DATA: userData,
      TTCUT_E2E_COMPONENTS_ROOT: path.join(output, 'components'), TTCUT_E2E_VIDEOS: JSON.stringify(files),
      TTCUT_E2E_REVEAL_MARKER: path.join(output, 'revealed.txt'),
      TTCUT_FFMPEG: path.join(ffmpegRoot, 'ffmpeg'), TTCUT_FFPROBE: path.join(ffmpegRoot, 'ffprobe') },
  });
  let page;
  try {
    page = await electron.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.ttcut));
    const bootstrap = await page.evaluate(() => window.ttcut.bootstrap());
    assert(bootstrap.logsPath.startsWith(userData), 'Packaged app must use isolated test data');
    const metadata = await page.evaluate((paths) => Promise.all(paths.map((file) => window.ttcut.probeVideo(file))), files);
    const records = await Promise.all(metadata.map(async (video) => {
      const info = await fs.stat(video.path);
      const calibration = { video_width: video.width, video_height: video.height, points: {
        top_left: [video.width * .3, video.height * .2], top_right: [video.width * .7, video.height * .2],
        bottom_right: [video.width * .8, video.height * .8], bottom_left: [video.width * .2, video.height * .8],
      } };
      const record = { schema_version: 1, id: crypto.randomUUID(), analyzed_at: new Date().toISOString(),
        source: { path: video.path, name: path.basename(video.path), size: info.size, modified_time_ms: info.mtimeMs },
        calibration, analysis: { schema_version: 1, video,
          rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 2, end_time_seconds: 2.2 }] },
        visible_in_history: true, completion_kind: 'analysis', output_path: null };
      await fs.writeFile(path.join(userData, 'history', 'records', `${record.id}.json`), JSON.stringify(record));
      return record;
    }));
    // Only calibration/analysis are fixtures. The production batch-export IPC, history reads,
    // FFmpeg, media protocol and renderer all run unchanged. OS shutdown is always intercepted.
    await electron.evaluate(({ ipcMain, BrowserWindow }, { bootstrap, records }) => {
      const state = { shutdowns: 0, analyses: 0, events: [] };
      globalThis.__batchUiCheck = state;
      ipcMain.removeHandler('app:bootstrap');
      ipcMain.handle('app:bootstrap', () => ({ ...bootstrap, components: { ...bootstrap.components,
        analysis: { ...bootstrap.components.analysis, available: true }, media: { ...bootstrap.components.media, available: true } } }));
      ipcMain.removeHandler('system:shutdown');
      ipcMain.handle('system:shutdown', () => { state.shutdowns += 1; });
      ipcMain.removeHandler('calibration:start');
      ipcMain.handle('calibration:start', (_event, input) => {
        const record = records.find((record) => record.source.path === input.videoPath);
        const taskId = `calibration-${record.id}`;
        setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.send('task:event', {
          type: 'calibration-result', taskId, calibration: record.calibration, tableAnalysis: {},
        }), 250);
        return taskId;
      });
      ipcMain.removeHandler('analysis:start');
      ipcMain.handle('analysis:start', (_event, input) => {
        state.analyses += 1;
        const record = records.find((record) => record.source.path === input.videoPath);
        const taskId = `analysis-${record.id}`;
        setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.send('task:event', {
          type: 'analysis-result', taskId, analysisId: record.id, calibration: record.calibration, data: record.analysis,
        }), 1500);
        return taskId;
      });
    }, { bootstrap, records });
    await page.evaluate(() => localStorage.setItem('ttcut.supportPrompt.snoozedUntil', String(Date.now() + 86400000)));
    await page.reload();
    await page.getByRole('button', { name: '选择或将文件拖到这里' }).click();
    await page.locator('.multi-task-page .batch-start:not(:disabled)').waitFor();
    const launcher = page.locator('.batch-launcher');
    const options = page.locator('.batch-launch-options');
    const setOption = async (name, checked) => {
      const input = page.getByRole('checkbox', { name });
      if (await input.isChecked() !== checked) await input.locator('..').click();
      assert.equal(await input.isChecked(), checked);
    };
    await page.mouse.move(5, 5);
    assert.equal(await options.evaluate((node) => getComputedStyle(node).visibility), 'hidden');
    await launcher.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.batch-launch-options')).opacity === '1');
    assert.equal(await page.locator('.batch-launcher .custom-export-options').count(), 1);
    assert.equal(await options.locator('.export-checkbox').count(), 1);
    assert.equal(await page.getByRole('checkbox', { name: '完成本任务后关机' }).count(), 0);
    assert.equal(await options.evaluate((node) => getComputedStyle(node).borderRadius), '12px');
    assert.equal(await options.locator('.export-checkbox-control').first().evaluate((node) => getComputedStyle(node).width), '16px');
    await setOption('合并为一个视频', true);
    await page.screenshot({ path: path.join(output, 'options.png'), fullPage: true });
    await page.getByRole('button', { name: '开始分析剪辑' }).click();
    assert.equal(await page.getByRole('checkbox', { name: '合并为一个视频' }).isDisabled(), true);
    await launcher.hover();
    assert.equal(await electron.evaluate(() => globalThis.__batchUiCheck.shutdowns), 0);
    await page.getByText('合并视频已完成', { exact: true }).waitFor({ timeout: 60000 });
    assert.equal(await electron.evaluate(() => globalThis.__batchUiCheck.shutdowns), 0);
    const exported = await page.locator('.batch-merged-path').innerText();
    assert((await fs.stat(exported)).size > 1024);
    await page.getByRole('button', { name: '预览输出', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.batch-preview video')?.readyState >= 2);
    const playback = await page.locator('.batch-preview video').evaluate((video) => ({
      width: video.videoWidth, height: video.videoHeight, duration: video.duration, error: video.error,
    }));
    assert.equal(playback.width, 320);
    assert.equal(playback.height, 180);
    assert.equal(playback.error, null);
    await page.screenshot({ path: path.join(output, 'preview.png'), fullPage: true });
    await page.locator('.batch-preview-header button').click();
    await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
    assert.equal(await fs.readFile(path.join(output, 'revealed.txt'), 'utf8'), exported);
    await launcher.focus();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.batch-launch-options')).opacity === '1');
    for (const group of await page.getByRole('group').all()) await group.getByRole('button', { name: '只分析' }).click();
    await launcher.focus();
    const mergedCheckbox = page.getByRole('checkbox', { name: '合并为一个视频' });
    assert.equal(await mergedCheckbox.isDisabled(), true);
    assert.equal(await mergedCheckbox.isChecked(), false);
    assert.deepEqual(errors, []);
    const evidence = { page: page.url(), exported, playback, state: await electron.evaluate(() => globalThis.__batchUiCheck), errors,
      analysis: 'seeded fixtures; real batch-export IPC/FFmpeg/media playback', screenshots: ['options.png', 'preview.png'] };
    await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ success: true, output, ...evidence }, null, 2));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
      console.error(await page.locator('body').innerText().catch(() => 'No body'));
    }
    throw error;
  } finally {
    await electron.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
