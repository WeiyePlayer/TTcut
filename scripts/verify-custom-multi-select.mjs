import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { expect } from '@playwright/test';
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
const media = path.join(run, 'macos-continuous-board-count.mp4');
const hybridMedia = path.join(run, 'windows-hybrid-board-count.mp4');
const legacyMedia = path.join(run, 'legacy-continuous-no-board-count.mp4');
const generated = spawnSync(ffmpeg, [
  '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=15',
  '-c:v', windows ? 'libopenh264' : 'libx264', '-pix_fmt', 'yuv420p', media,
], { encoding: 'utf8', windowsHide: true });
assert.equal(generated.status, 0, generated.stderr);
await copyFile(media, hybridMedia);
await copyFile(media, legacyMedia);
const rallies = [2, 5, 6, 10, 11].map((count, index) => ({
  id: `rally_${String(index + 1).padStart(3, '0')}`, index: index + 1, bounce_count: count,
  start_time_seconds: .5 + index * 2.5, end_time_seconds: 2.5 + index * 2.5,
}));
const videoMetadata = mediaPath => ({
  path: mediaPath, duration_seconds: 15, width: 320, height: 180, fps: 15,
  variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4',
});
const bounceTimes = rallies.flatMap(rally => Array.from({ length: rally.bounce_count }, (_, index) =>
  rally.start_time_seconds + 1.8 * (index + 1) / (rally.bounce_count + 1)));
const analysis = {
  schema_version: 3,
  video: videoMetadata(media),
  rallies,
  bounce_times_seconds: bounceTimes,
  rally_recognition: { method: 'continuous_visibility', start_visible_seconds: .2, end_invisible_seconds: .5,
    board_count: { detector: 'blurball_trajectory_change', source_path: 'worker/ttcut_worker/blurball_bounce.py',
      source_sha256: 'e1e7674cd1209a6f4deffe5ff0e57633e2859605f031b1c012cb2d16c9f49ea8',
      minimum_interval_seconds: .315, landing_region: 'expanded_table',
      table_length_margin_cm: 35, table_width_margin_cm: 25 } },
};
const hybridAnalysis = {
  ...analysis, video: videoMetadata(hybridMedia),
  rally_recognition: JSON.parse(await readFile(path.join(root, 'tests/fixtures/hybrid-provenance.json'), 'utf8')),
  excluded_fragments: [],
};
const legacyAnalysis = {
  schema_version: 2,
  video: videoMetadata(legacyMedia),
  rallies: rallies.map(({ bounce_count: _count, ...rally }) => rally),
  rally_recognition: { method: 'continuous_visibility', start_visible_seconds: .2, end_invisible_seconds: .5 },
};
await mkdir(path.join(userData, 'history/records'), { recursive: true });
const calibration = { video_width: 320, video_height: 180,
  points: { top_left: [60, 40], top_right: [250, 40], bottom_right: [275, 145], bottom_left: [40, 145] } };
const records = [
  { id: randomUUID(), media, analysis, analyzedAt: new Date(Date.now() + 2_000).toISOString() },
  { id: randomUUID(), media: hybridMedia, analysis: hybridAnalysis, analyzedAt: new Date(Date.now() + 1_000).toISOString() },
  { id: randomUUID(), media: legacyMedia, analysis: legacyAnalysis, analyzedAt: new Date().toISOString() },
];
for (const record of records) {
  const source = await stat(record.media);
  await writeFile(path.join(userData, 'history/records', `${record.id}.json`), JSON.stringify({
    schema_version: 1, id: record.id, analyzed_at: record.analyzedAt,
    source: { path: record.media, name: path.basename(record.media), size: source.size, modified_time_ms: source.mtimeMs },
    calibration, analysis: record.analysis, visible_in_history: true, completion_kind: 'analysis', output_path: null,
  }));
}
await writeFile(path.join(userData, 'history/index.json'), JSON.stringify({
  schema_version: 1, entries: records.map(record => ({ id: record.id, analyzed_at: record.analyzedAt })),
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
let timelineEvidence = null;
async function check(name, work) {
  await work();
  checks.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
async function selected() {
  return page.locator('.custom-rally-table input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => input.checked));
}
async function openReview(language, videoName) {
  await page.getByRole('button', { name: language === 'en' ? 'History' : '历史剪辑', exact: true }).click();
  const historyCard = page.locator('.history-card').filter({ hasText: videoName });
  await historyCard.waitFor({ state: 'visible' });
  assert.equal(await historyCard.count(), 1, `Expected one history card for ${videoName}`);
  await historyCard.locator('.history-open').click();
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
  await check('packaged Windows Worker keeps full-frame BlurBall inference', async () => {
    const sourcePredictor = await readFile(path.join(root, 'worker/ttcut_worker/blurball_predictor.py'), 'utf8');
    const packagedPredictor = await readFile(path.join(app, 'resources/worker/ttcut_worker/blurball_predictor.py'), 'utf8');
    assert.equal(packagedPredictor, sourcePredictor, 'Packaged BlurBall predictor must match the audited source');
    assert.doesNotMatch(packagedPredictor, /temporal_stride|interpolated_frames|F1\/F4\/F7/);
    assert.match(packagedPredictor, /for packet in reader:\r?\n\s+packets\.append\(packet\)/);
  });
  await openReview('zh-CN', path.basename(media));
  await check('macOS continuous-v3 board metadata appears exactly once', async () => {
    assert.deepEqual(await page.locator('.custom-rally-meta span').allInnerTexts(), ['板数 2', '板数 5', '板数 6', '板数 10', '板数 11']);
  });
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
    await openReview('en', path.basename(media));
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
  await check('packaged timeline keeps a current editing rally and applies A/D boundaries', async () => {
    const monitor = page.locator('.custom-monitor video');
    const playhead = page.locator('.timeline-playhead');
    const clip = id => page.locator(`.timeline-clip[data-clip-id="${id}"]`);
    const clipRange = async id => ({
      start: Number(await clip(id).locator('.clip-handle.start').getAttribute('aria-valuenow')),
      end: Number(await clip(id).locator('.clip-handle.end').getAttribute('aria-valuenow')),
    });
    const setTime = async time => {
      await monitor.evaluate(video => video.pause());
      const ruler = await page.locator('.timeline-ruler').boundingBox();
      await page.mouse.click(ruler.x + ruler.width * time / 15, ruler.y + ruler.height / 2);
      await expect.poll(async () => Number(await playhead.getAttribute('aria-valuenow'))).toBeGreaterThan(time - .1);
      return Number(await playhead.getAttribute('aria-valuenow'));
    };

    const first = await clipRange('rally_001');
    const second = await clipRange('rally_002');
    const firstStart = await setTime((first.start + first.end) / 2);
    await expect(clip('rally_001')).toHaveClass(/current-editing/);
    await page.keyboard.press('KeyA');
    assert.ok(Math.abs(Number(await clip('rally_001').locator('.clip-handle.start').getAttribute('aria-valuenow')) - firstStart) < 1e-6);

    const shortenedEnd = await setTime(Math.min(first.end - 1 / 15, firstStart + .25));
    await page.keyboard.press('KeyD');
    assert.ok(Math.abs(Number(await clip('rally_001').locator('.clip-handle.end').getAttribute('aria-valuenow')) - shortenedEnd) < 1e-6);
    assert.ok(second.start > shortenedEnd, 'Editing the first clip must create a gap before the second clip');
    await setTime((shortenedEnd + second.start) / 2);
    await expect(clip('rally_001')).toHaveClass(/current-editing/);
    const secondEnd = await setTime((second.start + second.end) / 2);
    await expect(clip('rally_002')).toHaveClass(/current-editing/);
    await page.keyboard.press('KeyD');
    assert.ok(Math.abs(Number(await clip('rally_002').locator('.clip-handle.end').getAttribute('aria-valuenow')) - secondEnd) < 1e-6);

    const ranges = await page.locator('.timeline-clip').evaluateAll(elements => elements.map(element => ({
      start: Number(element.querySelector('.clip-handle.start')?.getAttribute('aria-valuenow')),
      end: Number(element.querySelector('.clip-handle.end')?.getAttribute('aria-valuenow')),
    })));
    let addTime = null;
    for (let candidate = 0; candidate <= 14; candidate += .25) {
      if (ranges.every(range => candidate >= range.end || candidate + 1 <= range.start)) {
        addTime = candidate;
        break;
      }
    }
    assert.notEqual(addTime, null, `Fixture must leave room for a one-second manual clip: ${JSON.stringify(ranges)}`);
    await page.getByRole('button', { name: 'Add rally', exact: true }).click();
    const manualStart = await setTime(addTime);
    await page.keyboard.press('KeyA');
    const manual = page.locator('.timeline-clip[data-clip-id^="manual_"]');
    await expect(manual).toHaveCount(1);
    await expect(manual).toHaveClass(/current-editing/);
    const manualEnd = await setTime(manualStart + .7);
    await page.keyboard.press('KeyD');
    await page.getByRole('button', { name: 'Add rally', exact: true }).click();
    assert.ok(Math.abs(Number(await manual.locator('.clip-handle.end').getAttribute('aria-valuenow')) - manualEnd) < 1e-6);
    await page.screenshot({ path: path.join(run, 'current-editing-rally-en.png') });

    await page.getByRole('button', { name: 'Delete rally', exact: true }).click();
    await manual.click();
    await expect(manual).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete rally', exact: true }).click();
    await page.reload();
    await openReview('en');
  });
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
    const track = page.locator('.timeline-track-window');
    const trackBox = await track.boundingBox();
    const trackRadius = await track.evaluate(element => getComputedStyle(element).borderRadius);
    const clipRadius = await left.evaluate(element => getComputedStyle(element).borderRadius);
    assert.equal(trackRadius, '6px');
    assert.equal(clipRadius, '6px');
    // Put the playhead exactly on the shared boundary using the ruler.
    const ruler = await page.locator('.timeline-ruler').boundingBox();
    await page.mouse.click(box.x, ruler.y + 18);
    const playheadBox = await page.locator('.timeline-playhead').boundingBox();
    assert.ok(playheadBox.y + playheadBox.height <= trackBox.y + 1, 'Playhead hit target must end above the clip track');
    const hitTarget = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return { className: target?.className ?? '', handle: target?.closest('.clip-handle')?.className ?? null };
    }, { x: box.x, y });
    assert.ok(hitTarget.handle, 'Shared boundary must remain reachable while the playhead is aligned');
    await page.screenshot({ path: path.join(run, 'timeline-playhead-boundary.png') });
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 20, y, { steps: 5 });
    const leftFeedback = page.locator('.resize-feedback');
    assert.equal(await leftFeedback.getAttribute('data-edge'), 'end');
    assert.equal(await leftFeedback.getAttribute('data-clip-id'), 'rally_001');
    const leftFeedbackText = await leftFeedback.innerText();
    await page.screenshot({ path: path.join(run, 'timeline-drag-left.png') });
    await page.mouse.up();
    const leftAfter = Number(await leftEnd.getAttribute('aria-valuenow'));
    assert.ok(leftAfter < end);
    assert.equal(Number(await rightStart.getAttribute('aria-valuenow')), start);
    // Restore adjacency with the real keyboard handle, then drag right.
    await leftEnd.press('Shift+ArrowRight');
    assert.equal(Number(await leftEnd.getAttribute('aria-valuenow')), start);
    await page.mouse.move(box.x, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, y, { steps: 5 });
    const rightFeedback = page.locator('.resize-feedback');
    assert.equal(await rightFeedback.getAttribute('data-edge'), 'start');
    assert.equal(await rightFeedback.getAttribute('data-clip-id'), 'rally_002');
    const rightFeedbackText = await rightFeedback.innerText();
    await page.screenshot({ path: path.join(run, 'timeline-drag-right.png') });
    await page.mouse.up();
    const rightAfter = Number(await rightStart.getAttribute('aria-valuenow'));
    assert.ok(rightAfter > start);
    assert.equal(Number(await leftEnd.getAttribute('aria-valuenow')), start);
    timelineEvidence = {
      sharedBoundarySeconds: start,
      trackRadius,
      clipRadius,
      playheadBottom: playheadBox.y + playheadBox.height,
      trackTop: trackBox.y,
      hitTarget,
      leftDrag: { feedback: leftFeedbackText, before: end, after: leftAfter, untouchedRightStart: start },
      rightDrag: { feedback: rightFeedbackText, before: start, after: rightAfter, untouchedLeftEnd: start },
    };
    await page.screenshot({ path: path.join(run, 'timeline-final.png') });
  });
  await openReview('en', path.basename(hybridMedia));
  await check('Windows hybrid board counts use the same single UI path', async () => {
    assert.deepEqual(await page.locator('.custom-rally-meta span').allInnerTexts(), ['Bounces 2', 'Bounces 5', 'Bounces 6', 'Bounces 10', 'Bounces 11']);
    await page.getByRole('button', { name: 'Multi-select', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Bounces at least' });
    assert.equal(await input.isEnabled(), true);
    await input.fill('6');
    await input.press('Enter');
    assert.deepEqual(await selected(), [false, false, true, true, true]);
    await page.screenshot({ path: path.join(run, 'windows-hybrid-filter.png') });
  });
  await openReview('en', path.basename(legacyMedia));
  await check('legacy continuous history disables unavailable board filtering', async () => {
    assert.deepEqual(await page.locator('.custom-rally-meta span').allInnerTexts(), []);
    await page.getByRole('button', { name: 'Multi-select', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Bounces at least' });
    assert.equal(await input.isDisabled(), true);
    assert.equal(await page.locator('.custom-bounce-filter small').innerText(), 'Reanalyze to filter by bounce count');
    assert.equal(await page.getByRole('button', { name: 'Select all', exact: true }).isEnabled(), true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(run, 'legacy-filter-disabled.png') });
  });
  console.log(`Verification: ${run}`);
} catch (error) {
  checks.push({ name: 'acceptance', passed: false, error: String(error) });
  if (page) await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(run, 'report.json'), JSON.stringify({
    app,
    fixtures: {
      macosContinuousV3: [2, 5, 6, 10, 11],
      windowsHybrid: [2, 5, 6, 10, 11],
      legacyContinuousV2: 'no board metadata',
    },
    timelineEvidence,
    checks,
  }, null, 2));
  if (page) await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => {});
  if (child.exitCode === null) child.kill('SIGTERM');
  await browser?.close().catch(() => {});
  await writeFile(path.join(run, 'electron.log'), log);
}
