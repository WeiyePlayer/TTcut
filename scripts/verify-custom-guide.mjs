// Capture the real renderer for guide assets, or verify its modal in Electron.
// node scripts/verify-custom-guide.mjs --capture (updates the two guide PNGs)
// node scripts/verify-custom-guide.mjs (isolated profile, native macOS shortcuts)
import { mkdtemp, realpath, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const capture = process.argv.includes('--capture');
const output = path.join(root, 'output/custom-guide'); await mkdir(output, { recursive: true });
const run = await realpath(await mkdtemp(path.join(output, capture ? 'capture-' : 'verify-')));
await symlink(path.join(root, 'node_modules'), path.join(run, 'node_modules'));
const illustration = path.join(root, 'src/renderer/assets/pingpong-table-with-pose-mannequins.png');
const video = path.join(run, 'guide-illustration.mp4');
const ffmpeg = process.env.FFMPEG_PATH ?? path.join(root, '.runtime/macos/bin/ffmpeg');
execFileSync(ffmpeg, ['-v', 'error', '-loop', '1', '-i', illustration, '-t', '30', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:white', '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
await writeFile(path.join(run, 'index.html'), '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(path.join(run, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {CustomCutPage} from ${JSON.stringify(path.join(root, 'src/renderer/CustomCutPage.tsx'))};
import {useCustomClipHistory} from ${JSON.stringify(path.join(root, 'src/renderer/use-custom-clip-history.ts'))};
import {messages} from ${JSON.stringify(path.join(root, 'src/renderer/i18n.ts'))};
import {CUSTOM_GUIDE_STORAGE_KEY} from ${JSON.stringify(path.join(root, 'src/renderer/custom-guide-preference.ts'))};
import ${JSON.stringify(path.join(root, 'src/renderer/styles.css'))};
if(${capture})localStorage.setItem(CUSTOM_GUIDE_STORAGE_KEY,'1');
const initial=[[1,5],[6,8],[8,11],[13,17],[20,25]].map(([start,end],index)=>({clipId:'clip'+index,source:'detected',sourceRallyId:'rally_00'+(index===2?2:index+1),rallyIndex:index+1,bounceCount:index+3,start,end,defaultStart:start,defaultEnd:end,selected:index!==3,...(index===1||index===2?{isSplit:true}:{}),...(index===0?{score:{left:2,right:1},winner:'left'}:{})}));
function Harness(){const history=useCustomClipHistory(initial);const [language,setLanguage]=useState('zh-CN');const [mode,setMode]=useState('source');const [allowed,setAllowed]=useState(true);const [mounted,setMounted]=useState(true);const [scoreboard,setScoreboard]=useState({enabled:true,x:.05,y:.07,scale:1,style:'classic'});const [outputs,setOutputs]=useState({combined_video:true,rally_videos:false,premiere_xml:false});
window.guideFixture={setLanguage,setAllowed,setMounted,snapshot:()=>({clips:history.clips,mode,scoreboard,outputs})};
const analysis={schema_version:1,video:{path:${JSON.stringify(video)},duration_seconds:30,width:1280,height:720,fps:30,variable_frame_rate:false,video_codec:'h264',audio_codec:null,container:'mp4'},rallies:[],bounce_times_seconds:[1.5,2.5,3.5,6.5,7.5,8.5,9.5,10.5,20.5,21.5,22.5]};
return mounted&&<CustomCutPage video={window.fixture} analysis={analysis} clips={history.clips} scoreboard={scoreboard} onScoreboardChange={setScoreboard} playbackMode={mode} onPlaybackModeChange={setMode} translations={messages(language)} language={language} autoGuideAllowed={allowed} mediaAvailable onClipsChange={history.edit} onToggleAll={selected=>history.edit(current=>current.map(clip=>({...clip,selected})))} outputs={outputs} onOutputsChange={setOutputs} onExport={()=>{}} onReset={()=>history.load(initial)} canUndo={history.canUndo} canRedo={history.canRedo} onUndo={history.undo} onRedo={history.redo} onEditStart={history.begin} onEditEnd={history.commit}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
await build({ root: run, configFile: false, base: './', plugins: [react()], logLevel: 'error', build: { outDir: path.join(run, 'renderer') } });
await writeFile(path.join(run, 'media-protocol.cjs'), ts.transpileModule(await readFile(path.join(root, 'src/main/media-protocol.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText);
await writeFile(path.join(run, 'preload.cjs'), `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('fixture',JSON.parse(process.argv.find(a=>a.startsWith('--fixture=')).slice(10)));contextBridge.exposeInMainWorld('ttcut',{platform:process.platform});`);
await writeFile(path.join(run, 'main.cjs'), `
const {app,BrowserWindow,Menu,protocol}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'user-data'));app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ttcut-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.whenReady().then(async()=>{if(process.platform==='darwin')Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}]));const {installMediaProtocol,registerMediaPath}=require('./media-protocol.cjs');installMediaProtocol();const fixture={path:${JSON.stringify(video)},name:'Guide example.mp4',size:1,mediaUrl:registerMediaPath(${JSON.stringify(video)})};
const win=new BrowserWindow({width:1180,height:${capture ? 600 : 760},frame:false,show:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,additionalArguments:['--fixture='+JSON.stringify(fixture)]}});await win.loadFile(path.join(__dirname,'renderer/index.html'));});app.on('window-all-closed',()=>app.quit());
`);
const instance = await electron.launch({ args: [path.join(run, 'main.cjs')] });
const page = await instance.firstWindow(); page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const checks = []; let passed = false;
async function check(name, work) { await work(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
const guide = () => page.locator('.custom-editing-guide');
const monitor = page.locator('.custom-monitor video');
const snapshot = () => page.evaluate(() => window.guideFixture.snapshot());
try {
  await page.waitForFunction(() => Boolean(window.guideFixture));
  await page.evaluate(() => document.fonts.ready);
  if (capture) {
    await expect(guide()).toHaveCount(0);
    await expect.poll(() => monitor.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    await monitor.evaluate(video => { video.pause(); video.currentTime = 3; });
    await expect.poll(async () => Number(await page.locator('.timeline-playhead').getAttribute('aria-valuenow'))).toBe(3);
    for (const language of ['zh-CN', 'en']) {
      await page.evaluate(language => window.guideFixture.setLanguage(language), language);
      await expect(page.getByRole('button', { name: language === 'en' ? 'Custom editing guide' : '自定义操作指南', exact: true })).toBeVisible();
      await page.locator('.custom-workspace').screenshot({ path: path.join(root, 'src/renderer/assets', language === 'en' ? 'custom-guide-en.png' : 'custom-guide-zh.png'), scale: 'device', animations: 'disabled' });
    }
    const selectors = ['.custom-list-selection', '.custom-monitor', '.timeline-playhead', '.timeline-tool:nth-child(2)', '.timeline-tool:nth-child(4)', '.custom-scoreboard', '.playback-mode-toggle', '.timeline-tool:nth-child(8)', '.floating-launch-start'];
    const coordinates = await page.locator('.custom-workspace').evaluate((workspace, selectors) => {
      const outer = workspace.getBoundingClientRect();
      return selectors.map(selector => { const element = workspace.querySelector(selector); const box = element.getBoundingClientRect(); return { selector, x: (box.x + box.width / 2 - outer.x) / outer.width * 100, y: (box.y + box.height / 2 - outer.y) / outer.height * 100 }; });
    }, selectors);
    await writeFile(path.join(run, 'capture-coordinates.json'), JSON.stringify(coordinates, null, 2));
    console.log(JSON.stringify(coordinates));
    checks.push({ name: 'actual Electron workspace captures with shared guide illustration, scoreboard, five clips and both languages', passed: true });
  } else {
    await check('first visit opens and pauses; native modal blocks background shortcuts', async () => {
      await expect(guide()).toBeVisible(); await expect(page.getByRole('button', { name: '关闭操作指南' })).toBeFocused();
      await expect.poll(() => monitor.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
      const before = await snapshot(); const time = await monitor.evaluate(video => video.currentTime);
      for (const key of ['a', 'd', process.platform === 'darwin' ? 'Meta+z' : 'Control+z', 'ArrowRight']) await page.keyboard.press(key);
      assert.deepEqual(await snapshot(), before); assert.equal(await monitor.evaluate(video => video.currentTime), time); assert.equal(await monitor.evaluate(video => video.paused), true);
      await page.screenshot({ path: path.join(run, 'guide-zh-desktop.png') });
    });
    await check('focus cycles; Space activates modal button, dismissal persists and focus returns', async () => {
      await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: '知道了' })).toBeFocused();
      await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: '关闭操作指南' })).toBeFocused();
      await page.keyboard.press('Space'); await expect(guide()).toHaveCount(0);
      assert.equal(await page.evaluate(() => localStorage.getItem('ttcut.customEditingGuide.seen.v1')), '1');
      await expect(page.getByRole('button', { name: '自定义操作指南', exact: true })).toBeFocused();
      await page.reload(); await page.waitForFunction(() => Boolean(window.guideFixture)); await expect(guide()).toHaveCount(0);
    });
    await check('manual open pauses ongoing decoded playback without moving time or changing the draft', async () => {
      await expect.poll(() => monitor.evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
      await monitor.evaluate(video => { video.muted = true; video.currentTime = 3; video.play(); });
      await expect.poll(() => monitor.evaluate(video => video.currentTime)).toBeGreaterThan(3.15);
      await page.getByRole('button', { name: '剃刀工具' }).click();
      const before = await snapshot(); const time = await monitor.evaluate(video => video.currentTime);
      await page.getByRole('button', { name: '自定义操作指南', exact: true }).click();
      await expect(guide()).toBeVisible(); assert.equal(await monitor.evaluate(video => video.paused), true);
      assert.ok(Math.abs(await monitor.evaluate(video => video.currentTime) - time) < .25); assert.deepEqual(await snapshot(), before);
      await page.keyboard.press('Escape'); await expect(guide()).toHaveCount(0); assert.equal(await monitor.evaluate(video => video.paused), true);
      await expect(page.getByRole('button', { name: '剃刀工具' })).toHaveAttribute('aria-pressed', 'false');
    });
    await check('numbered marker scrolls and focuses its explanation; screenshots load locally', async () => {
      await page.getByRole('button', { name: '自定义操作指南', exact: true }).click();
      assert.equal(await guide().locator('img').evaluate(image => image.complete && image.naturalWidth > 0), true);
      await page.getByRole('button', { name: '6. 记分牌与比分红点' }).click();
      await expect(page.getByRole('heading', { name: '记分牌与比分红点', exact: true })).toBeFocused();
      assert.ok(await page.locator('.custom-guide-body').evaluate(element => element.scrollTop) > 0);
      await page.screenshot({ path: path.join(run, 'guide-zh-instructions.png') });
      await page.keyboard.press('Escape');
    });
    await check('minimum window keeps header/footer visible, one-column explanations and no horizontal overflow', async () => {
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(840, 520));
      await page.getByRole('button', { name: '自定义操作指南', exact: true }).click();
      const dimensions = await guide().evaluate(dialog => { const box = dialog.getBoundingClientRect(); const body = dialog.querySelector('.custom-guide-body'); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: body.scrollWidth > body.clientWidth, columns: getComputedStyle(dialog.querySelector('.custom-guide-sections')).gridTemplateColumns.split(' ').length }; });
      assert.ok(dimensions.left >= 24 && dimensions.top >= 24 && dimensions.right <= dimensions.viewportWidth - 24 && dimensions.bottom <= dimensions.viewportHeight - 24);
      assert.equal(dimensions.overflow, false); assert.equal(dimensions.columns, 1);
      await page.locator('.custom-guide-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByRole('button', { name: '知道了' })).toBeVisible();
      await page.screenshot({ path: path.join(run, 'guide-zh-minimum.png') });
      await page.mouse.click(6, 6); await expect(guide()).toHaveCount(0);
    });
    await check('English guide, screenshot and native platform shortcut table', async () => {
      await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 760));
      await page.evaluate(() => window.guideFixture.setLanguage('en'));
      await page.getByRole('button', { name: 'Custom editing guide', exact: true }).click();
      await expect(guide().locator('img')).toHaveAttribute('src', /custom-guide-en/);
      await guide().locator('img').evaluate(async image => { await image.decode(); await new Promise(requestAnimationFrame); });
      assert.equal(await guide().locator('img').evaluate(image => image.complete && image.naturalWidth === 2220), true);
      await expect(guide().getByText(process.platform === 'darwin' ? '⌘Z' : 'Ctrl+Z', { exact: true })).toBeVisible();
      await page.locator('.custom-guide-body').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: path.join(run, 'guide-en-desktop.png') });
      await page.getByRole('button', { name: 'Got it', exact: true }).click(); await expect(guide()).toHaveCount(0);
    });
    await check('a later application modal suspends the guide and resumes it without a dismissal', async () => {
      await page.getByRole('button', { name: 'Custom editing guide', exact: true }).click();
      await page.evaluate(() => window.guideFixture.setAllowed(false)); await expect(guide()).toHaveCount(0);
      await page.evaluate(() => window.guideFixture.setAllowed(true)); await expect(guide()).toBeVisible();
      await page.keyboard.press('Escape'); await expect(guide()).toHaveCount(0);
    });
  }
  assert.deepEqual(errors, []); passed = true;
} catch (error) {
  errors.push(String(error)); await page.screenshot({ path: path.join(run, 'failure.png') }).catch(() => {}); throw error;
} finally {
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ passed, capture, host: process.platform, runtime: 'real Electron, production renderer, isolated fixture and user profile', illustration, checks, errors }, null, 2));
  await instance.close(); console.log('Evidence: ' + run);
}
