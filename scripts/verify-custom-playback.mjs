// Real Electron/decoded-frame regression using the actual custom page and media protocol.
// Usage: node scripts/verify-custom-playback.mjs [source.mp4] [--baseline]
import { mkdtemp, realpath, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
import { _electron as electron, expect } from '@playwright/test';
const root = path.resolve(import.meta.dirname, '..');
const baseline = process.argv.includes('--baseline');
const source = path.resolve(process.argv.slice(2).find(arg => arg !== '--baseline') ?? path.join(root, 'artifacts/dynamic-roi/full_frame_trajectory.mp4'));
const run = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ttcut-playback-')));
await symlink(path.join(root, 'node_modules'), path.join(run, 'node_modules'), 'dir');
const media = path.join(run, '真实素材 预览.mp4');
execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-i', source, '-t', '30', '-an', '-vf', 'scale=640:-2', '-c:v', 'libx264', '-preset', 'ultrafast', media]);
const original = baseline ? new Map(['src/renderer/CustomCutPage.tsx', 'src/renderer/use-compatible-preview.ts'].map(file => [path.join(root, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' })])) : new Map();
await writeFile(path.join(run, 'index.html'), '<html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(path.join(run, 'entry.tsx'), `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {CustomCutPage} from ${JSON.stringify(path.join(root, 'src/renderer/CustomCutPage.tsx'))};
import {CompatibleVideo} from ${JSON.stringify(path.join(root, 'src/renderer/CompatibleVideo.tsx'))};
import {messages} from ${JSON.stringify(path.join(root, 'src/renderer/i18n.ts'))};
import ${JSON.stringify(path.join(root, 'src/renderer/styles.css'))};
const video = window.fixture;
const metadata={path:video.path,duration_seconds:30,width:640,height:360,fps:30,variable_frame_rate:false,video_codec:'h264',audio_codec:null,container:'mp4'};
const analysis={schema_version:1,video:metadata,rallies:[],bounce_times_seconds:[]};
function Harness(){const [output,setOutput]=useState(false);window.showOutput=()=>setOutput(true);
const [clips,setClips]=useState([5,15,25].map((start,index)=>({clipId:'clip'+index,source:'manual',rallyIndex:index+1,bounceCount:0,defaultStart:start,defaultEnd:start+3,start,end:start+3,selected:true})));
const [outputs,setOutputs]=useState({combined_video:true,rally_videos:false,premiere_xml:false});
return output?<CompatibleVideo className="output-preview" src={video.mediaUrl} controls preload="metadata"/>:<CustomCutPage video={video} analysis={analysis} clips={clips} translations={messages('en')} mediaAvailable onClipsChange={setClips} onToggleAll={()=>{}} outputs={outputs} onOutputsChange={setOutputs} onExport={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
await build({ root: run, configFile: false, base: './', plugins: [{ name: 'baseline-source', enforce: 'pre', load(id) { return original.get(id); } }, react()], logLevel: 'error', build: { outDir: path.join(run, 'renderer'), emptyOutDir: true } });
const protocolSource = await readFile(path.join(root, 'src/main/media-protocol.ts'), 'utf8');
await writeFile(path.join(run, 'media-protocol.cjs'), ts.transpileModule(protocolSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText);
await writeFile(path.join(run, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',JSON.parse(process.argv.find(a=>a.startsWith('--fixture=')).slice(10)));contextBridge.exposeInMainWorld('ttcut',{platform:'win32',prepareVideoPreview:()=>ipcRenderer.invoke('proxy')});`);
await writeFile(path.join(run, 'main.cjs'), `
const {app,BrowserWindow,protocol,ipcMain}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'user-data'));app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'ttcut-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.whenReady().then(async()=>{
 const {installMediaProtocol,registerMediaPath}=require('./media-protocol.cjs');
 const handle=protocol.handle.bind(protocol);let first=true;
 protocol.handle=(scheme,handler)=>handle(scheme,async request=>{if(first){first=false;await new Promise(resolve=>setTimeout(resolve,1800));}return handler(request)});
 installMediaProtocol();const url=registerMediaPath(${JSON.stringify(media)});ipcMain.handle('proxy',()=>url);
 const fixture={path:${JSON.stringify(media)},name:'真实素材.mp4',size:1,mediaUrl:url};
 const win=new BrowserWindow({show:true,width:1180,height:760,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,additionalArguments:['--fixture='+JSON.stringify(fixture)]}});
 await win.loadFile(path.join(__dirname,'renderer/index.html'));
});app.on('window-all-closed',()=>app.quit());
`);
const instance = await electron.launch({ args: [path.join(run, 'main.cjs')] });
instance.process().stderr?.on('data', chunk => process.stderr.write(chunk));
const page = await instance.firstWindow().catch(async error => { await instance.close(); throw error; });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const checks = [];
async function frameState(selector = '.custom-monitor video') { return page.locator(selector).evaluate(video => ({ time: video.currentTime, paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames, ready: video.readyState, error: video.error?.message })); }
async function advancing(name, minimum, maximum, selector = '.custom-monitor video') {
 await expect.poll(async () => (await frameState(selector)).time, { timeout: 10000 }).toBeGreaterThan(minimum);
 const before = await frameState(selector);
 if (before.time >= maximum) throw new Error(name + ': wrong selected time ' + before.time);
 await expect.poll(async () => (await frameState(selector)).frames).toBeGreaterThan(before.frames);
 checks.push({ name, before, after: await frameState(selector) });
}
try {
 await page.locator('.custom-rally-table tbody tr').nth(1).click();
 await advancing('list click before metadata', 15, 18);
 await page.locator('.timeline-clip[data-clip-id="clip0"]').click({ position: { x: 15, y: 15 } });
 await advancing('timeline click jumps backwards and plays', 5, 8);
 for (const index of [2,0,2,1]) await page.locator('.custom-rally-table tbody tr').nth(index).click();
 await advancing('rapid clicks preserve latest target', 15, 18);
 await page.screenshot({ path: path.join(run, 'custom.png') });
 await page.evaluate(() => window.showOutput());
 await expect.poll(async () => (await frameState('.output-preview')).ready).toBeGreaterThanOrEqual(2);
 await page.locator('.output-preview').evaluate(video => video.play());
 await advancing('result preview loads and advances', 0, 5, '.output-preview');
 if (errors.length) throw new Error(errors.join('\n'));
 console.log(JSON.stringify({ passed: true, host: process.platform, baseline, checks, run }, null, 2));
} finally {
 await writeFile(path.join(run, 'report.json'), JSON.stringify({ host: process.platform, baseline, checks, errors }, null, 2));
 await instance.close();
 console.log('Evidence:', run);
}
