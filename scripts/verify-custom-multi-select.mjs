import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

// Focused renderer acceptance: deterministic board counts, not algorithm accuracy.
// Uses the unmodified packaged app with isolated history and synthetic media.
const root = path.resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const app = path.resolve(process.argv[2] ?? path.join(root, windows ? 'out/TTcut-win32-x64' : 'out/TTcut-darwin-arm64/TTcut.app'));
const ffmpeg = process.env.TTCUT_FFMPEG ?? (windows
  ? path.join(root, '.baseline/components/ffmpeg-n8.1.2-22-g94138f6973-win64-lgpl-shared-8.1/bin/ffmpeg.exe')
  : path.join(app, 'Contents/Resources/runtime/bin/ffmpeg'));
const output = path.join(root, 'output/custom-multi-select');
await mkdir(output, { recursive: true });
const run = await mkdtemp(path.join(output, 'run-'));
const userData = path.join(run, 'user-data');
const media = path.join(run, 'multi-select-fixture.mp4');
const generated = spawnSync(ffmpeg, [
  '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=15',
  '-c:v', windows ? 'libopenh264' : 'libx264', '-pix_fmt', 'yuv420p', media,
], { encoding: 'utf8', windowsHide: true });
assert.equal(generated.status, 0, generated.stderr);
const source = await stat(media);
const id = randomUUID();
const analyzedAt = new Date().toISOString();
const rallies = [2, 5, 6, 10, 11].map((count, index) => ({
  id: `rally_${String(index + 1).padStart(3, '0')}`, index: index + 1, bounce_count: count,
  start_time_seconds: .5 + index * 2.5, end_time_seconds: 2.5 + index * 2.5,
}));
const analysis = {
  schema_version: 3,
  video: { path: media, duration_seconds: 15, width: 320, height: 180, fps: 15,
    variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4' },
  rallies,
  bounce_times_seconds: rallies.flatMap(rally => Array.from({ length: rally.bounce_count }, (_, index) =>
    rally.start_time_seconds + 1.8 * (index + 1) / (rally.bounce_count + 1))),
  rally_recognition: { method: 'continuous_visibility', start_visible_seconds: .2, end_invisible_seconds: .5,
    board_count: { detector: 'blurball_trajectory_change', source_path: 'worker/ttcut_worker/blurball_bounce.py',
      source_sha256: 'e1e7674cd1209a6f4deffe5ff0e57633e2859605f031b1c012cb2d16c9f49ea8',
      minimum_interval_seconds: .315, landing_region: 'expanded_table',
      table_length_margin_cm: 35, table_width_margin_cm: 25 } },
};
if (windows) {
  // Exercise the existing production Windows contract, without another detector.
  analysis.rally_recognition = JSON.parse(await readFile(path.join(root, 'tests/fixtures/hybrid-provenance.json'), 'utf8'));
  analysis.excluded_fragments = [];
}
await mkdir(path.join(userData, 'history/records'), { recursive: true });
await writeFile(path.join(userData, 'history/records', `${id}.json`), JSON.stringify({
  schema_version: 1, id, analyzed_at: analyzedAt,
  source: { path: media, name: path.basename(media), size: source.size, modified_time_ms: source.mtimeMs },
  calibration: { video_width: 320, video_height: 180,
    points: { top_left: [60, 40], top_right: [250, 40], bottom_right: [275, 145], bottom_left: [40, 145] } },
  analysis, visible_in_history: true, completion_kind: 'analysis', output_path: null,
}));
await writeFile(path.join(userData, 'history/index.json'), JSON.stringify({
  schema_version: 1, entries: [{ id, analyzed_at: analyzedAt }],
}));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const child = spawn(path.join(app, windows ? 'TTcut.exe' : 'Contents/MacOS/TTcut'), [
  `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, ...(windows ? {
    TTCUT_FFMPEG: ffmpeg, TTCUT_FFPROBE: path.join(path.dirname(ffmpeg), 'ffprobe.exe'),
  } : {}) } });
let log = '';
child.stdout.on('data', data => { log += data; });
child.stderr.on('data', data => { log += data; });
let browser;
let page;
const checks = [];
async function check(name, work) {
  await work();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function selected() {
  return page.locator('.custom-rally-table input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => input.checked));
}
async function openReview(language) {
  await page.getByRole('button', { name: language === 'en' ? 'History' : '历史剪辑', exact: true }).click();
  await page.locator('.history-open').first().click();
  await page.locator('.mode-card').filter({ hasText: language === 'en' ? 'Custom' : '自定义' }).click();
  await page.locator('.custom-rally-table tbody tr').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.custom-monitor video')?.readyState >= 2);
  // Container-query video sizing settles after the review page mounts.
  await page.waitForTimeout(300);
}
try {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !browser) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { if (child.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(browser, 'Packaged app CDP unavailable');
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = browser.contexts()[0]?.pages()[0];
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Renderer unavailable');
  await page.waitForFunction(() => Boolean(window.ttcut));
  await browser.contexts()[0].setOffline(true);
  const bootstrap = await page.evaluate(() => window.ttcut.bootstrap());
  await page.evaluate(settings => window.ttcut.saveSettings({ ...settings, language: 'zh-CN' }), bootstrap.settings);
  await page.reload();
  await openReview('zh-CN');
  const trigger = page.getByRole('button', { name: '多选', exact: true });
  const before = await page.locator('.custom-monitor').boundingBox();
  await check('downward card stays inside rally list without moving video', async () => {
    assert.equal(await page.getByRole('button', { name: '全选', exact: true }).count(), 0);
    await trigger.click();
    const card = page.getByRole('dialog', { name: '多选选项' });
    await card.waitFor();
    await page.waitForTimeout(200);
    const box = await card.boundingBox();
    const list = await page.locator('.custom-rally-list').boundingBox();
    assert.ok(box.x >= list.x && box.x + box.width <= list.x + list.width);
    assert.ok(box.y >= (await trigger.boundingBox()).y + (await trigger.boundingBox()).height);
    assert.deepEqual(await page.locator('.custom-monitor').boundingBox(), before);
    assert.match(await card.innerText(), /≥/);
    await page.screenshot({ path: path.join(run, 'multi-select-zh.png') });
    await trigger.click();
    assert.deepEqual(await page.locator('.custom-monitor').boundingBox(), before);
    await trigger.click();
  });
  await check('Enter 5 selects equal and higher counts without removing rows or seeking', async () => {
    const monitor = page.locator('.custom-monitor video');
    await monitor.evaluate(video => { video.pause(); video.currentTime = 4; });
    const input = page.getByRole('textbox', { name: '板数大于等于' });
    await input.fill('5');
    assert.deepEqual(await selected(), [true, true, true, true, true]);
    await input.press('Enter');
    assert.deepEqual(await selected(), [false, true, true, true, true]);
    assert.equal(await page.locator('.custom-rally-table tbody tr').count(), 5);
    assert.ok(await monitor.evaluate(video => video.paused && Math.abs(video.currentTime - 4) < .1));
    assert.equal(await page.getByRole('dialog').count(), 0);
  });
  await check('input accepts only 1–10 and threshold 10 includes both 10 and 11', async () => {
    await trigger.click();
    const input = page.getByRole('textbox', { name: '板数大于等于' });
    await input.fill('');
    await input.press('Enter');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    for (const value of ['0', '11', 'ab', '-1', '01']) {
      await input.fill(value);
      assert.equal(await input.inputValue(), '');
    }
    await input.fill('1');
    assert.equal(await input.inputValue(), '1');
    await input.fill('10');
    await input.press('Enter');
    assert.deepEqual(await selected(), [false, false, false, true, true]);
  });
  await check('Select all, Clear all, Escape and outside click', async () => {
    await trigger.click();
    await page.getByRole('button', { name: '全选', exact: true }).click();
    assert.deepEqual(await selected(), [true, true, true, true, true]);
    await page.getByRole('button', { name: '取消全选', exact: true }).click();
    assert.deepEqual(await selected(), [false, false, false, false, false]);
    await trigger.click();
    await page.getByRole('textbox', { name: '板数大于等于' }).press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click();
    await page.locator('.custom-monitor').click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  });
  await check('English card fits and displays inclusive comparator', async () => {
    await page.evaluate(settings => window.ttcut.saveSettings({ ...settings, language: 'en' }), bootstrap.settings);
    await page.reload();
    await openReview('en');
    await page.getByRole('button', { name: 'Multi-select', exact: true }).click();
    const card = page.getByRole('dialog', { name: 'Multi-select options' });
    await card.waitFor();
    await page.waitForTimeout(200);
    assert.match(await card.innerText(), /≥/);
    assert.ok(await card.evaluate(element => element.scrollWidth <= element.clientWidth));
    assert.ok(await page.locator('.custom-rally-list .table-tools').evaluate(element => element.scrollWidth <= element.clientWidth));
    for (const selector of ['.custom-list-selection strong', '.custom-list-actions .text-button']) {
      assert.ok(await page.locator(selector).evaluateAll(elements => elements.every(element => getComputedStyle(element).whiteSpace === 'nowrap')));
    }
    await page.screenshot({ path: path.join(run, 'multi-select-en.png') });
  });
  await page.getByRole('textbox', { name: 'Bounces at least' }).press('Escape');
  await check('shared timeline boundary follows mouse direction and playhead does not block track', async () => {
    const left = page.locator('.timeline-clip').nth(0);
    const right = page.locator('.timeline-clip').nth(1);
    const leftEnd = left.locator('.clip-handle.end');
    const rightStart = right.locator('.clip-handle.start');
    const end = Number(await leftEnd.getAttribute('aria-valuenow'));
    const start = Number(await rightStart.getAttribute('aria-valuenow'));
    assert.ok(Math.abs(end - start) < 1e-6, 'Fixture must contain adjacent selected clips');
    const box = await right.boundingBox();
    const y = box.y + box.height / 2;
    // Put the playhead exactly on the shared boundary using the ruler.
    const ruler = await page.locator('.timeline-ruler').boundingBox();
    await page.mouse.click(box.x, ruler.y + 18);
    assert.ok(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.clip-handle')), { x: box.x, y }));
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, y, { steps: 5 });
    assert.equal(await page.locator('.resize-feedback').getAttribute('data-edge'), 'end');
    assert.equal(await page.locator('.resize-feedback').getAttribute('data-clip-id'), 'rally_001');
    await page.mouse.up();
    assert.ok(Number(await leftEnd.getAttribute('aria-valuenow')) < end);
    assert.equal(Number(await rightStart.getAttribute('aria-valuenow')), start);
    // Restore adjacency with the real keyboard handle, then drag right.
    await leftEnd.press('Shift+ArrowRight');
    assert.equal(Number(await leftEnd.getAttribute('aria-valuenow')), start);
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, y, { steps: 5 });
    assert.equal(await page.locator('.resize-feedback').getAttribute('data-edge'), 'start');
    assert.equal(await page.locator('.resize-feedback').getAttribute('data-clip-id'), 'rally_002');
    await page.mouse.up();
    assert.ok(Number(await rightStart.getAttribute('aria-valuenow')) > start);
    assert.equal(Number(await leftEnd.getAttribute('aria-valuenow')), start);
    assert.equal(await left.evaluate(element => getComputedStyle(element).borderRadius), '6px');
    await page.screenshot({ path: path.join(run, 'timeline-resize.png') });
  });
  console.log(`Verification: ${run}`);
} catch (error) {
  checks.push({ name: 'acceptance', passed: false, error: String(error) });
  if (page) await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ app, fixtureCounts: [2, 5, 6, 10, 11], checks }, null, 2));
  if (page) await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => {});
  if (child.exitCode === null) child.kill('SIGTERM');
  await browser?.close().catch(() => {});
  await writeFile(path.join(run, 'electron.log'), log);
}
