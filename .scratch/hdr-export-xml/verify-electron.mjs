// Local acceptance: real Electron IPC, native worker and output-preview playback.
import assert from 'node:assert/strict';
import { _electron as electron, chromium, expect } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const run = await mkdtemp(path.join(root, 'output/hdr-export-xml/electron-'));
const profile = path.join(run, 'profile');
await mkdir(path.join(profile, 'history/records'), { recursive: true });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'en', calibration_method: 'manual', pre_roll_seconds: 1.5, post_roll_seconds: 0.5, normalize_variable_frame_rate: false }));
const ffmpeg = path.join(root, '.runtime/macos/bin/ffmpeg');
const ffprobe = path.join(root, '.runtime/macos/bin/ffprobe');
const execute = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const report = { host: process.platform, run, checks: [], errors: [], events: [] };
const environment = { ...process.env, TTCUT_E2E: '1', TTCUT_E2E_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const waitFor = async (condition, timeout = 120000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await condition(); if (result) return result; await delay(100); }
  throw new Error('Acceptance condition timed out');
};
let instance, page;
if (process.env.TTCUT_MACOS_ACCEPTANCE_APP) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.env.TTCUT_MACOS_ACCEPTANCE_APP, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env: environment, stdio: 'ignore' });
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.ok).catch(() => false), 45000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('file:')), 45000);
  instance = { close: async () => { await browser.close(); if (child.exitCode === null) child.kill('SIGTERM'); } };
} else {
  instance = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: environment });
  page = await instance.firstWindow();
}
try {
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.ttcut));
  await page.evaluate(() => localStorage.setItem('ttcut.customEditingGuide.seen.v1', '1'));
  await page.exposeFunction('hdrAcceptanceEvent', (event) => report.events.push(event));
  await page.evaluate(() => window.ttcut.onTaskEvent((event) => window.hdrAcceptanceEvent(event)));
  const bootstrap = await page.evaluate(() => window.ttcut.bootstrap());
  assert.equal(bootstrap.components.media.available, true, JSON.stringify(bootstrap.components));
  assert.equal(bootstrap.components.analysis.available, true, JSON.stringify(bootstrap.components));
  for (const name of process.argv.includes('--xml-failures-only') ? [] : ['dv81', 'dv84']) {
    const source = path.join('/tmp/ttcut-hdr-export-samples', `${name}-original.mp4`);
    const sourceHash = await hash(source);
    const video = await page.evaluate(async (file) => { const selected = await window.ttcut.acceptDroppedVideo(file); return window.ttcut.probeVideo(selected.path); }, source);
    assert.equal(video.media_fidelity.hdr, 'dolbyVision');
    assert.equal(video.media_fidelity.dolby_vision.signal_compatibility_id, name === 'dv81' ? 1 : 4);
    const info = await stat(source);
    const id = randomUUID();
    const record = {
      schema_version: 1, id, analyzed_at: new Date().toISOString(),
      source: { path: source, name: path.basename(source), size: info.size, modified_time_ms: info.mtimeMs },
      calibration: { video_width: 1920, video_height: 1080, points: { top_left: [480, 270], top_right: [1440, 270], bottom_right: [1560, 810], bottom_left: [360, 810] } },
      analysis: { schema_version: 1, video, rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 15, end_time_seconds: 16 }] },
    };
    await writeFile(path.join(profile, 'history/records', `${id}.json`), JSON.stringify(record));
    for (const artifacts of [false, true]) {
      const request = { analysis_id: id, destination: 'source', selection: { mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 15, end_time_seconds: 16 }] }, ...(artifacts ? { outputs: { combined_video: false, rally_videos: true, premiere_xml: true } } : {}) };
      const taskId = await page.evaluate((input) => window.ttcut.startExport(input), request);
      const event = await waitFor(() => report.events.find((value) => value.taskId === taskId && ['error', 'export-result'].includes(value.type)));
      assert.equal(event.type, 'export-result', JSON.stringify(event));
      const file = artifacts ? event.data.rallyVideos[0]?.outputPath : event.data.outputPath;
      assert.ok(file, JSON.stringify(event));
      if (artifacts) {
        assert.equal(event.data.partialSuccess, false);
        assert.ok((await readFile(event.data.premiereXml.outputPath, 'utf8')).includes('<in>360</in>'));
        assert.deepEqual(event.data.requestedOutputs, { rallyVideos: true, premiereXml: true });
      } else {
        assert.equal(event.data.outputMediaFidelity.hdr, 'sdr');
        const preview = page.locator('video.output-preview');
        await expect(preview).toBeVisible();
        await expect(preview).toHaveAttribute('src', event.data.mediaUrl);
        await waitFor(() => preview.evaluate((element) => element.readyState >= 2 && element.videoWidth > 0));
        await preview.evaluate(async (element) => { element.currentTime = 0; await element.play(); });
        await waitFor(() => preview.evaluate((element) => element.currentTime > 0.2 && element.getVideoPlaybackQuality().totalVideoFrames > 2));
        await preview.evaluate((element) => element.pause());
        await page.screenshot({ path: path.join(run, `${name}-sdr-preview.png`) });
      }
      const stream = JSON.parse(execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file])).streams.find((value) => value.codec_type === 'video');
      assert.equal(stream.codec_name, 'h264'); assert.equal(stream.pix_fmt, 'yuv420p');
      for (const field of ['color_transfer', 'color_space', 'color_primaries']) assert.equal(stream[field], 'bt709');
      execute(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
      assert.equal(await hash(source), sourceHash);
      report.checks.push({ name, artifacts, output: file, xml: artifacts ? event.data.premiereXml.outputPath : undefined, stream, sourceHash });
      console.log(`PASS ${name}: ${artifacts ? 'rally video and XML' : 'combined SDR output and real preview playback'}`);
    }
  }
  if (process.argv.includes('--xml-failures-only')) {
    const source = path.join(run, 'original.mp4');
    execute(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', source]);
    const cached = path.join(run, 'deleted-cfr.mp4');
    await copyFile(source, cached);
    const original = await page.evaluate(async (file) => { await window.ttcut.acceptDroppedVideo(file); return window.ttcut.probeVideo(file); }, source);
    const id = randomUUID(), info = await stat(source);
    const record = {
      schema_version: 1, id, analyzed_at: new Date().toISOString(),
      source: { path: source, name: path.basename(source), size: info.size, modified_time_ms: info.mtimeMs },
      calibration: { video_width: 320, video_height: 180, points: { top_left: [80, 40], top_right: [240, 40], bottom_right: [280, 150], bottom_left: [40, 150] } },
      analysis: { schema_version: 1, video: { ...original, path: cached, native_video: { ...original.native_video, path: cached } },
        source_video: original, processing: { mode: 'normalized_cfr', target_fps_ratio: '24/1', encoder: 'libx265', warning_code: null },
        rallies: [{ id: 'rally_001', index: 1, bounce_count: 5, start_time_seconds: 1, end_time_seconds: 2 }] },
    };
    await writeFile(path.join(profile, 'history/records', `${id}.json`), JSON.stringify(record));
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.locator('.history-open').filter({ hasText: path.basename(source) }).click();
    await page.getByRole('button', { name: /Custom/ }).click();
    await page.getByRole('button', { name: 'Scoreboard', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start cutting', exact: true });
    const selectOutput = async (name) => {
      const checkbox = page.getByRole('checkbox', { name, exact: true });
      if (!await checkbox.isChecked()) await checkbox.locator('..').click();
      await expect(checkbox).toBeChecked();
    };
    await start.focus();
    await selectOutput('Export XML');
    await rm(cached);
    await page.evaluate(() => { document.fonts.load = () => Promise.reject(new Error('FONT_LOAD_FAILED')); });
    await start.click();
    await expect(page.getByRole('heading', { name: 'Export complete', exact: true })).toBeVisible();
    const xmlOnly = await waitFor(() => report.events.find((event) => event.type === 'export-result' && event.data.requestedOutputs?.premiereXml));
    assert.equal(xmlOnly.data.partialSuccess, false);
    assert.deepEqual(xmlOnly.data.requestedOutputs, { rallyVideos: false, premiereXml: true });
    const xml = await readFile(xmlOnly.data.premiereXml.outputPath, 'utf8');
    assert.ok(xml.includes('original.mp4'));
    assert.equal(JSON.parse(await readFile(path.join(profile, 'history/records', `${id}.json`), 'utf8')).analysis.video.path, cached);
    await expect(page.getByRole('alert')).toContainText('Could not save custom edits');
    await page.screenshot({ path: path.join(run, 'xml-after-cache-disappears.png') });
    report.checks.push({ name: 'real custom-editor XML export survives missing CFR cache and enabled scoreboard font failure', xml: xmlOnly.data.premiereXml.outputPath });
    console.log('PASS XML-only actual UI: missing cache, failed draft save, enabled scoreboard with unavailable fonts');
    await page.getByRole('button', { name: 'Auto Cut', exact: true }).click();
    // Reopen with a valid cache; the next failure belongs solely to scoreboard rendering.
    await copyFile(source, cached);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.locator('.history-open').filter({ hasText: path.basename(source) }).click();
    await page.getByRole('button', { name: /Custom/ }).click();
    const scoreboard = page.getByRole('button', { name: 'Scoreboard', exact: true });
    if (await scoreboard.getAttribute('aria-pressed') !== 'true') await scoreboard.click();
    await start.focus();
    await selectOutput('Export XML');
    await selectOutput('Export rally videos');
    const previous = report.events.length;
    await start.click();
    const partial = await waitFor(() => report.events.slice(previous).find((event) => ['error', 'export-result'].includes(event.type)));
    assert.equal(partial.type, 'export-result', JSON.stringify(partial));
    assert.equal(partial.data.partialSuccess, true);
    assert.deepEqual(partial.data.requestedOutputs, { rallyVideos: true, premiereXml: true });
    assert.equal(partial.data.failedRallies[0].code, 'SCOREBOARD_RENDER_FAILED');
    assert.equal(partial.data.rallyVideos.length, 0);
    assert.ok((await stat(partial.data.premiereXml.outputPath)).size > 0);
    await page.screenshot({ path: path.join(run, 'xml-retained-scoreboard-failure.png') });
    report.checks.push({ name: 'real custom-editor combined artifact request preserves XML and reports scoreboard video failure', result: partial.data });
    console.log('PASS video + XML actual UI: scoreboard failure retains XML and reports video failure independently');
  }
  assert.deepEqual(report.errors, []);
  console.log(`Acceptance evidence: ${run}`);
} catch (error) {
  report.failure = String(error.stack);
  await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => {});
  await instance.close();
}
