// Real Dolby Vision acceptance (ticket 03): drive the development Electron build through the
// custom editor with an isolated profile, export a combined video and the same rallies with
// the scoreboard, and check every output against the real 杜比视界.mp4 source.
//
// Usage (macOS, from the repo root, after `.vite/` has been built and `.runtime/macos` staged):
//   node .scratch/dolby-vision-export/verify-electron.mjs
// Optional env:
//   TTCUT_DV_RECORD   history record to copy (default: the user's 5cbadae4-… record, read-only)
//   TTCUT_DV_RALLIES  comma-separated rally indexes to select (default 2,3,5,6)
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
const RECORD_ID = '5cbadae4-5106-4a94-87e5-654bce201e75';
const realHistory = path.join(os.homedir(), 'Library/Application Support/TTcut-Electron/history');
const recordSource = process.env.TTCUT_DV_RECORD ?? path.join(realHistory, 'records', `${RECORD_ID}.json`);
const rallyIndexes = (process.env.TTCUT_DV_RALLIES ?? '2,3,5,6').split(',').map(Number);
assert.ok(rallyIndexes.length >= 3 && rallyIndexes.length <= 4, 'select 3–4 rallies');

await mkdir(path.join(root, 'output/dolby-vision-export'), { recursive: true });
const run = await mkdtemp(path.join(root, 'output/dolby-vision-export/electron-'));
const frames = path.join(run, 'frames');
await mkdir(frames, { recursive: true });
const profile = path.join(run, 'profile');
const ffmpeg = path.join(root, '.runtime/macos/bin/ffmpeg');
const ffprobe = path.join(root, '.runtime/macos/bin/ffprobe');
const execute = (file, args, timeout = 600000) => execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
const raw = (args) => {
  const result = spawnSync(ffmpeg, ['-v', 'error', ...args, '-'], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
};
const hashFile = (file) => new Promise((resolve, reject) => {
  const digest = createHash('sha256');
  createReadStream(file).on('data', (chunk) => digest.update(chunk)).on('error', reject).on('end', () => resolve(digest.digest('hex')));
});
const report = { host: { platform: process.platform, arch: process.arch, release: os.release(), hostname: os.hostname() }, commit: execute('git', ['rev-parse', 'HEAD']).trim(), run, rallyIndexes, checks: [], errors: [], events: [], outputs: {} };
report.mediaWorker = { path: path.join(root, '.runtime/macos/bin/TTcutMediaWorker'), sha256: await hashFile(path.join(root, '.runtime/macos/bin/TTcutMediaWorker')) };
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed, ...detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  return passed;
};
const save = () => writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));

// --- Isolated profile: only this history record (plus its index entry and cover). ---
const record = JSON.parse(await readFile(recordSource, 'utf8'));
assert.equal(record.id, RECORD_ID);
const originalSource = { ...record.source };
let source = record.source.path;
// macOS App Data protection blocks reading the WeChat container from this host, so the
// acceptance can run against a user-made copy. Its folder is made read-only (0555) during
// the run to reproduce the unwritable source folder; the profile record is pointed at it.
const copiedSource = process.env.TTCUT_DV_SOURCE ? path.resolve(process.env.TTCUT_DV_SOURCE) : null;
if (copiedSource) {
  const copyStat = await stat(copiedSource);
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value === originalSource.path ? copiedSource : value;
  };
  Object.assign(record, rewrite(record));
  record.source = { ...record.source, path: copiedSource, name: path.basename(copiedSource), size: copyStat.size, modified_time_ms: copyStat.mtimeMs };
  source = copiedSource;
  report.sourceCopy = { originalPath: originalSource.path, originalRecordSize: originalSource.size, originalRecordMtimeMs: originalSource.modified_time_ms, copyPath: copiedSource, copySize: copyStat.size, copyMtimeMs: copyStat.mtimeMs };
}
const sourceDirectory = path.dirname(source);
const originalMode = copiedSource ? (await stat(sourceDirectory)).mode & 0o777 : null;
await mkdir(path.join(profile, 'history/records'), { recursive: true });
await mkdir(path.join(profile, 'history/covers'), { recursive: true });
await writeFile(path.join(profile, 'history/records', `${RECORD_ID}.json`), JSON.stringify(record));
await writeFile(path.join(profile, 'history/index.json'), JSON.stringify({ schema_version: 1, entries: [{ id: RECORD_ID, analyzed_at: record.analyzed_at }] }));
await copyFile(path.join(realHistory, 'covers', `${RECORD_ID}.jpg`), path.join(profile, 'history/covers', `${RECORD_ID}.jpg`)).catch(() => {});
let userSettings = {};
try { userSettings = JSON.parse(await readFile(path.join(realHistory, '../settings.json'), 'utf8')); } catch {}
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ ...userSettings, language: 'en' }));

// --- Source identity before export. ---
const sourceStat = await stat(source);
report.source = { path: source, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, recordSize: record.source.size, recordMtimeMs: record.source.modified_time_ms };
check('source size and mtime match the history record', sourceStat.size === record.source.size && sourceStat.mtimeMs === record.source.modified_time_ms, report.source);
if (copiedSource) check('copy has the original recorded size', sourceStat.size === originalSource.size, report.sourceCopy);
report.source.folderEntriesBeforeExport = copiedSource ? await readdir(sourceDirectory) : null;
report.source.sha256Before = await hashFile(source);
await save();

const draft = record.custom_editor_draft.clips;
const selected = rallyIndexes.map((index) => draft.find((clip) => clip.source === 'detected' && clip.rallyIndex === index));
assert.ok(selected.every(Boolean), 'selected rallies exist in the draft');
const targetSeconds = selected.reduce((total, clip) => total + (clip.end - clip.start), 0);
const video = record.analysis.video;
const quantum = Math.max(1 / Math.min(video.fps, video.nominal_fps), 1024 / video.audio_sample_rate, 1 / 90000, 1 / 48000);
const allowedDrift = Math.max(0.1, (2 * selected.length + 1) * quantum + 0.001);
report.selection = { clips: selected.map(({ rallyIndex, start, end }) => ({ rallyIndex, start, end })), targetSeconds, allowedDrift };
const segmentOffsets = []; let offset = 0;
for (const clip of selected) { segmentOffsets.push(offset); offset += clip.end - clip.start; }

const environment = { ...process.env, TTCUT_E2E: '1', TTCUT_E2E_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
const waitFor = async (condition, timeout = 1800000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await condition(); if (result) return result; await delay(200); }
  throw new Error('Acceptance condition timed out');
};

let instance, page;
try {
  if (copiedSource) {
    await chmod(sourceDirectory, 0o555);
    const writable = await access(sourceDirectory, fsConstants.W_OK).then(() => true, () => false);
    report.sourceCopy.folderModeDuringExport = '0555';
    report.sourceCopy.originalFolderMode = originalMode.toString(8);
    check('copied source folder is unwritable during the export', !writable, { folder: sourceDirectory });
  }
  instance = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: environment });
  page = await instance.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.ttcut));
  await page.evaluate(() => localStorage.setItem('ttcut.customEditingGuide.seen.v1', '1'));
  await page.exposeFunction('dvAcceptanceEvent', (event) => report.events.push(event));
  await page.evaluate(() => window.ttcut.onTaskEvent((event) => window.dvAcceptanceEvent(event)));
  const videosDirectory = await instance.evaluate(({ app }) => app.getPath('videos'));
  const fallbackDirectory = path.join(videosDirectory, 'TTcut');
  report.fallbackDirectory = fallbackDirectory;
  const bootstrap = await page.evaluate(() => window.ttcut.bootstrap());
  assert.equal(bootstrap.components.media.available, true, JSON.stringify(bootstrap.components));

  const openCustom = async () => {
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.locator('.history-open').filter({ hasText: path.basename(source) }).click();
    await page.getByRole('button', { name: /Custom/ }).click();
    await page.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect(page.locator('.custom-list-selection strong')).toHaveText(`0 / ${draft.length}`);
    for (const index of rallyIndexes) {
      const box = page.getByRole('checkbox', { name: `Rally ${index}`, exact: true });
      await box.scrollIntoViewIfNeeded();
      // The styled control span covers the input; click its label like a user would.
      if (!await box.isChecked()) await box.locator('..').click();
      await expect(box).toBeChecked();
    }
    await expect(page.locator('.custom-list-selection strong')).toHaveText(`${rallyIndexes.length} / ${draft.length}`);
  };

  for (const scoreboard of [false, true]) {
    const label = scoreboard ? 'scoreboard' : 'combined';
    await openCustom();
    const toggle = page.getByRole('button', { name: 'Scoreboard', exact: true });
    if ((await toggle.getAttribute('aria-pressed') === 'true') !== scoreboard) await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', String(scoreboard));
    const start = page.getByRole('button', { name: 'Start cutting', exact: true });
    await start.focus();
    for (const checkbox of await page.locator('.custom-export-options input[type=checkbox]').all()) {
      if (await checkbox.isChecked()) await checkbox.locator('..').click();
    }
    await page.screenshot({ path: path.join(run, `${label}-editor.png`) });
    const previous = report.events.length;
    const began = Date.now();
    await start.click();
    const event = await waitFor(() => report.events.slice(previous).find((value) => ['error', 'export-result'].includes(value.type)));
    report.outputs[label] = { event, elapsedSeconds: (Date.now() - began) / 1000 };
    await save();
    assert.equal(event.type, 'export-result', JSON.stringify(event));
    const output = event.data.outputPath;
    await expect(page.getByRole('heading', { name: 'Export complete', exact: true })).toBeVisible();
    const shown = await page.locator('.output-details').innerText();
    await page.screenshot({ path: path.join(run, `${label}-result.png`) });
    check(`${label}: output lands in ${fallbackDirectory} and result page shows it`, path.dirname(output) === fallbackDirectory && shown.includes(output), { output, shown });
    report.outputs[label].output = output;
    // Real result-page playback: seek just before each segment join and play across it.
    const preview = page.locator('video.output-preview');
    await expect(preview).toBeVisible();
    await waitFor(() => preview.evaluate((element) => element.readyState >= 2 && element.videoWidth > 0), 60000);
    const joins = [];
    for (const [index, join] of segmentOffsets.slice(1).entries()) {
      const result = await preview.evaluate(async (element, at) => {
        element.pause();
        const seeked = new Promise((resolve) => element.addEventListener('seeked', resolve, { once: true }));
        element.currentTime = at;
        await seeked;
        const before = element.getVideoPlaybackQuality().totalVideoFrames;
        await element.play();
        const began = performance.now();
        while (element.currentTime < at + 1 && performance.now() - began < 5000) await new Promise((resolve) => setTimeout(resolve, 50));
        element.pause();
        const quality = element.getVideoPlaybackQuality();
        return { seekedTo: at, reached: element.currentTime, framesDecoded: quality.totalVideoFrames - before, droppedTotal: quality.droppedVideoFrames, error: element.error?.code ?? null };
      }, join - 0.5);
      joins.push({ join, ...result });
      await page.screenshot({ path: path.join(run, `${label}-result-join${index + 1}.png`) });
    }
    report.outputs[label].playbackAcrossJoins = joins;
    check(`${label}: result page plays and seeks across every segment join`, joins.every((value) => value.error === null && value.reached >= value.join + 0.4 && value.framesDecoded >= 10), { joins });
    await page.getByRole('button', { name: 'Cut another video', exact: true }).click();
  }
  const logs = path.join(profile, 'logs');
  const logText = (await Promise.all((await readdir(logs).catch(() => [])).map((name) => readFile(path.join(logs, name), 'utf8').catch(() => '')))).join('\n');
  const fallbackLines = logText.split('\n').filter((line) => line.includes('Export output directory fallback'));
  check('task log records the source → Movies/TTcut fallback', fallbackLines.length >= 2, { fallbackLines });
  check('no renderer page errors', report.errors.length === 0, { errors: report.errors });
} catch (error) {
  report.failure = String(error.stack);
  if (page) await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {});
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => {});
  if (instance) await instance.close().catch(() => {});
  if (copiedSource) {
    await chmod(sourceDirectory, originalMode);
    report.sourceCopy.folderEntriesAfterExport = await readdir(sourceDirectory);
  }
  await save();
}

// --- Media checks on each output (outside Electron). ---
const meanAbsDiff = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]); return sum / a.length; };
const mean = (buffer) => buffer.reduce((total, value) => total + value, 0) / buffer.length;
const sourceFrame = (time, filter, size) => raw(['-ss', String(time), '-i', source, '-frames:v', '1', '-vf', `${filter},scale=${size}:flags=area,format=rgb24`, '-f', 'rawvideo']);
// HLG base layer → BT.709 SDR reference (independent chain: BT.2408 reference white at 1.0,
// no highlight desaturation), and a "label only" decode (HLG pixels shown unconverted) for contrast.
const referenceFilter = 'zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
const labelOnlyFilter = 'null';
const colourStats = (buffer) => {
  let count = 0, luma = 0, saturation = 0, clipped = 0;
  for (let i = 0; i < buffer.length; i += 3) {
    const [r, g, b] = [buffer[i], buffer[i + 1], buffer[i + 2]];
    const high = Math.max(r, g, b), low = Math.min(r, g, b);
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b; saturation += high ? (high - low) / high : 0; if (high >= 250) clipped += 1; count += 1;
  }
  return { luma: luma / count, saturation: saturation / count, clippedPercent: 100 * clipped / count };
};
const samplePcm = (file, at, seconds) => {
  const buffer = raw(['-ss', String(at), '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le']);
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
};
const lagSeconds = (reference, candidate, maxLag) => {
  let best = { lag: 0, score: -Infinity };
  const norm = (values) => Math.sqrt(values.reduce((total, value) => total + value * value, 0)) || 1;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = maxLag; i < reference.length - maxLag; i += 1) sum += reference[i] * (candidate[i + lag] ?? 0);
    if (sum > best.score) best = { lag, score: sum };
  }
  return { seconds: best.lag / 8000, correlation: best.score / (norm(reference) * norm(candidate)) };
};
const results = {};
for (const label of ['combined', 'scoreboard']) {
  const output = report.outputs[label]?.output;
  if (!output) { check(`${label}: output exists`, false); continue; }
  const result = results[label] = {};
  const streams = JSON.parse(execute(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
  const v = streams.streams.find((s) => s.codec_type === 'video');
  const a = streams.streams.find((s) => s.codec_type === 'audio');
  result.video = { codec: v.codec_name, pix_fmt: v.pix_fmt, color_primaries: v.color_primaries, color_transfer: v.color_transfer, color_space: v.color_space, color_range: v.color_range, width: v.width, height: v.height, duration: Number(v.duration), side_data: v.side_data_list ?? [] };
  check(`${label}: h264 / yuv420p / bt709 / limited range`, v.codec_name === 'h264' && v.pix_fmt === 'yuv420p'
    && v.color_primaries === 'bt709' && v.color_transfer === 'bt709' && v.color_space === 'bt709' && v.color_range === 'tv'
    && !(v.side_data_list ?? []).length, result.video);
  const frameScan = JSON.parse(execute(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=side_data_list,color_transfer,color_primaries,color_space,color_range', '-of', 'json', output]));
  const hdrSideData = frameScan.frames.flatMap((frame, index) => (frame.side_data_list ?? []).filter((d) => /dovi|dolby|mastering|light level|hdr|dynamic/i.test(d.side_data_type)).map((d) => ({ index, type: d.side_data_type })));
  const nonBt709 = frameScan.frames.filter((frame) => frame.color_transfer && frame.color_transfer !== 'bt709').length;
  result.frames = { count: frameScan.frames.length, hdrSideData: hdrSideData.slice(0, 10), hdrSideDataCount: hdrSideData.length, nonBt709Frames: nonBt709, sideDataTypes: [...new Set(frameScan.frames.flatMap((f) => (f.side_data_list ?? []).map((d) => d.side_data_type)))] };
  check(`${label}: no DOVI/HDR side data on any of ${frameScan.frames.length} frames`, hdrSideData.length === 0 && nonBt709 === 0, result.frames);
  // Decode with the file's own timestamps; the default null muxer rounds to 1/fps and warns about
  // the short final frame at each exact clip end, which is recorded separately as an observation.
  const decode = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const roundedDecode = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const ptsList = execute(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts', '-of', 'csv=p=0', output]).trim().split('\n').map((line) => Number.parseInt(line, 10));
  const gaps = ptsList.slice(1).map((pts, index) => ({ index: index + 1, gapTicks: pts - ptsList[index] })).filter((value) => value.gapTicks < 1000);
  result.decode = { status: decode.status, stderr: decode.stderr.slice(0, 4000), roundedNullMuxer: { status: roundedDecode.status, stderr: roundedDecode.stderr.slice(0, 4000) }, shortFrameGaps90k: gaps };
  check(`${label}: full decode without errors`, decode.status === 0 && decode.stderr.trim() === '' && roundedDecode.status === 0, result.decode);
  const formatDuration = Number(streams.format.duration);
  result.duration = { format: formatDuration, video: Number(v.duration), audio: a ? Number(a.duration) : null, target: targetSeconds, allowed: allowedDrift, drift: formatDuration - targetSeconds };
  check(`${label}: duration matches selected rallies (±${allowedDrift.toFixed(3)} s)`, Math.abs(formatDuration - targetSeconds) <= allowedDrift && Math.abs(Number(v.duration) - targetSeconds) <= allowedDrift, result.duration);
  result.audio = a ? { codec: a.codec_name, channels: a.channels, sample_rate: a.sample_rate, start: Number(a.start_time), duration: Number(a.duration) } : null;
  const sync = selected.map((clip, index) => {
    const into = Math.min(2, (clip.end - clip.start) / 4);
    const window = Math.min(3, (clip.end - clip.start) - into - 0.5);
    const reference = samplePcm(source, clip.start + into, window);
    const candidate = samplePcm(output, segmentOffsets[index] + into, window);
    return { rallyIndex: clip.rallyIndex, ...lagSeconds(reference, candidate, 800) };
  });
  result.audioSync = sync;
  check(`${label}: audio present and in sync with source (|lag| ≤ 45 ms per rally)`, Boolean(a) && Math.abs(Number(a.duration) - Number(v.duration)) <= allowedDrift
    && sync.every((s) => Math.abs(s.seconds) <= 0.045 && s.correlation > 0.5), { audio: result.audio, sync });
  result.frames.samples = [];
  for (const [index, clip] of selected.entries()) {
    const mid = (clip.end - clip.start) / 2;
    const outTime = segmentOffsets[index] + mid;
    const png = path.join(frames, `${label}-rally${clip.rallyIndex}-mid.png`);
    execute(ffmpeg, ['-v', 'error', '-y', '-ss', String(outTime), '-i', output, '-frames:v', '1', png]);
    const outRgb = raw(['-ss', String(outTime), '-i', output, '-frames:v', '1', '-vf', 'scale=192x108:flags=area,format=rgb24', '-f', 'rawvideo']);
    const refRgb = sourceFrame(clip.start + mid, referenceFilter, '192x108');
    const labelRgb = sourceFrame(clip.start + mid, labelOnlyFilter, '192x108');
    const compare = path.join(frames, `${label}-rally${clip.rallyIndex}-compare.png`);
    // output | independent HLG→709 reference | source pixels shown with no conversion
    execute(ffmpeg, ['-v', 'error', '-y', '-ss', String(outTime), '-i', output, '-ss', String(clip.start + mid), '-i', source, '-ss', String(clip.start + mid), '-i', source,
      '-filter_complex', `[0:v]scale=640:360,format=rgb24[o];[1:v]${referenceFilter},scale=640:360,format=rgb24[r];[2:v]scale=640:360,format=rgb24[l];[o][r][l]hstack=inputs=3`, '-frames:v', '1', compare]);
    const sample = { rallyIndex: clip.rallyIndex, outputTime: outTime, sourceTime: clip.start + mid, png, compare, meanRgb: mean(outRgb),
      output: colourStats(outRgb), reference: colourStats(refRgb), labelOnly: colourStats(labelRgb),
      diffToReference: meanAbsDiff(outRgb, refRgb), diffToLabelOnly: meanAbsDiff(outRgb, labelRgb) };
    if (label === 'scoreboard') {
      const crop = 'crop=iw*0.2:ih*0.12:iw*0.78:ih*0.04,scale=96x32:flags=area,format=rgb24';
      const withBoard = raw(['-ss', String(outTime), '-i', output, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo']);
      const withoutBoard = raw(['-ss', String(outTime), '-i', report.outputs.combined.output, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo']);
      sample.scoreboardRegionDiff = meanAbsDiff(withBoard, withoutBoard);
    }
    result.frames.samples.push(sample);
  }
  // Not grey: at least as saturated as the unconverted HLG pixels. Not blown out: ≤ 2 % clipped.
  // Screenshots are also inspected by eye (see validation.md).
  check(`${label}: mid-rally frames are non-black, not greyed and not blown out`,
    result.frames.samples.every((s) => s.meanRgb > 30 && s.output.saturation >= s.labelOnly.saturation && s.output.clippedPercent <= 2), { samples: result.frames.samples });
  if (label === 'scoreboard') check('scoreboard: overlay present on converted frames (scoreboard region differs from the combined export)',
    result.frames.samples.every((s) => s.scoreboardRegionDiff > 15), { diffs: result.frames.samples.map((s) => s.scoreboardRegionDiff) });
}
report.media = results;
report.source.sha256After = await hashFile(source);
const after = await stat(source);
check('source SHA-256, size and mtime unchanged', report.source.sha256After === report.source.sha256Before && after.size === sourceStat.size && after.mtimeMs === sourceStat.mtimeMs,
  { before: report.source.sha256Before, after: report.source.sha256After });
await save();
const failed = report.checks.filter((c) => !c.passed);
console.log(`Evidence: ${run}`);
if (report.failure || failed.length) { console.error(report.failure ?? '', failed.map((c) => c.name)); process.exitCode = 1; }
