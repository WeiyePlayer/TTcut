// Packaged macOS acceptance for the post-v1.3.7 editor port. All data is isolated.
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const scoreEditOnly = process.argv.includes('--score-edit-only');
const app = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? path.join(root, 'out/TTcut-darwin-arm64/TTcut.app'));
const output = path.join(root, 'output/macos-post137');
await mkdir(output, { recursive: true });
const resume = process.env.TTCUT_VERIFY_RESUME_RUN;
const run = resume ? path.resolve(resume) : await mkdtemp(path.join(output, 'app-'));
if (resume) assert.ok((await stat(path.join(app, 'Contents/Resources/app.asar'))).mtimeMs < (await stat(path.join(run, 'report.json'))).mtimeMs, 'Rebuilt apps require a fresh run');
const profile = path.join(run, 'profile');
const ffmpeg = path.join(app, 'Contents/Resources/runtime/bin/ffmpeg');
const media = path.join(run, '积分牌 测试.mp4');
function ff(args) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
if (!resume) ff(['-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=30:d=12', '-f', 'lavfi', '-i', 'sine=duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', media]);
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
let child, browser, page, stderr = '';
const report = resume ? JSON.parse(await readFile(path.join(run, 'report.json'), 'utf8')) : { app, run, checks: [], errors: [] };
assert.equal(report.app, app);
async function check(name, work) {
  if (scoreEditOnly && !name.startsWith('score editing:') && !name.startsWith('draft IPC')) return;
  if (resume && report.checks.some(check => check.name === name && check.passed)) return;
  const detail = await work(); report.checks.push({ name, passed: true, ...(detail ? { detail } : {}) });
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); console.log('PASS', name);
}
async function launch() {
  child = spawn(path.join(app, 'Contents/MacOS/TTcut'), [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
    { env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { stderr += data; }); child.stdout.on('data', data => { stderr += data; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    return fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok).catch(() => false);
  }, { timeout: 45000 }).toBe(true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await expect.poll(() => browser.contexts()[0]?.pages().length).toBeGreaterThan(0);
  page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.ttcut));
  await page.context().setOffline(true);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => {});
  await expect.poll(() => child.exitCode, { timeout: 20000 }).not.toBeNull();
  await browser?.close();
}
async function task(method, input) {
  await page.evaluate(() => { if (!window.__events) { window.__events = []; window.ttcut.onTaskEvent(event => window.__events.push(event)); } });
  const id = await page.evaluate(({ method, input }) => window.ttcut[method](input), { method, input });
  await page.waitForFunction(id => window.__events.some(event => event.taskId === id && ['analysis-result', 'export-result', 'error'].includes(event.type)), id, { timeout: 180000 });
  const result = await page.evaluate(id => window.__events.find(event => event.taskId === id && ['analysis-result', 'export-result', 'error'].includes(event.type)), id);
  assert.notEqual(result.type, 'error', JSON.stringify(result)); return result;
}
async function openEditor() {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('.history-open').first().click();
  await page.locator('.mode-card').filter({ hasText: 'Custom' }).click();
  await expect(page.locator('.custom-monitor video')).toBeVisible();
  await expect.poll(() => page.locator('.custom-monitor video').evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
}
const state = () => page.locator('.custom-monitor video').evaluate(v => ({ time: v.currentTime, paused: v.paused, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
async function pause() { if (!(await state()).paused) await page.keyboard.press('Space'); await expect.poll(async () => (await state()).paused).toBe(true); }
try {
  await launch();
  const bootstrap = await page.evaluate(() => window.ttcut.bootstrap());
  assert.equal(bootstrap.components.analysis.acceleration, 'coreml');
  assert.equal(bootstrap.capabilities.shutdown, false); assert.equal(bootstrap.capabilities.automaticUpdates, false);
  await page.evaluate(settings => window.ttcut.saveSettings({ ...settings, language: 'en' }), bootstrap.settings);
  await page.reload(); await page.waitForFunction(() => Boolean(window.ttcut));
  const calibration = { video_width: 640, video_height: 360, points: { top_left: [120, 80], top_right: [500, 80], bottom_right: [550, 290], bottom_left: [80, 290] } };
  const input = { videoPath: media, calibrationChoice: { method: 'manual', calibration }, device: 'auto', historyVisibility: 'visible', normalizeVariableFrameRate: false };
  const analyzed = resume
    ? { analysisId: (await readdir(path.join(profile, 'history/records'))).find(file => file.endsWith('.json')).slice(0, -5) }
    : await task('startAnalysis', input);
  const id = analyzed.analysisId;
  const recordPath = path.join(profile, 'history/records', id + '.json');
  const saved = async () => JSON.parse(await readFile(recordPath, 'utf8')).custom_editor_draft;
  const draft = {
    schema_version: 1, playbackMode: 'source', outputs: { combined_video: true, rally_videos: false, premiere_xml: false },
    scoreboard: { enabled: true, x: .1, y: .1, scale: 1.5, left_name: 'A', right_name: 'B' },
    clips: [1, 4, 8].map((start, index) => ({ clipId: 'manual_' + randomUUID(), source: 'manual', sourceRallyId: null,
      rallyIndex: index + 1, bounceCount: 0, defaultStart: start, defaultEnd: start + 2, start, end: start + 2, selected: index < 2 })),
  };
  await check('draft IPC validates ranges and persists edited clips', async () => {
    await page.evaluate(({ id, draft }) => window.ttcut.saveCustomEditorDraft(id, draft), { id, draft });
    assert.deepEqual(await saved(), draft);
    const invalid = structuredClone(draft); invalid.clips[0].end = 100;
    const rejected = await page.evaluate(async ({ id, draft }) => {
      try { await window.ttcut.saveCustomEditorDraft(id, draft); return false; } catch { return true; }
    }, { id, draft: invalid });
    assert.equal(rejected, true); assert.deepEqual(await saved(), draft);
  });
  await openEditor();
  await check('score editing: initial zeros, gaps, playback, cancel and persisted per-rally numbers', async () => {
    const cell = (row, field) => page.locator('.custom-scoreboard-row').nth(row).locator('.custom-scoreboard-' + field);
    const edit = async (row, field, value, key = 'Enter') => {
      const target = cell(row, field);
      await target.dblclick();
      const input = target.locator('input');
      await expect(input).toBeVisible(); await expect(input).toBeFocused();
      await input.fill(value); await input.press(key);
    };
    const seek = async time => {
      const ruler = await page.locator('.timeline-ruler').boundingBox();
      await page.mouse.click(ruler.x + ruler.width * time / 12, ruler.y + 12);
      await expect.poll(async () => Math.abs((await state()).time - time)).toBeLessThan(.1);
    };
    assert.ok((await state()).time < 1, 'Start outside the first selected rally');
    for (const [row, field, value] of [[0, 'games', '1'], [1, 'games', '2'], [0, 'points', '04'], [1, 'points', '3']]) await edit(row, field, value);
    await expect.poll(async () => (await saved()).clips[0].score).toEqual({ left: 4, right: 3, left_games: 1, right_games: 2 });
    await expect(page.locator('.custom-scoreboard-winner').first()).toBeDisabled();
    await seek(3.5); // Gap before rally 2: edit the upcoming selected rally.
    await edit(0, 'points', '6');
    await expect.poll(async () => (await saved()).clips[1].score?.left).toBe(6);
    assert.equal((await saved()).clips[0].score.left, 4);
    await seek(8.5); // Unselected rally after the final selected rally.
    await edit(1, 'points', '8');
    await expect.poll(async () => (await saved()).clips[1].score?.right).toBe(8);
    assert.equal((await saved()).clips[2].score, undefined);
    await page.locator('.custom-rally-table tbody tr').first().click();
    await expect.poll(async () => (await state()).time).toBeGreaterThan(1.1);
    await cell(0, 'points').dblclick();
    await expect(cell(0, 'points').locator('input')).toBeFocused();
    await expect.poll(async () => (await state()).paused).toBe(true);
    const pausedAt = (await state()).time;
    await cell(0, 'points').locator('input').fill('9');
    // Longer than the remaining rally: the editor must keep focus and its original target.
    await page.waitForTimeout(2200);
    assert.ok(Math.abs((await state()).time - pausedAt) < .05);
    await expect(cell(0, 'points').locator('input')).toBeFocused();
    await page.screenshot({ path: path.join(run, 'score-number-editing.png') });
    await cell(0, 'points').locator('input').press('Escape');
    await expect(cell(0, 'points')).toHaveText('4');
    // Blur also commits, just like the player name editor.
    await cell(1, 'games').dblclick(); await cell(1, 'games').locator('input').fill('5');
    await page.getByRole('button', { name: 'Scoreboard', exact: true }).focus();
    await expect.poll(async () => (await saved()).clips[0].score?.right_games).toBe(5);
    const before = await saved();
    await stop(); await launch(); await openEditor();
    assert.deepEqual(await saved(), before);
    await expect(cell(0, 'points')).toHaveText('4'); await expect(cell(1, 'games')).toHaveText('5');
    if (!scoreEditOnly) {
      // Keep the existing export/score-inheritance acceptance independent of this regression.
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.evaluate(({ id, draft }) => window.ttcut.saveCustomEditorDraft(id, draft), { id, draft });
      await page.reload(); await page.waitForFunction(() => Boolean(window.ttcut)); await openEditor();
    }
    return { firstScore: before.clips[0].score, secondScore: before.clips[1].score, pausedAt };
  });
  await check('six scoreboard fields support Chinese names, scores, Escape and wheel input', async () => {
    await page.locator('.custom-rally-table tbody tr').first().click();
    await expect.poll(async () => (await state()).time).toBeGreaterThan(1.05); await pause();
    for (const [row, field, value] of [[0, 'name', '林昀儒 LIN'], [1, 'name', '王楚钦 WANG'], [0, 'games', '1'], [1, 'games', '2'], [0, 'points', '04'], [1, 'points', '3']]) {
      const cell = page.locator('.custom-scoreboard-row').nth(row).locator('.custom-scoreboard-' + field);
      await cell.dblclick(); const edit = cell.locator('input'); await edit.fill(value);
      await expect(edit).toBeVisible(); await expect(edit).toBeFocused();
      if (field === 'name') await page.screenshot({ path: path.join(run, `typing-${row}.png`) });
      await edit.press('Enter');
    }
    await expect.poll(async () => (await saved()).clips[0].score?.left).toBe(4);
    const points = page.locator('.custom-scoreboard-points').first();
    await points.dblclick(); await points.locator('input').fill('9'); await points.locator('input').press('Escape');
    await expect(points).toHaveText('4');
    await points.hover(); await page.mouse.wheel(0, -100); await expect(points).toHaveText('5');
    await page.mouse.wheel(0, 100); await expect(points).toHaveText('4');
    assert.equal((await state()).paused, true);
  });
  await check('winner advances to next selected rally and carries score forward', async () => {
    await page.locator('.custom-scoreboard-winner').first().click();
    await expect.poll(async () => (await state()).time).toBeGreaterThanOrEqual(4); await pause();
    await expect(page.locator('.custom-scoreboard-points').first()).toHaveText('5');
    await expect(page.locator('.custom-scoreboard-points').last()).toHaveText('3');
    assert.equal((await saved()).clips[0].winner, 'left');
  });
  await check('scoreboard drag and proportional resize stay within the video', async () => {
    const board = page.locator('.custom-scoreboard'); let bounds = await board.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * .4, bounds.y + bounds.height * .3); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .4 + 35, bounds.y + bounds.height * .3 + 25, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await saved()).scoreboard.x).toBeGreaterThan(.1);
    await board.hover(); const handle = await page.getByRole('button', { name: 'Resize scoreboard bottom-right', exact: true }).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 25, handle.y + handle.height / 2 + 5, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await saved()).scoreboard.scale).toBeGreaterThan(1.5);
    const plane = await page.locator('.custom-scoreboard-plane').boundingBox(); bounds = await board.boundingBox();
    assert.ok(bounds.x >= plane.x - 1 && bounds.x + bounds.width <= plane.x + plane.width + 1);
    assert.ok(bounds.y >= plane.y - 1 && bounds.y + bounds.height <= plane.y + plane.height + 1);
  });
  await check('loop playback wraps with continuing decoded frames and keeps list selection', async () => {
    await page.getByRole('button', { name: 'Sequential playback', exact: true }).click();
    await page.getByRole('button', { name: 'Rally playback', exact: true }).click();
    await page.locator('.custom-rally-table tbody tr').nth(1).click();
    const samples = await page.locator('.custom-monitor video').evaluate(video => new Promise(resolve => {
      const samples = []; const start = performance.now();
      const frame = (_now, metadata) => { samples.push(metadata.mediaTime); if (performance.now() - start > 4500) resolve(samples); else video.requestVideoFrameCallback(frame); };
      video.requestVideoFrameCallback(frame);
    }));
    assert.ok(samples.length > 30); assert.ok(samples.some((time, index) => index && time < samples[index - 1] - 1));
    assert.ok(samples.every(time => time >= 3.95 && time < 6.15));
    await expect(page.locator('.custom-rally-table tr[data-loop-target="true"]')).toHaveCount(1);
    assert.equal((await saved()).clips[2].selected, false); await pause(); return { decodedFrames: samples.length };
  });
  await check('dragged playhead stays under pointer while decoded seek events arrive', async () => {
    await page.getByRole('button', { name: 'Loop playback', exact: true }).click();
    const ruler = await page.locator('.timeline-ruler').boundingBox();
    await page.mouse.click(ruler.x + ruler.width * .25, ruler.y + 12);
    const head = await page.locator('.timeline-playhead').boundingBox();
    await page.mouse.move(head.x + head.width / 2, head.y + 10); await page.mouse.down();
    for (const fraction of [.75, .3, .85, .05]) {
      await page.mouse.move(ruler.x + ruler.width * fraction, ruler.y + 12, { steps: 3 });
      const time = Number(await page.locator('.timeline-playhead').getAttribute('aria-valuenow'));
      await page.waitForTimeout(150);
      const later = Number(await page.locator('.timeline-playhead').getAttribute('aria-valuenow'));
      assert.ok(Math.abs(later - time) < .02); assert.ok(Math.abs(later - fraction * 12) < .1);
    }
    await page.mouse.up();
  });
  await check('page navigation and process restart restore the complete draft', async () => {
    const before = await saved(); await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('.mode-card').filter({ hasText: 'Custom' }).click(); assert.deepEqual(await saved(), before);
    await stop(); await launch(); await openEditor(); assert.deepEqual(await saved(), before);
    await page.screenshot({ path: path.join(run, 'restored-editor.png') });
  });
  let combined;
  await check('UI export burns the correct per-rally scoreboard through the Swift worker', async () => {
    await page.evaluate(() => { window.__events = []; window.ttcut.onTaskEvent(event => window.__events.push(event)); });
    await page.getByRole('button', { name: 'Start cutting', exact: true }).click();
    await page.waitForFunction(() => window.__events.some(event => ['export-result', 'error'].includes(event.type)), null, { timeout: 180000 });
    const result = await page.evaluate(() => window.__events.find(event => ['export-result', 'error'].includes(event.type)));
    assert.equal(result.type, 'export-result', JSON.stringify(result)); combined = result.data.outputPath;
    const metadata = await page.evaluate(file => window.ttcut.probeVideo(file), combined);
    assert.ok(Math.abs(metadata.duration_seconds - 4) < .15); assert.equal(metadata.audio_codec, 'aac');
    const board = (await saved()).scoreboard; const x = Math.round(board.x * 640), y = Math.round(board.y * 360);
    const width = Math.round(640 * .28 * board.scale), height = Math.round(width / 5.2);
    const frame = time => ff(['-ss', String(time), '-i', combined, '-frames:v', '1', '-vf', `crop=${width}:${height}:${x}:${y}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
    const first = frame(.5), second = frame(2.5); assert.equal(first.length, second.length); assert.ok(!first.equals(second));
    // Verify the blue games column, not merely output duration or file existence.
    const offset = (Math.floor(height * .1) * (width - width % 2) + Math.floor(width * .82)) * 3;
    assert.ok(first[offset + 2] > first[offset] + 40);
    ff(['-ss', '0.5', '-i', combined, '-frames:v', '1', path.join(run, 'export-first.png')]);
    ff(['-ss', '2.5', '-i', combined, '-frames:v', '1', path.join(run, 'export-second.png')]);
    return { file: combined, duration: metadata.duration_seconds, board };
  });
  await check('separate rally exports keep scoreboards and Premiere XML remains valid', async () => {
    // Reopen the draft in the actual renderer so it generates bundled-font PNGs again.
    await openEditor(); await page.getByRole('button', { name: 'Start cutting', exact: true }).hover();
    await page.locator('label.export-checkbox').filter({ hasText: 'Export rally videos' }).click();
    await expect(page.getByRole('checkbox', { name: 'Export rally videos', exact: true })).toBeChecked();
    await page.locator('label.export-checkbox').filter({ hasText: 'Export XML' }).click();
    await expect(page.getByRole('checkbox', { name: 'Export XML', exact: true })).toBeChecked();
    await page.evaluate(() => { window.__events = []; window.ttcut.onTaskEvent(event => window.__events.push(event)); });
    await page.getByRole('button', { name: 'Start cutting', exact: true }).click();
    await page.waitForFunction(() => window.__events.some(event => ['export-result', 'error'].includes(event.type)), null, { timeout: 180000 });
    const result = await page.evaluate(() => window.__events.find(event => ['export-result', 'error'].includes(event.type)));
    assert.equal(result.type, 'export-result', JSON.stringify(result)); assert.equal(result.data.rallyVideos.length, 2);
    assert.equal(result.data.partialSuccess, false); assert.ok(result.data.premiereXml);
    assert.match(await readFile(result.data.premiereXml.outputPath, 'utf8'), /<xmeml/);
    for (const item of result.data.rallyVideos) assert.ok((await stat(item.outputPath)).size > 1000);
  });
  await check('reset requires confirmation and writes fresh defaults', async () => {
    await openEditor(); await page.getByRole('button', { name: 'Reset edits', exact: true }).click();
    const before = await saved(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(await saved(), before);
    await page.getByRole('button', { name: 'Reset edits', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(async () => (await saved()).scoreboard.enabled).toBe(false);
    assert.equal((await saved()).playbackMode, 'source');
  });
  assert.deepEqual(report.errors, []); report.passed = true; delete report.failure;
} catch (error) {
  report.passed = false; report.failure = String(error.stack); console.error(error);
  await page?.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); process.exitCode = 1;
} finally {
  await stop().catch(error => { report.shutdownError = String(error); process.exitCode = 1; });
  await writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(run, 'electron.log'), stderr);
  await writeFile(path.join(output, 'latest-app-run.txt'), run + '\n'); console.log('Verification:', run);
}
