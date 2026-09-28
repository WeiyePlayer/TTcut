// Real Electron + production IPC + the staged C++/libmpv runtime. No preview transcode mock.
import { mkdir, mkdtemp, readFile, writeFile, symlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const sources = process.argv.slice(2).filter(arg => !arg.startsWith('--')).map(file => path.resolve(file));
if (!sources.length) throw new Error('Pass one or more original video paths');
const browserOnly = process.argv.includes('--browser');
const outputRoot = path.join(root, 'output/playwright'); await mkdir(outputRoot, { recursive: true });
const run = await mkdtemp(path.join(outputRoot, 'scoreboard-overlay-'));
await symlink(path.join(root, 'node_modules'), path.join(run, 'node_modules'), 'junction');
const fixtures = sources.map(source => {
  const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source], { encoding: 'utf8', windowsHide: true }));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const [n, d] = video.avg_frame_rate.split('/').map(Number);
  return { path: source, metadata: { path: source, duration_seconds: Number(probe.format.duration), width: video.width, height: video.height, fps: n / d, video_codec: video.codec_name, pixel_format: video.pix_fmt, color_transfer: video.color_transfer, audio_codec: probe.streams.find(stream => stream.codec_type === 'audio')?.codec_name ?? null, variable_frame_rate: false, container: path.extname(source).slice(1) } };
});
await writeFile(path.join(run, 'backend.ts'), `export * from ${JSON.stringify(path.join(root, 'src/main/native-preview.ts'))};export * from ${JSON.stringify(path.join(root, 'src/main/media-protocol.ts'))};export * from ${JSON.stringify(path.join(root, 'src/main/media-plan.ts'))};`);
const external = ['electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)];
await build({ root: run, configFile: false, logLevel: 'error', plugins: [{ name: 'acceptance-fault-injection', transform(code,id) { if (id.replaceAll('\\','/').endsWith('/src/main/native-preview.ts')) return code+'\nexport {sessions as acceptanceSessions};'; } }], build: { outDir: path.join(run, 'backend'), lib: { entry: path.join(run, 'backend.ts'), formats: ['cjs'], fileName: () => 'index.cjs' }, rollupOptions: { external } } });
await writeFile(path.join(run, 'preload.ts'), `import ${JSON.stringify(path.join(root, 'src/preload/index.ts'))};import {contextBridge} from 'electron';contextBridge.exposeInMainWorld('fixtures',JSON.parse(process.argv.find(a=>a.startsWith('--fixtures=')).slice(11)));`);
await build({ root: run, configFile: false, logLevel: 'error', build: { outDir: path.join(run, 'preload'), lib: { entry: path.join(run, 'preload.ts'), formats: ['cjs'], fileName: () => 'index.cjs' }, rollupOptions: { external } } });
await writeFile(path.join(run, 'index.html'), '<html lang="en"><head><meta charset="utf-8"><title>TTcut libmpv acceptance</title></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(path.join(run, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {CustomCutPage} from ${JSON.stringify(path.join(root, 'src/renderer/CustomCutPage.tsx'))};
import {messages} from ${JSON.stringify(path.join(root, 'src/renderer/i18n.ts'))};
import ${JSON.stringify(path.join(root, 'src/renderer/styles.css'))};
import '@fontsource-variable/noto-sans-sc';
import {resolvedSelectedClipScores} from ${JSON.stringify(path.join(root, 'src/domain/custom-clips.ts'))};
import {renderScoreboardImage} from ${JSON.stringify(path.join(root, 'src/renderer/scoreboard-canvas.ts'))};
function makeClips(duration){return [0,duration*.3,duration*.7].map((start,i)=>({clipId:'clip'+i,source:'manual',rallyIndex:i+1,bounceCount:0,start,end:Math.min(start+3,duration),defaultStart:start,defaultEnd:Math.min(start+3,duration),selected:i!==2}));}
function Harness(){const [index,setIndex]=useState(0);window.selectFixture=setIndex;const video=window.fixtures[index];
return <Editor key={index} video={video}/>;}
function Editor({video}){const [clips,setClips]=useState(makeClips(video.metadata.duration_seconds));window.setDraft=setClips;window.clips=clips;window.scores=Object.fromEntries(resolvedSelectedClipScores(clips));
const [scoreboard,setScoreboard]=useState({enabled:true,x:.06,y:.06,scale:1,left_name:'Player A',right_name:'Player B'});window.scoreboard=scoreboard;window.exportBoards=async()=>{await document.fonts.load('800 24px "Noto Sans SC Variable"',scoreboard.left_name+scoreboard.right_name+'0123456789');return clips.filter(c=>c.selected).map(c=>({clip:c,score:window.scores[c.clipId],image:renderScoreboardImage(video.metadata.width,video.metadata.height,scoreboard,window.scores[c.clipId])}));};
const [mode,setMode]=useState('source');const [outputs,setOutputs]=useState({combined_video:true,rally_videos:false,premiere_xml:false});
return <CustomCutPage video={video} analysis={{schema_version:1,video:video.metadata,rallies:[],bounce_times_seconds:[]}} clips={clips} scoreboard={scoreboard} onScoreboardChange={setScoreboard} playbackMode={mode} onPlaybackModeChange={setMode} translations={messages('en')} mediaAvailable onClipsChange={setClips} onToggleAll={selected=>setClips(c=>c.map(x=>({...x,selected})))} outputs={outputs} onOutputsChange={setOutputs} onExport={()=>{window.exportClicked=true}} onReset={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
await build({ root: run, configFile: false, base: './', logLevel: 'error', plugins: [react(), { name: 'browser-preview-acceptance', transform(code, id) { if (browserOnly && id.replaceAll('\\\\','/').endsWith('/src/renderer/CustomCutPage.tsx')) return code.replace(/const nativeEnabled = [^;]+;/, 'const nativeEnabled = false;'); } }], build: { outDir: path.join(run, 'renderer') } });
await writeFile(path.join(run, 'main.cjs'), `
const {app,BrowserWindow,protocol}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'user-data'));
app.setAppPath(${JSON.stringify(root)});
protocol.registerSchemesAsPrivileged([{scheme:'ttcut-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
global.backend=require('./backend/index.cjs');
app.whenReady().then(async()=>{backend.installMediaProtocol();backend.registerNativePreviewIpc();
const fixtures=${JSON.stringify(fixtures)}.map(f=>({...f,name:path.basename(f.path),size:1,mediaUrl:backend.registerMediaPath(f.path)}));
global.win=new BrowserWindow({title:'TTcut libmpv acceptance',show:true,width:1180,height:760,frame:false,webPreferences:{preload:path.join(__dirname,'preload/index.cjs'),contextIsolation:true,sandbox:true,additionalArguments:['--fixtures='+JSON.stringify(fixtures)]}});
await win.loadFile(path.join(__dirname,'renderer/index.html'));});
app.on('window-all-closed',()=>{backend.closeNativePreviews().then(()=>app.quit())});
`);

const instance = await electron.launch({ args: [path.join(run, 'main.cjs')], cwd: root });
const page = await instance.firstWindow(); page.setDefaultTimeout(15000);
const errors=[];page.on('pageerror',e=>errors.push(String(e)));
await page.evaluate(()=>{window.inputEvents=[];window.ttcut.onNativePreviewEvent(event=>{if(event.type!=='state')window.inputEvents.push(event);});});
const checks=[];let passed=false;

if (browserOnly) {
 try {
  const video=page.locator('.custom-monitor video');await expect.poll(()=>video.evaluate(v=>v.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('.custom-rally-table tbody tr').first().click();
  await expect.poll(()=>video.evaluate(v=>v.currentTime)).toBeGreaterThan(0);
  await page.keyboard.press('Space');
  await expect.poll(()=>video.evaluate(v=>v.paused)).toBe(true);
  const point=page.locator('.custom-scoreboard-points').first();
  await point.dblclick();await expect(point.locator('input')).toBeVisible();
  await point.locator('input').fill('04');await point.locator('input').press('Enter');await expect(point).toHaveText('4');
  await point.dblclick();await point.locator('input').fill('');await expect(point.locator('input')).toHaveValue('0');
  await point.locator('input').press('Backspace');await point.locator('input').press('2');await expect(point.locator('input')).toHaveValue('2');
  await point.locator('input').fill('4');await point.locator('input').press('Enter');
  const name=page.locator('.custom-scoreboard-name').first();
  await name.dblclick();await name.locator('input').fill('林昀儒 LIN');await name.locator('input').press('Enter');await expect(name).toHaveText('林昀儒 LIN');
  await point.hover();await page.mouse.wheel(0,-100);await expect(point).toHaveText('5');
  await page.locator('.custom-scoreboard-winner').first().click();await expect(point).toHaveText('6');
  await expect.poll(()=>video.evaluate(v=>v.currentTime)).toBeGreaterThan(150);
  await page.keyboard.press('Space');await expect.poll(()=>video.evaluate(v=>v.paused)).toBe(true);
  const before=await page.evaluate(()=>window.scoreboard.x),box=await name.boundingBox();
  await page.mouse.move(box.x+20,box.y+12);await page.mouse.down();await page.mouse.move(box.x+100,box.y+45,{steps:8});await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>window.scoreboard.x)).toBeGreaterThan(before);
  await expect(page.locator('.custom-rally-table input[type=checkbox]')).toHaveCount(3);
  await page.screenshot({path:path.join(run,'browser-overlay.png')});
  expect(errors).toEqual([]);passed=true;checks.push('actual Chromium pointer double-click, Unicode editing, zero normalization, wheel, next-rally scoring and dragging');
 } catch(error) { errors.push(String(error.stack)); }
 await writeFile(path.join(run,'report.json'),JSON.stringify({passed,checks,errors},null,2));console.log(JSON.stringify({passed,checks,errors,run}));
 await instance.close();process.exit(passed?0:1);
}
const surface=page.locator('[data-native-preview]');
const hwnd=await instance.evaluate(()=>global.win.getNativeWindowHandle().readUInt32LE());
async function currentOverlay(){return instance.evaluate(()=>[...global.backend.acceptanceSessions.values()][0].scoreboard);}
async function go(index){
 await page.locator('.custom-rally-table tbody tr').nth(index).click();
 await expect.poll(()=>surface.getAttribute('data-seeking')).toBe('false');
 await expect.poll(()=>surface.getAttribute('data-paused')).toBe('false');
 input('pause');
 await expect.poll(()=>surface.getAttribute('data-paused')).toBe('true');
 await expect.poll(async()=>(await currentOverlay()).clipId).toBe('clip'+index);
}
function input(action,x=0,y=0,value='',dx=0,dy=0){
 execFileSync('C:/Program Files/PowerShell/7/pwsh.exe',['-NoLogo','-NoProfile','-File',path.join(root,'scripts/scoreboard-native-input.ps1'),String(hwnd),action,String(x),String(y),value,String(dx),String(dy)],{windowsHide:true,encoding:'utf8'});
}
async function boardInput(action,rx,ry,value='',dx=0,dy=0){
 const b=await currentOverlay();const box=await surface.boundingBox();
 const vw=Math.min(box.width,box.height*b.aspect),vh=vw/b.aspect;
 const x=((box.width-vw)/2+vw*(b.x+.28*b.scale*rx))/box.width;
 const y=((box.height-vh)/2+vh*b.y+vw*.28*b.scale/5.2*ry)/box.height;
 input(action,x,y,value,dx,dy);
}
try {
 await expect.poll(()=>surface.getAttribute('data-ready')).toBe('true');
 await expect(page.locator('.custom-rally-table tbody tr')).toHaveCount(3);
 await expect(page.getByRole('checkbox',{name:'Rally 3',exact:true})).not.toBeChecked();
 await expect(page.getByRole('button',{name:'Multi-select',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Clear all',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Scoreboard',exact:true}).click();
 await expect.poll(async()=>(await currentOverlay()).enabled).toBe(false);
 await page.getByRole('button',{name:'Scoreboard',exact:true}).click();
 await expect.poll(async()=>(await currentOverlay()).enabled).toBe(true);
 await expect(page.locator('.custom-rally-table tbody tr')).toHaveCount(3);
 checks.push('overlay toggle preserves the ordinary rally list and checkboxes');
 await go(0);
 await boardInput('click',1.08,.25);
 await expect.poll(async()=>(await currentOverlay()).clipId).toBe('clip1');
 expect((await currentOverlay()).left).toBe(1);
 expect(await surface.getAttribute('data-paused')).toBe('false');
 await go(0);expect((await currentOverlay()).winner).toBe('left');expect((await currentOverlay()).left).toBe(0);
 await boardInput('click',1.08,.25);
 await expect.poll(async()=>(await currentOverlay()).clipId).toBe('clip1');
 expect((await currentOverlay()).left).toBe(1);
 await go(0);await boardInput('click',1.08,.75);
 await expect.poll(async()=>(await currentOverlay()).clipId).toBe('clip1');
 expect((await currentOverlay()).left).toBe(0);expect((await currentOverlay()).right).toBe(1);
 await go(0);expect((await currentOverlay()).winner).toBe('right');
 checks.push('Win32 winner clicks score and play the next selected rally; repeated choices are idempotent; switching winner replaces the check');
 await go(0);
 await boardInput('edit',.94,.25,'4');
 await expect.poll(async()=>(await currentOverlay()).left).toBe(4);
 await boardInput('edit',.94,.75,'3');
 await expect.poll(async()=>(await currentOverlay()).right).toBe(3);
 await boardInput('wheel',.82,.25,'120');
 await expect.poll(async()=>(await currentOverlay()).leftGames).toBe(1);
 await boardInput('wheel',.94,.25,'120');
 await expect.poll(async()=>(await currentOverlay()).left).toBe(5);
 await boardInput('wheel',.94,.25,'down');
 await expect.poll(async()=>(await currentOverlay()).left).toBe(4);
 await boardInput('click',1.08,.25);
 await go(1);expect((await currentOverlay()).left).toBe(5);expect((await currentOverlay()).right).toBe(3);expect((await currentOverlay()).leftGames).toBe(1);
 checks.push('native manual edits and wheel changes form the next rally score; major score is manual only');
 await go(0);await boardInput('edit',.35,.25,'林昀儒 LIN');
 await expect.poll(async()=>(await currentOverlay()).leftName).toBe('林昀儒 LIN');
 await boardInput('edit',.35,.75,'张本智和');
 await expect.poll(async()=>(await currentOverlay()).rightName).toBe('张本智和');
 const before=await currentOverlay();await boardInput('drag',.4,.4,'',.10,.06);
 await expect.poll(async()=>(await currentOverlay()).x).toBeGreaterThan(before.x+.05);
 const moved=await currentOverlay();await boardInput('drag',1,1,'',.04,.015);
 await expect.poll(async()=>(await currentOverlay()).scale).toBeGreaterThan(moved.scale+.05);
 checks.push('native Unicode name editing, Win32 pointer drag and proportional corner resize');
 const capture=path.join(run,'native-scoreboard.png');
 await instance.evaluate(({BrowserWindow},file)=>global.backend.captureNativePreviewFrame(BrowserWindow.getAllWindows()[0].id,file),capture);
 await expect.poll(async()=>Boolean((await stat(capture).catch(()=>null))?.size)).toBe(true);
 await page.screenshot({path:path.join(run,'ui.png')});
 const boards=await page.evaluate(()=>window.exportBoards());const scoreboard=await page.evaluate(()=>window.scoreboard);
 const metadata=fixtures[0].metadata;const ffmpeg=path.join(root,'.runtime/windows/ffmpeg/ffmpeg.exe');
 const ff=(args)=>execFileSync(ffmpeg,['-hide_banner','-loglevel','error',...args],{windowsHide:true,maxBuffer:16_000_000});
 const outputs=[];
 for(let i=0;i<boards.length;i++){
  const b=boards[i],imagePath=path.join(run,'score-'+i+'.png'),output=path.join(run,'clip-'+i+'.mp4');
  await writeFile(imagePath,Buffer.from(b.image.split(',')[1],'base64'));
  const args=await instance.evaluate((_,p)=>global.backend.buildSegmentReencodeArgs(p.source,p.output,{rallyIds:[p.clip.clipId],rawStart:p.clip.start,rawEnd:p.clip.end,start:p.clip.start,end:p.clip.end},0,p.metadata,'libx264',{...p.scoreboard,imagePath:p.imagePath}),{source:fixtures[0].path,output,clip:b.clip,metadata,scoreboard,imagePath});
  ff(args);outputs.push(output);
  ff(['-y','-ss','0.5','-i',output,'-frames:v','1',path.join(run,'export-frame-'+i+'.png')]);
 }
 const manifest=path.join(run,'segments.ffconcat');await writeFile(manifest,outputs.map(file=>"file '"+file.replaceAll('\\','/')+"'").join('\n'));
 const combined=path.join(run,'scoreboard-export.mp4');ff(['-y','-f','concat','-safe','0','-i',manifest,'-c','copy',combined]);
 expect(boards.map(b=>[b.score.left,b.score.right,b.score.left_games])).toEqual([[4,3,1],[5,3,1]]);
 // Compare the UI-only button region against the unmodified source at the same frame.
 const bw=Math.round(metadata.width*.28*scoreboard.scale),bh=Math.round(bw/5.2);
 const x=Math.round(metadata.width*scoreboard.x),y=Math.round(metadata.height*scoreboard.y);
 const cropX=Math.ceil(x+bw*1.02),cropY=y+2,cropW=Math.max(2,Math.floor(bw*.12)-2),cropH=bh-4;
 const crop=`crop=${cropW}:${cropH}:${cropX}:${cropY}`;
 const original=ff(['-ss',String(boards[0].clip.start+.5),'-i',fixtures[0].path,'-frames:v','1','-vf',crop,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 const exported=ff(['-ss','0.5','-i',outputs[0],'-frames:v','1','-vf',crop,'-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
 expect(original.length).toBe(exported.length);
 let difference=0;for(let i=0;i<original.length;i++)difference+=Math.abs(original[i]-exported[i]);
 const meanDifference=difference/original.length;expect(meanDifference).toBeLessThan(12);
 checks.push('real FFmpeg clip + combined export: 4:3 then 5:3; original pixels remain in the button region, mean difference '+meanDifference.toFixed(2));
 expect(errors).toEqual([]);passed=true;
} catch(error){errors.push(String(error.stack));console.error(error);console.error('Recent input events',await page.evaluate(()=>window.inputEvents.slice(-8)));console.error('Draft',await page.evaluate(()=>window.clips));}
await writeFile(path.join(run,'report.json'),JSON.stringify({passed,checks,errors},null,2));console.log(JSON.stringify({passed,checks,errors,run}));
await instance.evaluate(async({app})=>{await global.backend.closeNativePreviews();setTimeout(()=>app.exit(0),50);}).catch(()=>{});
await instance.close();if(!passed)process.exitCode=1;
