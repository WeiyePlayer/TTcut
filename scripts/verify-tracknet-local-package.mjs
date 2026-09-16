import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const app = path.resolve(process.argv[2] ?? path.join(root, 'out/TTcut-darwin-arm64/TTcut.app'));
const source = path.resolve(process.argv[3] ?? '/Users/weiye/Documents/1-193.mp4');
const resources = path.join(app, 'Contents', 'Resources');
const runtime = path.join(resources, 'tracknet-local');
const worker = path.join(resources, 'worker');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ttcut-tracknet-package-'));
const clip = path.join(temporary, 'tracknet-real-video.mp4');
const userData = path.join(temporary, 'user-data');
const reportPath = path.join(root, 'out', 'tracknet-local-verification.json');
const ffmpeg = path.join(resources, 'runtime', 'bin', 'ffmpeg');
const python = path.join(runtime, 'bin', 'python');
const executable = path.join(app, 'Contents', 'MacOS', 'TTcut');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

assert.ok((await stat(path.join(runtime, 'TrackNet_best.pt'))).size > 100_000_000);
assert.ok((await stat(path.join(worker, 'ttcut_worker', 'tracknet_motion.py'))).isFile());
const runtimeResult = JSON.parse(run(python, ['-c', [
  'import json,torch,cv2,av,numpy',
  'from ttcut_worker.tracknet_model import load_tracknet',
  `m=load_tracknet(${JSON.stringify(path.join(runtime, 'TrackNet_best.pt'))},'auto')`,
  "print(json.dumps({'device':str(m.device),'torch':torch.__version__,'opencv':cv2.__version__,'av':av.__version__,'numpy':numpy.__version__}))",
].join('\n')], { env: { ...process.env, PYTHONPATH: worker, PYTHONDONTWRITEBYTECODE: '1' } }));
assert.equal(runtimeResult.device, 'mps');
run(ffmpeg, ['-v', 'error', '-ss', '50', '-i', source, '-t', '8',
  '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', clip]);

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
  env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (value) => { output += value; });
child.stderr.on('data', (value) => { output += value; });
let browser;
try {
  const deadline = Date.now() + 45_000;
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert.ok(browser, `Packaged renderer did not start: ${output}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => Boolean(window.ttcut), null, { timeout: 30_000 });
  await page.evaluate(() => { window.__tracknetEvents = []; window.ttcut.onTaskEvent((event) => window.__tracknetEvents.push(event)); });
  const video = await page.evaluate((file) => window.ttcut.probeVideo(file), clip);
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  const input = {
    videoPath: clip,
    calibrationChoice: { method: 'manual', calibration: {
      video_width: 1280, video_height: 720,
      points: { top_left: [695.5, 303.25], top_right: [935.5, 316.10714285714283],
        bottom_right: [829.9, 412.5357142857143], bottom_left: [465.1, 380.39285714285717] },
    } },
    device: 'auto', historyVisibility: 'visible', normalizeVariableFrameRate: false,
  };
  const taskId = await page.evaluate((value) => window.ttcut.startAnalysis(value), input);
  await page.waitForFunction((id) => window.__tracknetEvents.some((event) => event.taskId === id
    && (event.type === 'analysis-result' || event.type === 'error')), taskId, { timeout: 240_000 });
  const event = await page.evaluate((id) => window.__tracknetEvents.find((value) => value.taskId === id
    && (value.type === 'analysis-result' || value.type === 'error')), taskId);
  assert.equal(event.type, 'analysis-result', JSON.stringify(event));
  assert.equal(event.data.model_provenance.profile, 'tracknet_v1');
  assert.equal(event.data.rally_recognition.detection_confidence_threshold, 0.36);
  assert.equal(event.data.rally_recognition.tracknet_filter.motion_policy_version, 2);
  const report = { app, source, clip_seconds: 8, runtime: runtimeResult,
    result: { profile: event.data.model_provenance.profile, confidence_threshold: 0.36,
      motion_policy_version: 2, rally_count: event.data.rallies.length } };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (child.exitCode === null) child.kill('SIGTERM');
  await writeFile(path.join(temporary, 'electron.log'), output);
}
