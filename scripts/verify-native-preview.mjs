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
const hold = process.argv.includes('--hold');
const recovery = process.argv.includes('--recovery');
const outputRoot = path.join(root, 'output/playwright'); await mkdir(outputRoot, { recursive: true });
const run = await mkdtemp(path.join(outputRoot, 'native-preview-'));
await symlink(path.join(root, 'node_modules'), path.join(run, 'node_modules'), 'junction');
const fixtures = sources.map(source => {
  const probe = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source], { encoding: 'utf8', windowsHide: true }));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const [n, d] = video.avg_frame_rate.split('/').map(Number);
  return { path: source, metadata: { path: source, duration_seconds: Number(probe.format.duration), width: video.width, height: video.height, fps: n / d, video_codec: video.codec_name, pixel_format: video.pix_fmt, color_transfer: video.color_transfer, audio_codec: probe.streams.find(stream => stream.codec_type === 'audio')?.codec_name ?? null, variable_frame_rate: false, container: path.extname(source).slice(1) } };
});
await writeFile(path.join(run, 'backend.ts'), `export * from ${JSON.stringify(path.join(root, 'src/main/native-preview.ts'))};export * from ${JSON.stringify(path.join(root, 'src/main/media-protocol.ts'))};`);
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
function makeClips(duration){return [0,duration*.3,duration*.7].map((start,i)=>({clipId:'clip'+i,source:'manual',rallyIndex:i+1,bounceCount:0,start,end:Math.min(start+3,duration),defaultStart:start,defaultEnd:Math.min(start+3,duration),selected:true,score:{left:i+1,right:i}}));}
function Harness(){const [index,setIndex]=useState(0);window.selectFixture=setIndex;const video=window.fixtures[index];
return <Editor key={index} video={video}/>;}
function Editor({video}){const [clips,setClips]=useState(makeClips(video.metadata.duration_seconds));window.setDraft=setClips;
const [scoreboard,setScoreboard]=useState({enabled:true,x:.06,y:.06,scale:1,left_name:'Player A',right_name:'Player B'});window.scoreboard=scoreboard;
const [mode,setMode]=useState('source');const [outputs,setOutputs]=useState({combined_video:true,rally_videos:false,premiere_xml:false});
return <CustomCutPage video={video} analysis={{schema_version:1,video:video.metadata,rallies:[],bounce_times_seconds:[]}} clips={clips} scoreboard={scoreboard} onScoreboardChange={setScoreboard} playbackMode={mode} onPlaybackModeChange={setMode} translations={messages('en')} mediaAvailable onClipsChange={setClips} onToggleAll={selected=>setClips(c=>c.map(x=>({...x,selected})))} outputs={outputs} onOutputsChange={setOutputs} onExport={()=>{window.exportClicked=true}} onReset={()=>{}}/>;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
await build({ root: run, configFile: false, base: './', logLevel: 'error', plugins: [react()], build: { outDir: path.join(run, 'renderer') } });
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
instance.process().stdout?.on('data', data => process.stdout.write(data));
instance.process().stderr?.on('data', data => process.stderr.write(data));
const page = await instance.firstWindow(); page.setDefaultTimeout(12000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const reports = []; let passed = false;
const surface = page.locator('[data-native-preview]');
async function state() { return surface.evaluate(element => ({ time: Number(element.dataset.time), paused: element.dataset.paused === 'true', ready: element.dataset.ready === 'true', samples: Number(element.dataset.samples), decoder: element.dataset.decoder, mode: element.dataset.mode, seeking: element.dataset.seeking === 'true', firstFrameMs: Number(element.dataset.firstFrameMs) })); }
async function advancing(min, max) {
  await expect.poll(async () => { const value=await state();return value.time > min && value.time < max && !value.seeking; }).toBe(true);
  const before = await state(); expect(before.time).toBeLessThan(max);
  await expect.poll(async () => (await state()).samples).toBeGreaterThan(before.samples);
  return { before, after: await state() };
}
try {
  for (let i = 0; i < fixtures.length; i++) {
    if (i) await page.evaluate(index => window.selectFixture(index), i);
    await expect.poll(async () => {
      const alert = page.locator('[role="alert"]'); if (await alert.count()) throw new Error(await alert.first().textContent());
      return (await state()).ready;
    }, { timeout: 18000 }).toBe(true);
    const report = { source: fixtures[i].path, metadata: fixtures[i].metadata, firstFrame: await state(), checks: [] }; reports.push(report);
    const duration = fixtures[i].metadata.duration_seconds;
    await instance.evaluate(({BrowserWindow}, file)=>global.backend.captureNativePreviewFrame(BrowserWindow.getAllWindows()[0].id,file),path.join(run,`frame-${i}.png`));
    await expect.poll(async()=>Boolean((await stat(path.join(run,`frame-${i}.png`)).catch(()=>null))?.size)).toBe(true);
    await page.locator('.custom-rally-table tbody tr').nth(0).click();
    report.checks.push({name:'original media plays',...await advancing(.15,3)});
    const continuous=await state();const wallStart=Date.now();await page.waitForTimeout(6500);const continued=await state();
    expect(continued.time-continuous.time).toBeGreaterThan(5);expect(continued.samples-continuous.samples).toBeGreaterThan(80);
    report.checks.push({name:'sustained original playback',wallMs:Date.now()-wallStart,before:continuous,after:continued});
    await page.keyboard.press('Space'); await expect.poll(async()=>(await state()).paused).toBe(true);
    await page.keyboard.press('Space'); report.checks.push({name:'space resumes',...await advancing((await state()).time,12)});
    await page.evaluate(duration=>window.setDraft(c=>[...c,{...c[0],clipId:'late',rallyIndex:4,start:duration-2,end:duration-.05,defaultStart:duration-2,defaultEnd:duration-.05}]),duration);
    const seekStart=Date.now();await page.locator('.custom-rally-table tbody tr').nth(3).click();
    report.checks.push({name:'unwarmed end seek',...await advancing(duration-2.05,duration),elapsedMs:Date.now()-seekStart});
    for(const index of [1,0,2,1])await page.locator('.custom-rally-table tbody tr').nth(index).click();
    report.checks.push({name:'latest rapid seek wins',...await advancing(duration*.3-.05,duration*.3+3)});
    await page.keyboard.press('Space');await expect.poll(async()=>(await state()).paused).toBe(true);
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,720));
    await page.screenshot({path:path.join(run,`ui-${i}.png`)});
    report.checks.push({name:'window resize with stable playback session',state:await state()});
    if(i===0){
      await page.locator('.playback-mode-toggle').click();await page.locator('.custom-rally-table tbody tr').nth(0).click();
      await advancing(.1,3);
      await expect.poll(async()=>{const s=await state();return s.time>duration*.3&&s.time<duration*.3+3&&!s.seeking;},{timeout:9000}).toBe(true);
      report.checks.push({name:'rally playback skips the gap automatically',state:await state()});
      await page.locator('.custom-rally-table tbody tr').nth(3).click();
      await expect.poll(async()=>{const s=await state();return s.time>duration-.2&&s.paused&&!s.seeking;},{timeout:9000}).toBe(true);
      report.checks.push({name:'last rally stops at its boundary',state:await state()});
      await page.locator('.playback-mode-toggle').click();
    }
    if(recovery && i===0){
      const original=await state();
      await instance.evaluate(()=>{ const session=[...global.backend.acceptanceSessions.values()][0];session.command({type:'retry'}); });
      await expect.poll(async()=>{const s=await state();return s.ready && !s.seeking && s.mode==='software' && s.decoder==='no';}).toBe(true);
      expect(Math.abs((await state()).time-original.time)).toBeLessThan(.15);expect((await state()).paused).toBe(true);
      report.checks.push({name:'real software decoding retains position and pause',state:await state()});
      const fallbackStart=Date.now();
      // Inject a software timeout into the production watchdog. FFmpeg, disk cache,
      // the native player, source-time mapping and all subsequent playback are real.
      await instance.evaluate(()=>{ const session=[...global.backend.acceptanceSessions.values()][0];session.target=123;session.state=null;session.startedAt=0;session.watchdog(); });
      await expect.poll(async()=>{const s=await state();return s.mode==='proxy' && s.ready && !s.seeking;},{timeout:50000}).toBe(true);
      expect(Math.abs((await state()).time-123)).toBeLessThan(.15);
      const segmentRoot=path.join(await instance.evaluate(({app})=>app.getPath('userData')),'preview-segments/v1');
      const segments=(await readdir(segmentRoot)).filter(f=>f.endsWith('.mp4')&&!f.includes('.partial.')).map(f=>path.join(segmentRoot,f));
      const segmentMetadata=segments.map(file=>JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{encoding:'utf8',windowsHide:true})));
      for(const media of segmentMetadata){expect(Number(media.format.duration)).toBeLessThan(6.2);expect(media.streams.find(s=>s.codec_type==='video').height).toBeLessThanOrEqual(360);}
      report.checks.push({name:'injected timeout produces real bounded segment',elapsedMs:Date.now()-fallbackStart,state:await state(),segments});
      await page.keyboard.press('Space');await expect.poll(async()=>(await state()).time,{timeout:18000}).toBeGreaterThan(127);
      report.checks.push({name:'proxy crosses segment boundary on original timeline',state:await state()});
      await page.locator('.custom-rally-table tbody tr').nth(3).click();
      await expect.poll(async()=>{const s=await state();return s.time>duration-2.1&&s.time<duration&&!s.seeking;},{timeout:50000}).toBe(true);
      report.checks.push({name:'proxy seeks directly to unprepared tail',state:await state()});
    }
    console.log(JSON.stringify(report));
  }
  if(errors.length)throw new Error(errors.join('\n'));
  passed=true;
} catch(error) { errors.push(String(error));console.error(error);console.error('Final transport:',await state().catch(()=>null));console.error('Visible error:',await page.locator('[role="alert"]').allTextContents()); }
await writeFile(path.join(run,'report.json'),JSON.stringify({passed,reports,errors},null,2));
console.log('Evidence:',run);
async function finish(){await instance.evaluate(async({app})=>{await global.backend.closeNativePreviews();setTimeout(()=>app.exit(0),50);}).catch(()=>undefined);await instance.close();}
if(hold){console.log('Holding real Electron window for native input/visual acceptance. Send close on stdin to finish.');process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{if(text.trim()==='close')void finish()});await new Promise(resolve=>instance.process().once('exit',resolve));process.stdin.pause();}
else await finish();
if(!passed)process.exitCode=1;
