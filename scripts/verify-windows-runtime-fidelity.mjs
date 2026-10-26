// Validate the packaged Windows IPC, workers and result preview in an isolated profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const [executable, mediaDirectory, match, templateFile] = process.argv.slice(2).map((value) => path.resolve(value));
if (!executable || !templateFile) throw new Error('Usage: node scripts/verify-windows-runtime-fidelity.mjs <TTcut.exe> <fidelity-fixtures> <match-video> <history-record>');
const run = await mkdtemp(path.resolve('output/playwright/windows-runtime-fidelity-'));
const profile = path.join(run, 'profile');
const tools = path.join(path.dirname(executable), 'resources/windows');
const ffmpeg = path.join(tools, 'ffmpeg/ffmpeg.exe');
const ffprobe = path.join(tools, 'ffmpeg/ffprobe.exe');
const execute = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const waitFor = async (condition, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await condition(); if (value) return value; await delay(100); }
  throw new Error(`Timed out after ${timeout} ms`);
};
await mkdir(path.join(profile, 'history/records'), { recursive: true });
const pollution = path.join(run, 'external-python');
await mkdir(pollution);
for (const name of ['numpy', 'cv2', 'onnxruntime']) await writeFile(path.join(pollution, `${name}.py`), 'raise RuntimeError("External dependency was imported")\n');
const source = path.join(run, 'HLG 乒乓.mp4');
await copyFile(path.join(mediaDirectory, 'hlg.mp4'), source);
const dynamic = path.join(run, 'HDR10plus.mp4');
await copyFile(path.join(mediaDirectory, 'hdr10plus.mp4'), dynamic);
const realVideo = path.join(run, '真实比赛.mp4');
execute(ffmpeg, ['-v', 'error', '-y', '-ss', '8', '-i', match, '-t', '4', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', realVideo]);
const id = randomUUID();
const dynamicId = randomUUID();
const legacyId = randomUUID();
const template = JSON.parse(await readFile(templateFile, 'utf8'));
const info = await stat(source);
const record = {
  ...template, id, analyzed_at: new Date().toISOString(),
  source: { path: source, name: path.basename(source), size: info.size, modified_time_ms: info.mtimeMs },
  analysis: { schema_version: 1, video: { path: source, duration_seconds: 2, width: 320, height: 180, fps: 24, variable_frame_rate: false, video_codec: 'hevc', audio_codec: 'aac', container: 'mp4' }, rallies: [{ id: 'rally_001', index: 1, bounce_count: 4, start_time_seconds: 0.25, end_time_seconds: 1.75 }] },
  calibration: { video_width: 320, video_height: 180, points: { top_left: [80, 40], top_right: [240, 40], bottom_right: [280, 150], bottom_left: [40, 150] } },
};
delete record.custom_editor_draft;
delete record.last_export;
await writeFile(path.join(profile, 'history/records', `${id}.json`), JSON.stringify(record));
const dynamicInfo = await stat(dynamic);
const dynamicRecord = { ...record, id: dynamicId,
  source: { path: dynamic, name: path.basename(dynamic), size: dynamicInfo.size, modified_time_ms: dynamicInfo.mtimeMs },
  analysis: { ...record.analysis, video: { ...record.analysis.video, path: dynamic, audio_codec: null } },
};
await writeFile(path.join(profile, 'history/records', `${dynamicId}.json`), JSON.stringify(dynamicRecord));
const missingCache = path.join(run, 'deleted-legacy-cfr.mp4');
const legacyRecord = { ...record, id: legacyId, analysis: {
  ...record.analysis,
  video: { ...record.analysis.video, path: missingCache, video_codec: 'h264', pixel_format: 'yuv420p' },
  source_video: { ...record.analysis.video },
  processing: { mode: 'normalized_cfr', target_fps_ratio: '24/1', encoder: 'libx264', warning_code: null },
} };
await writeFile(path.join(profile, 'history/records', `${legacyId}.json`), JSON.stringify(legacyRecord));
await writeFile(path.join(profile, 'history/index.json'), JSON.stringify({ schema_version: 1, entries: [id, dynamicId, legacyId].map((id) => ({ id, analyzed_at: record.analyzed_at })) }));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ language: 'en', calibration_method: 'automatic', pre_roll_seconds: 1.5, post_roll_seconds: 0.5, normalize_variable_frame_rate: false }));
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const environment = { ...process.env, PYTHONPATH: pollution, PYTHONHOME: path.join(run, 'missing-python'), PYTHONUSERBASE: pollution };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
child.stdout.resume();
let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); });
let browser, page;
const report = { executable, run, checks: [], events: [] };
let passed = false;
try {
  await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30_000);
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.exposeFunction('fidelityEvent', (event) => report.events.push(event));
  await page.evaluate(() => window.ttcut.onTaskEvent((event) => window.fidelityEvent(event)));
  const bootstrap = await page.evaluate(() => window.ttcut.bootstrap());
  assert.equal(bootstrap.components.analysis.available, true, JSON.stringify(bootstrap.components));
  assert.equal(bootstrap.components.media.available, true);
  report.checks.push({ name: 'packaged components survive external Python pollution', components: bootstrap.components });
  const task = async (method, input, terminal) => {
    const taskId = await page.evaluate(({ method, input }) => window.ttcut[method](input), { method, input });
    const event = await waitFor(() => report.events.find((event) => event.taskId === taskId && (event.type === terminal || event.type === 'error')), 180_000);
    assert.equal(event.type, terminal, JSON.stringify(event));
    return event;
  };
  const calibration = await task('startAutoCalibration', { videoPath: realVideo, device: 'auto' }, 'calibration-result');
  report.checks.push({ name: 'real Windows calibration worker under polluted environment', calibration: calibration.calibration });
  const analysis = await task('startAnalysis', { videoPath: realVideo, device: 'auto', calibrationChoice: { method: 'precalibrated', calibration: calibration.calibration }, historyVisibility: 'visible', normalizeVariableFrameRate: false }, 'analysis-result');
  assert.equal(analysis.data.model_provenance.profile, 'blurball_v1');
  assert.equal(analysis.data.rally_recognition.method, 'hybrid_motion_bounce');
  report.checks.push({ name: 'real Windows BlurBall analysis worker under polluted environment', video: analysis.data.video, provenance: analysis.data.model_provenance });
  const originalHash = await hash(source);
  const probe = await page.evaluate((file) => window.ttcut.probeVideo(file), source);
  assert.equal(probe.media_fidelity.hdr, 'hlg');
  const dynamicProbe = await page.evaluate((file) => window.ttcut.probeVideo(file), dynamic);
  assert.equal(dynamicProbe.media_fidelity.hdr, 'hdr10Plus');
  report.checks.push({ name: 'packaged Windows detects HLG and frame-carried HDR10+', hlg: probe.media_fidelity, dynamic: dynamicProbe.media_fidelity });
  const dynamicHash = await hash(dynamic);
  const converted = await task('startExport', { analysis_id: dynamicId, destination: 'source', selection: { mode: 'all', pre_roll_seconds: 1.5, post_roll_seconds: 0.5 } }, 'export-result');
  const convertedVideo = await page.evaluate((file) => window.ttcut.probeVideo(file), converted.data.outputPath);
  assert.equal(convertedVideo.video_codec, 'h264'); assert.equal(convertedVideo.pixel_format, 'yuv420p');
  assert.equal(convertedVideo.color_transfer, 'bt709'); assert.equal(convertedVideo.color_primaries, 'bt709');
  assert.equal(convertedVideo.color_space, 'bt709'); assert.equal(convertedVideo.color_range, 'tv');
  assert.equal(converted.data.outputMediaFidelity.hdr, 'sdr');
  const convertedFrames = JSON.parse(execute(ffprobe, ['-v', 'error', '-show_frames', '-of', 'json', converted.data.outputPath])).frames;
  assert.equal(convertedFrames.some((frame) => frame.side_data_list?.some((side) => /DOVI|Dolby Vision|HDR|Mastering display|Content light/i.test(side.side_data_type))), false);
  execute(ffmpeg, ['-v', 'error', '-xerror', '-i', converted.data.outputPath, '-f', 'null', '-']);
  assert.equal(await hash(dynamic), dynamicHash);
  report.checks.push({ name: 'packaged Main IPC automatically tone maps legacy HDR10+ to SDR H.264', event: converted, video: convertedVideo, sourceHash: dynamicHash });
  assert.equal(await stat(missingCache).catch(() => null), null);
  const openedLegacy = await page.evaluate((id) => window.ttcut.openHistory(id), legacyId);
  assert.equal(openedLegacy.video.path, source);
  assert.equal(openedLegacy.analysis.video.path, missingCache);
  const recovered = await task('startExport', { analysis_id: legacyId, destination: 'source', selection: { mode: 'all', pre_roll_seconds: 1.5, post_roll_seconds: 0.5 } }, 'export-result');
  const recoveredStream = JSON.parse(execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', recovered.data.outputPath])).streams.find((stream) => stream.codec_type === 'video');
  assert.equal(recoveredStream.codec_name, 'hevc'); assert.equal(recoveredStream.codec_tag_string, 'hvc1');
  assert.equal(recoveredStream.pix_fmt, 'yuv420p10le'); assert.equal(recoveredStream.color_transfer, 'arib-std-b67');
  execute(ffmpeg, ['-v', 'error', '-xerror', '-i', recovered.data.outputPath, '-f', 'null', '-']);
  assert.equal(await stat(missingCache).catch(() => null), null);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'history/records', `${legacyId}.json`), 'utf8')).analysis.video.path, missingCache);
  assert.equal(await hash(source), originalHash);
  report.checks.push({ name: 'packaged Main IPC recovers the original HDR video with a missing legacy CFR cache', event: recovered, stream: recoveredStream, missingCache });
  await page.reload();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const entry = page.locator('.history-open').filter({ hasText: path.basename(source) });
  await entry.click();
  await page.getByRole('button', { name: /All rallies/ }).click();
  await page.getByRole('button', { name: 'Start cutting', exact: true }).click();
  // Reload recreates the preload event listener; use the actual completed UI here.
  const preview = page.locator('video.output-preview');
  await preview.waitFor({ state: 'visible', timeout: 120_000 });
  await waitFor(() => preview.evaluate((video) => video.controls && video.readyState >= 2 && video.videoWidth > 0), 120_000);
  const outputPath = await page.locator('.output-details strong').last().innerText();
  const outputHash = await hash(outputPath);
  const stream = JSON.parse(execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', outputPath])).streams.find((stream) => stream.codec_type === 'video');
  assert.equal(stream.codec_name, 'hevc'); assert.equal(stream.codec_tag_string, 'hvc1'); assert.equal(stream.pix_fmt, 'yuv420p10le'); assert.equal(stream.color_transfer, 'arib-std-b67');
  execute(ffmpeg, ['-v', 'error', '-xerror', '-i', outputPath, '-f', 'null', '-']);
  const playback = await preview.evaluate(async (video) => { video.currentTime = 0; await video.play(); return { frames: video.getVideoPlaybackQuality().totalVideoFrames, source: video.currentSrc }; });
  await waitFor(() => preview.evaluate((video) => video.currentTime > 0.3 && video.getVideoPlaybackQuality().totalVideoFrames > 2));
  const sought = await preview.evaluate((video) => { video.pause(); video.currentTime = video.duration * 0.75; return video.currentTime; });
  await waitFor(() => preview.evaluate((video) => !video.seeking && video.readyState >= 2));
  await page.screenshot({ path: path.join(run, 'hlg-export-preview.png') });
  assert.equal(await hash(source), originalHash); assert.equal(await hash(outputPath), outputHash);
  assert.deepEqual(pageErrors, []);
  report.checks.push({ name: 'actual Windows HDR export, full decode, result proxy playback and seeking preserve originals', outputPath, stream, playback, sought, sourceHash: originalHash, outputHash });
  passed = true;
} catch (error) {
  report.error = String(error); console.error(error);
  if (page) { report.body = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => undefined); }
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.ttcut.confirmClose('exit')).catch(() => undefined);
  await browser?.close().catch(() => undefined);
  report.shutdown = await Promise.race([exited, delay(30_000, null, { ref: false })]);
  if (!report.shutdown) { child.kill(); passed = false; }
  report.stderr = stderr;
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ passed, ...report }, null, 2));
  console.log(JSON.stringify({ passed, checks: report.checks.map((check) => check.name), error: report.error, evidence: run }));
  if (!passed) process.exitCode = 1;
}
