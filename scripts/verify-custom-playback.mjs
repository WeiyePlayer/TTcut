// Real Electron/decoded-frame regression using the actual custom page and media protocol.
// Usage: node scripts/verify-custom-playback.mjs [source] [--baseline | --zoom-only | --original-media] [--preview-only]
// --original-media uses the full untouched source and the production preview service.
// --reuse-preview=<file> can reuse a previously validated full preview for UI retries.
import { mkdtemp, realpath, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
import { _electron as electron, expect } from '@playwright/test';
const root = path.resolve(import.meta.dirname, '..');
const baseline = process.argv.includes('--baseline');
const zoomOnly = process.argv.includes('--zoom-only');
const originalMedia = process.argv.includes('--original-media');
const previewOnly = process.argv.includes('--preview-only');
const reusePreview = process.argv.find(arg => arg.startsWith('--reuse-preview='))?.slice('--reuse-preview='.length);
if (reusePreview && !originalMedia) throw new Error('--reuse-preview requires --original-media');
const source = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? path.join(root, 'artifacts/dynamic-roi/full_frame_trajectory.mp4'));
const run = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ttcut-playback-')));
await symlink(path.join(root, 'node_modules'), path.join(run, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const media = originalMedia ? source : path.join(run, '真实素材 预览.mp4');
if (!originalMedia) execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-i', source, '-t', '30', '-an', '-vf', 'scale=640:-2', '-c:v', 'libx264', '-preset', 'ultrafast', media]);
if (originalMedia) {
 // Only component discovery is substituted: probe, FFmpeg execution, duration
 // validation, cache publication and media registration use production code.
 await writeFile(path.join(run, 'backend.ts'), `export * from ${JSON.stringify(path.join(root, 'src/main/preview-media.ts'))};export * from ${JSON.stringify(path.join(root, 'src/main/probe.ts'))};export * from ${JSON.stringify(path.join(root, 'src/main/media-protocol.ts'))};`);
 await build({ root: run, configFile: false, logLevel: 'error', plugins: [{ name: 'test-media-components', enforce: 'pre', load(id) {
  if (id.replaceAll('\\', '/').endsWith('/src/main/components.ts')) return `export async function resolveUsableMediaComponents(){return {ffmpeg:process.env.FFMPEG_PATH||'ffmpeg',ffprobe:process.env.FFPROBE_PATH||'ffprobe',mediaEncoder:'libx264'}}`;
  if (id.replaceAll('\\', '/').endsWith('/src/main/macos/client.ts')) return `export function probeMacVideo(){throw new Error('Windows verification only')}`;
 } }], build: { outDir: path.join(run, 'backend'), lib: { entry: path.join(run, 'backend.ts'), formats: ['cjs'], fileName: () => 'index.cjs' }, rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)] } } });
}
const original = baseline ? new Map(['src/renderer/CustomCutPage.tsx', 'src/renderer/use-compatible-preview.ts'].map(file => [path.join(root, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' })])) : new Map();
await writeFile(path.join(run, 'index.html'), '<html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(path.join(run, 'entry.tsx'), `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {CustomCutPage} from ${JSON.stringify(path.join(root, 'src/renderer/CustomCutPage.tsx'))};
import {CompatibleVideo} from ${JSON.stringify(path.join(root, 'src/renderer/CompatibleVideo.tsx'))};
import {messages} from ${JSON.stringify(path.join(root, 'src/renderer/i18n.ts'))};
import ${JSON.stringify(path.join(root, 'src/renderer/styles.css'))};
const video = window.fixture;
const metadata=video.metadata??{path:video.path,duration_seconds:30,width:640,height:360,fps:30,variable_frame_rate:false,video_codec:'h264',audio_codec:null,container:'mp4'};
const analysis={schema_version:1,video:metadata,rallies:[],bounce_times_seconds:[]};
function Harness(){const [output,setOutput]=useState(false);window.showOutput=()=>setOutput(true);
const [clips,setClips]=useState([5,15,25].map((start,index)=>({clipId:'clip'+index,source:'manual',rallyIndex:index+1,bounceCount:0,defaultStart:start,defaultEnd:start+3,start,end:start+3,selected:true})));
const [outputs,setOutputs]=useState({combined_video:true,rally_videos:false,premiere_xml:false});
const [mode,setMode]=useState('source');const [language,setLanguage]=useState('en');window.setDraft=setClips;window.setLanguage=setLanguage;
return output?<CompatibleVideo className="output-preview" src={video.mediaUrl} controls preload="metadata"/>:<CustomCutPage video={video} analysis={analysis} clips={clips} playbackMode={mode} onPlaybackModeChange={setMode} translations={messages(language)} mediaAvailable onClipsChange={setClips} onToggleAll={selected=>setClips(current=>current.map(clip=>({...clip,selected})))} outputs={outputs} onOutputsChange={setOutputs} onExport={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
await build({ root: run, configFile: false, base: './', plugins: [{ name: 'baseline-source', enforce: 'pre', load(id) { return original.get(id); } }, react()], logLevel: 'error', build: { outDir: path.join(run, 'renderer'), emptyOutDir: true } });
const protocolSource = await readFile(path.join(root, 'src/main/media-protocol.ts'), 'utf8');
await writeFile(path.join(run, 'media-protocol.cjs'), ts.transpileModule(protocolSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText);
await writeFile(path.join(run, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',JSON.parse(process.argv.find(a=>a.startsWith('--fixture=')).slice(10)));contextBridge.exposeInMainWorld('ttcut',{platform:'win32',prepareVideoPreview:()=>ipcRenderer.invoke('proxy')});`);
await writeFile(path.join(run, 'main.cjs'), `
const {app,BrowserWindow,protocol,ipcMain}=require('electron');const path=require('node:path');
const originalMedia=${originalMedia};
app.setPath('userData',path.join(__dirname,'user-data'));app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ttcut-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.whenReady().then(async()=>{
 const backend=originalMedia?require('./backend/index.cjs'):require('./media-protocol.cjs');
 const {installMediaProtocol,registerMediaPath}=backend;
 const handle=protocol.handle.bind(protocol);let first=true;
 protocol.handle=(scheme,handler)=>handle(scheme,async request=>{if(first){first=false;await new Promise(resolve=>setTimeout(resolve,1800));}return handler(request)});
 installMediaProtocol();
 const metadata=originalMedia?await backend.probeVideo(${JSON.stringify(media)}):undefined;
 const url=registerMediaPath(${JSON.stringify(media)},metadata?.container==='mov'?'video/quicktime':'video/mp4');
 ipcMain.handle('proxy',async()=>{
  if(!originalMedia)return url;
  console.log('Preparing full original media:',${JSON.stringify(media)});
  const output=${JSON.stringify(reusePreview ?? null)}??await backend.preparePreviewMedia(${JSON.stringify(media)});
  const preview=await backend.probeVideo(output);
  // Production preparation owns truncation validation; a container-duration
  // comparison here would reintroduce the false rejection fixed in that service.
  if(preview.video_codec!=='h264'||!['yuv420p','yuvj420p'].includes(preview.pixel_format))throw new Error('Invalid full preview format');
  console.log('Validated compatible media:',output);
  console.log('Preview metadata:',JSON.stringify({codec:preview.video_codec,pixelFormat:preview.pixel_format,colorRange:preview.color_range,videoDuration:preview.video_duration_seconds,containerDuration:preview.duration_seconds}));
  return registerMediaPath(output);
 });
 const fixture={path:${JSON.stringify(media)},name:path.basename(${JSON.stringify(media)}),size:1,mediaUrl:url,metadata};
 const win=new BrowserWindow({show:true,width:1180,height:760,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,additionalArguments:['--fixture='+JSON.stringify(fixture)]}});
 await win.loadFile(path.join(__dirname,'renderer/index.html'));
});app.on('window-all-closed',()=>app.quit());
`);
const instance = await electron.launch({ args: [path.join(run, 'main.cjs')] });
instance.process().stderr?.on('data', chunk => process.stderr.write(chunk));
instance.process().stdout?.on('data', chunk => process.stdout.write(chunk));
const page = await instance.firstWindow().catch(async error => { await instance.close(); throw error; });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const checks = [];
let passed = false;
page.setDefaultTimeout(10000);
async function frameState(selector = '.custom-monitor video') { return page.locator(selector).evaluate(video => ({ time: video.currentTime, paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames, ready: video.readyState, error: video.error?.message })); }
async function advancing(name, minimum, maximum, selector = '.custom-monitor video') {
 await expect.poll(async () => (await frameState(selector)).time, { timeout: 10000 }).toBeGreaterThan(minimum);
 const before = await frameState(selector);
 if (before.time >= maximum) throw new Error(name + ': wrong selected time ' + before.time);
 await expect.poll(async () => (await frameState(selector)).frames).toBeGreaterThan(before.frames);
 checks.push({ name, before, after: await frameState(selector) });
}
try {
 if (previewOnly) {
  const monitor = page.locator('.custom-monitor video');
  await expect.poll(async () => {
   const alert = page.locator('.custom-preview-status[role="alert"]');
   const failure = await alert.count() ? await alert.textContent() : null;
   if (failure) return failure;
   return (await frameState()).ready >= 2 && await page.locator('.custom-preview-status').count() === 0 ? 'ready' : 'preparing';
  }, { timeout: 180000 }).not.toBe('preparing');
  await expect(page.locator('.custom-preview-status[role="alert"]')).toHaveCount(0);
  await expect(page.locator('.custom-preview-status')).toHaveCount(0);
  await monitor.evaluate(video => video.play());
  await advancing('compatible preview decodes the first frames', 0, 5);
  const duration = await monitor.evaluate(video => video.duration);
  await monitor.evaluate(video => { video.currentTime = video.duration - 3; });
  await advancing('compatible preview decodes the final frames after seeking', duration - 3, duration);
  await page.screenshot({ path: path.join(run, 'preview-regression.png') });
 } else if (zoomOnly) {
  const viewport = page.locator('.timeline-viewport');
  const track = page.locator('.timeline-track-window');
  const button = page.getByRole('button',{name:'Zoom timeline',exact:true});
  await expect(button).toBeVisible();
  await expect.poll(async()=> (await frameState()).ready).toBeGreaterThanOrEqual(2);
  const monitorBefore = await page.locator('.custom-monitor').boundingBox();
  expect(await button.evaluate(element=>element.nextElementSibling?.classList.contains('playback-mode-toggle'))).toBe(true);
  await button.click();
  const bounds = await track.boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.wheel(0,-120);
  await expect.poll(async()=>Number(await viewport.getAttribute('data-zoom'))).toBeGreaterThan(1);
  const enlarged = Number(await viewport.getAttribute('data-zoom'));
  await page.mouse.wheel(0,120);
  await expect.poll(async()=>Number(await viewport.getAttribute('data-zoom'))).toBeLessThan(enlarged);
  expect(await page.locator('.custom-monitor').boundingBox()).toEqual(monitorBefore);
  expect(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(1);
  checks.push({name:'ordinary wheel zoom changes the timeline without resizing the monitor or page',passed:true});
  await page.mouse.wheel(0,-120);
  await expect.poll(async()=>Number(await viewport.getAttribute('data-zoom'))).toBeGreaterThan(1);
  await track.click({button:'right'});
  await expect(button).toHaveAttribute('aria-pressed','false');
  const zoomAfterCancel = Number(await viewport.getAttribute('data-zoom'));
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  const scrollBefore = await viewport.evaluate(element=>element.scrollLeft);
  await page.mouse.wheel(0,120);
  await expect.poll(async()=>await viewport.evaluate(element=>element.scrollLeft)).toBeGreaterThan(scrollBefore);
  expect(Number(await viewport.getAttribute('data-zoom'))).toBe(zoomAfterCancel);
  expect((await frameState()).paused).toBe(true);
  checks.push({name:'right-click cancels zoom and restores horizontal wheel scrolling',passed:true});
  await page.keyboard.down('Control');
  await page.mouse.wheel(0,-120);
  await page.keyboard.up('Control');
  await expect.poll(async()=>Number(await viewport.getAttribute('data-zoom'))).toBeGreaterThan(zoomAfterCancel);
  await button.focus();await page.keyboard.press('Space');
  await expect(button).toHaveAttribute('aria-pressed','false');
  await expect.poll(async()=> (await frameState()).paused).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(async()=> (await frameState()).paused).toBe(true);
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed','false');
  checks.push({name:'modifier shortcut and keyboard toggling remain available',passed:true});
  await page.getByRole('button',{name:'Add rally',exact:true}).click();await button.click();
  await expect(page.getByRole('button',{name:'Add rally',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'Delete rally',exact:true}).click();
  await expect(button).toHaveAttribute('aria-pressed','false');
  await button.click();
  await page.screenshot({path:path.join(run,'zoom-tool-en.png'),animations:'disabled'});
  await page.evaluate(()=>window.setLanguage('zh-CN'));
  await expect(page.getByRole('button',{name:'缩放视频轨',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:path.join(run,'zoom-tool-zh.png'),animations:'disabled'});
  checks.push({name:'exclusive editing tools and Chinese/English button placement',passed:true});
 } else {
 await page.locator('.custom-rally-table tbody tr').nth(1).click();
 if(originalMedia) {
  // Let full-length software transcoding finish; clicks during preparation
  // must be remembered without starting the source's HEVC decoder.
  if(!reusePreview) await expect(page.locator('.custom-preview-status')).toBeVisible();
  await expect(page.locator('.custom-preview-status')).toHaveCount(0,{timeout:900000});
 }
 await advancing('list click before metadata', 15, 18);
 const focusedRow=page.locator('.custom-rally-table tbody tr').nth(1);
 await focusedRow.focus();
 const beforeSpace=await frameState();
 await page.keyboard.press('Space');
 await expect.poll(async()=>(await frameState()).paused).toBe(true);
 const afterSpace=await frameState();
 expect(afterSpace.time).toBeGreaterThanOrEqual(beforeSpace.time);
 await page.keyboard.press('Space');
 await advancing('Space on a focused rally resumes without replaying its start',afterSpace.time,afterSpace.time+2);
 const checkbox=focusedRow.getByRole('checkbox');
 await checkbox.focus();await page.keyboard.press('Space');
 await expect.poll(async()=>(await frameState()).paused).toBe(true);
 await expect(checkbox).toBeChecked();
 await page.keyboard.press('Space');
 await expect.poll(async()=>(await frameState()).paused).toBe(false);
 await expect(checkbox).toBeChecked();
 checks.push({name:'Space on a focused checkbox only toggles playback',passed:true});
 if(originalMedia) {
  const monitor=page.locator('.custom-monitor video');
  await monitor.focus();await page.keyboard.press('Space');
  await expect.poll(async()=>(await frameState()).paused).toBe(true);
  const paused=await frameState();
  await page.keyboard.press('Space');
  await advancing('Space resumes the selected rally',paused.time,paused.time+3);
  const duration=await monitor.evaluate(video=>video.duration);
  await page.evaluate(duration=>window.setDraft(current=>[...current,{...current[0],clipId:'late',rallyIndex:4,start:duration-12,end:duration-9,defaultStart:duration-12,defaultEnd:duration-9}]),duration);
  await page.locator('.custom-rally-table tbody tr').nth(3).click();
  await advancing('seek near the end of the full original video',duration-12,duration-9);
  await page.evaluate(()=>window.setDraft(current=>current.filter(clip=>clip.clipId!=='late')));
 }
 if(originalMedia) await page.locator('.custom-rally-table tbody tr').nth(0).click();
 else await page.locator('.timeline-clip[data-clip-id="clip0"]').click({ position: { x: 15, y: 15 } });
 await advancing(originalMedia?'list click jumps backwards and plays':'timeline click jumps backwards and plays', 5, 8);
 for (const index of [2,0,2,1]) await page.locator('.custom-rally-table tbody tr').nth(index).click();
 await advancing('rapid clicks preserve latest target', 15, 18);
 await page.screenshot({ path: path.join(run, 'custom.png') });
 if (!baseline) {
  const monitor = page.locator('.custom-monitor video');
  const position = async (time, playing = true) => monitor.evaluate(async (video, {time,playing}) => {
   video.currentTime = time; if (playing) await video.play(); else video.pause();
  }, {time,playing});
  await position(12);
  await page.getByRole('button', {name:'Source playback',exact:true}).click();
  await advancing('live switch skips the current gap', 15, 18);
  await page.getByRole('button', {name:'Rally playback',exact:true}).click();
  await position(12);
  await advancing('source mode plays gaps',12,14);
  await page.getByRole('button', {name:'Source playback',exact:true}).click();
  await position(17.8);
  await advancing('rally end automatically jumps to the next decoded clip',25,28);
  await page.screenshot({path:path.join(run,'rally-playback-en.png'),animations:'disabled'});
  await position(27.8);
  await expect.poll(async()=> (await frameState()).paused).toBe(true);
  const stopped = await frameState();
  expect(stopped.time).toBeCloseTo(28,2);
  await monitor.click();
  await advancing('explicit play restarts after the last rally',5,8);
  checks.push({name:'last rally pauses without looping',stopped});
  await position(12,false);
  await page.getByRole('button', {name:'Rally playback',exact:true}).click();
  await page.getByRole('button', {name:'Source playback',exact:true}).click();
  expect((await frameState()).time).toBeCloseTo(12,2);
  expect((await frameState()).paused).toBe(true);
  await monitor.click();
  await advancing('play from a paused gap enters the next rally',15,18);
  await page.evaluate(()=>window.setDraft(current=>current.map(clip=>({...clip,selected:clip.clipId!=='clip1'}))));
  await page.locator('.custom-rally-table tbody tr').nth(1).click();
  await advancing('unselected list clip plays as a temporary preview',15,18);
  await position(17.8);
  await advancing('temporary preview rejoins the selected track',25,28);
  await page.evaluate(()=>window.setDraft(current=>current.map(clip=>({...clip,selected:false}))));
  await position(12);
  await advancing('empty track falls back to source playback',12,14);
  await page.evaluate(()=>window.setDraft(current=>current.map(clip=>({...clip,selected:true}))));
  await advancing('restored clips immediately resume rally playback',15,18);
  for (let index=0; index<4; index++) await page.locator('.playback-mode-toggle').click();
  await advancing('rapid mode switches preserve playback',15,18);
  await position(15.5,false);
  await page.evaluate(()=>window.setLanguage('zh-CN'));
  await expect(page.getByRole('button',{name:'回合播放',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'回合播放',exact:true}).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button',{name:'回合播放',exact:true})).toBeVisible();
  await expect.poll(async()=>(await frameState()).paused).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(async()=>(await frameState()).paused).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'原片播放',exact:true})).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'回合播放',exact:true})).toBeVisible();
  expect((await frameState()).paused).toBe(true);
  await page.screenshot({path:path.join(run,'rally-playback-zh.png'),animations:'disabled'});
  checks.push({name:'Chinese and English button layout and keyboard switching',passed:true});
 }
 if(!originalMedia) {
 await page.evaluate(() => window.showOutput());
 await expect.poll(async () => (await frameState('.output-preview')).ready).toBeGreaterThanOrEqual(2);
 await page.locator('.output-preview').evaluate(video => video.play());
 await advancing('result preview loads and advances', 0, 5, '.output-preview');
 }
 }
 if (errors.length) throw new Error(errors.join('\n'));
 passed = true;
 console.log(JSON.stringify({ passed: true, host: process.platform, baseline, zoomOnly, originalMedia, reusePreview, source, checks, run }, null, 2));
} catch (error) {
 errors.push(String(error));
 throw error;
} finally {
 await writeFile(path.join(run, 'report.json'), JSON.stringify({ passed, host: process.platform, baseline, zoomOnly, originalMedia, reusePreview, source, checks, errors }, null, 2));
 await instance.close();
 console.log('Evidence:', run);
}
