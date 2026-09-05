import path from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat, appendFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const app = path.resolve(process.argv[2] ?? path.join(root, 'out/TTcut-darwin-arm64/TTcut.app'));
const out = path.resolve(process.env.TTCUT_VERIFY_OUTPUT ?? path.join(root, 'output/electron-macos')); await mkdir(out, { recursive: true });
const run = await mkdtemp(path.join(out, 'run-')); const userData = path.join(run, 'user-data');
const media = path.join(run, '合成素材 with spaces.mp4');
const ffmpeg = path.join(app, 'Contents/Resources/runtime/bin/ffmpeg');
const generated = spawnSync(ffmpeg, ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15:duration=10','-f','lavfi','-i','sine=frequency=600:sample_rate=48000:duration=10','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',media], { encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
const server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r));
const offlineSandbox = process.env.TTCUT_VERIFY_OFFLINE_SANDBOX === '1';
const networkProfile = '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))';
if (offlineSandbox) {
  const blocked=spawnSync('/usr/bin/sandbox-exec',['-p',networkProfile,'/usr/bin/python3','-c','import socket\ntry: socket.create_connection(("1.1.1.1",443),2)\nexcept PermissionError: raise SystemExit(0)\nraise SystemExit(1)'],{encoding:'utf8'});
  assert.equal(blocked.status,0,'Offline sandbox must reject outbound connections: '+blocked.stderr);
}
const executable=path.join(app,'Contents/MacOS/TTcut');
const args=[`--remote-debugging-port=${port}`,`--user-data-dir=${userData}`];
// Test-only: macOS rejects Chromium's nested sandbox under sandbox-exec. The outer
// OS sandbox blocks internet for this entire process tree. Default launch is tested separately.
if (offlineSandbox) args.push('--no-sandbox');
const child = spawn(offlineSandbox ? '/usr/bin/sandbox-exec' : executable, offlineSandbox ? ['-p',networkProfile,executable,...args] : args, { env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore','pipe','pipe'] });
let stderr=''; child.stderr.on('data',(b)=>{stderr+=b.toString();}); child.stdout.on('data',(b)=>{stderr+=b.toString();});
let browser; let page; const checks=[];
async function check(name, work) { const value=await work(); checks.push({ name, passed:true }); console.log(`PASS ${name}`); await writeFile(path.join(run,'report.json'),JSON.stringify({app,offlineSandbox,checks},null,2)); return value; }
async function task(method, input) {
  const id=await page.evaluate(async({method,input})=>window.ttcut[method](input),{method,input});
  await page.waitForFunction((id)=>window.__events.some((e)=>e.taskId===id && ['analysis-result','calibration-result','export-result','error'].includes(e.type)),id,{timeout:180000});
  return page.evaluate((id)=>window.__events.find((e)=>e.taskId===id && ['analysis-result','calibration-result','export-result','error'].includes(e.type)),id);
}
try {
  const deadline=Date.now()+45000;
  while (Date.now()<deadline) { try { browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { if(child.exitCode!==null) throw new Error(stderr); await new Promise(r=>setTimeout(r,250)); } }
  assert.ok(browser,'CDP unavailable');
  for(let attempt=0;attempt<100&&!page;attempt++){page=browser.contexts()[0]?.pages()[0];if(!page)await new Promise(r=>setTimeout(r,100));}
  assert.ok(page,'Renderer did not launch: '+stderr); await page.waitForFunction(()=>Boolean(window.ttcut),null,{timeout:30000});
  await page.evaluate(()=>{window.__events=[];window.ttcut.onTaskEvent(e=>window.__events.push(e));});
  await browser.contexts()[0].setOffline(true);
  const bootstrap=await check('offline runtime bootstrap with system-only PATH', async()=>{const value=await page.evaluate(()=>window.ttcut.bootstrap()); assert.equal(value.platformCompatibility.status,'supported');assert.equal(value.components.analysis.acceleration,'coreml');assert.equal(value.components.media.available,true);assert.equal(value.capabilities.managedComponents,false);assert.ok(value.logsPath.startsWith(userData));return value;});
  await check('Chinese Electron UI and native titlebar',async()=>{await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('内置运行时',{exact:true}).waitFor();assert.equal(await page.locator('.window-controls').count(),0);assert.equal(await page.locator('.setup-manual').count(),0);await page.screenshot({path:path.join(run,'settings-zh.png')});});
  await check('English UI',async()=>{await page.evaluate(async(settings)=>window.ttcut.saveSettings({...settings,language:'en'}),bootstrap.settings);await page.reload();await page.waitForFunction(()=>Boolean(window.ttcut));await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByText('Built-in runtime',{exact:true}).waitFor();await page.screenshot({path:path.join(run,'settings-en.png')});await page.evaluate(()=>{window.__events=[];window.ttcut.onTaskEvent(e=>window.__events.push(e));});});
  const video=await check('source import and native probe',async()=>{const selected=await page.evaluate(p=>window.ttcut.acceptDroppedVideo(p),media); const v=await page.evaluate(p=>window.ttcut.probeVideo(p),media);assert.equal(v.width,320);assert.equal(v.native_video.bitDepth,8);return selected;});
  const calibration={video_width:320,video_height:180,points:{top_left:[60,40],top_right:[250,40],bottom_right:[275,145],bottom_left:[40,145]}};
  await check('actual table Core ML invocation',async()=>{const result=await task('startAutoCalibration',{videoPath:media,device:'auto'});assert.ok(result.type==='calibration-result'||result.code==='AUTO_CALIBRATION_FAILED',JSON.stringify(result));assert.ok(await page.evaluate(()=>window.__events.some(e=>e.type==='progress'&&e.data.stage==='table_inference')));});
  const input={videoPath:media,calibrationChoice:{method:'manual',calibration},device:'auto',historyVisibility:'visible',analysisMode:'full',rallyRecognitionMethod:'bounce_events',normalizeVariableFrameRate:false,blurballConfidenceThreshold:0.7,blurballStage1ConfidenceThreshold:0.3,blurballStage2ConfidenceThreshold:0.7};
  const analysis=await check('actual BlurBall Core ML full analysis',async()=>{const result=await task('startAnalysis',input);assert.equal(result.type,'analysis-result',JSON.stringify(result));assert.equal(result.data.inference_runtime.engine,'coreml');return result;});
  await check('actual BlurBall two-stage analysis',async()=>{const result=await task('startAnalysis',{...input,analysisMode:'two_stage'});assert.equal(result.type,'analysis-result',JSON.stringify(result));assert.equal(result.data.model_provenance.analysis.mode,'two_stage');});
  await check('compatible preview is separate from analysis media',async()=>{const url=await page.evaluate(async v=>window.ttcut.preparePreview(v.mediaUrl,crypto.randomUUID()),video);assert.notEqual(url,video.mediaUrl);const reopened=await page.evaluate(id=>window.ttcut.openHistory(id),analysis.analysisId);assert.equal(reopened.analysis.video.path,media);});
  const segment={clip_id:'manual_11111111-1111-4111-8111-111111111111',source:'manual',display_index:1,start_time_seconds:0.5,end_time_seconds:1.5};
  const request={analysis_id:analysis.analysisId,destination:'source',selection:{mode:'custom',segments:[segment]}};
  const combined=await check('Electron-selected manual range combined export',async()=>{const result=await task('startExport',request);assert.equal(result.type,'export-result',JSON.stringify(result));assert.ok((await stat(result.data.outputPath)).size>0);return result.data.outputPath;});
  await check('separate rally MP4 and Premiere XML export',async()=>{const result=await task('startExport',{...request,outputs:{combined_video:false,rally_videos:true,premiere_xml:true}});assert.equal(result.type,'export-result',JSON.stringify(result));assert.equal(result.data.rallyVideos.length,1,JSON.stringify(result));assert.ok(result.data.premiereXml);assert.ok((await readFile(result.data.premiereXml.outputPath,'utf8')).includes('<xmeml'));});
  await check('cancel analysis and release task slot',async()=>{const id=await page.evaluate(async value=>window.ttcut.startAnalysis(value),input);await page.evaluate(id=>window.ttcut.cancelTask(id),id);await page.waitForFunction(id=>window.__events.some(e=>e.taskId===id&&e.code==='ANALYSIS_CANCELLED'),id);});
  await check('actual Worker crash produces failure and releases the task slot',async()=>{
    const id=await page.evaluate(value=>window.ttcut.startAnalysis(value),input);
    let workerPID;const deadline=Date.now()+30000;
    while(Date.now()<deadline&&!workerPID){
      const entries=spawnSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).stdout.split('\n');
      for(const line of entries){const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);if(match&&Number(match[2])===child.pid&&match[3].endsWith('/TTcutWorker'))workerPID=Number(match[1]);}
      if(!workerPID)await new Promise(r=>setTimeout(r,25));
    }
    assert.ok(workerPID,'Worker did not launch');process.kill(workerPID,'SIGKILL');
    await page.waitForFunction(id=>window.__events.some(e=>e.taskId===id&&e.type==='error'&&e.code==='WORKER_EXITED'),id,{timeout:30000});
    await page.evaluate(id=>window.ttcut.openHistory(id),analysis.analysisId);
  });
  await check('hide retains renderer state and app process',async()=>{await page.evaluate(()=>{window.__retained='retained';return window.ttcut.close();});await page.waitForFunction(async()=>!(await window.ttcut.bootstrap()).windowState.visible,null,{polling:100});assert.equal(child.exitCode,null);spawnSync('open',['-a',app]);await page.waitForFunction(async()=>(await window.ttcut.bootstrap()).windowState.visible,null,{polling:100});assert.equal(await page.evaluate(()=>window.__retained),'retained');});
  for (const transfer of ['smpte2084','arib-std-b67']) {
    await check(`Electron HDR export and SDR preview (${transfer})`,async()=>{
      const hdrFile=path.join(run,transfer+'.mp4');
      const generated=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15:duration=2','-c:v','libx265','-preset','ultrafast','-pix_fmt','yuv420p10le','-x265-params',`pools=2:frame-threads=2:log-level=error:colorprim=bt2020:colormatrix=bt2020nc:transfer=${transfer}`,'-color_primaries','bt2020','-color_trc',transfer,'-colorspace','bt2020nc','-tag:v','hvc1',hdrFile],{encoding:'utf8'});
      assert.equal(generated.status,0,generated.stderr);
      const sourceProbe=await page.evaluate(p=>window.ttcut.probeVideo(p),hdrFile);assert.equal(sourceProbe.color_transfer,transfer);assert.equal(sourceProbe.native_video.hdr,transfer==='smpte2084'?'hdr10':'hlg');
      if(transfer==='smpte2084') await writeFile(path.join(run,'native-silent-hdr.json'),JSON.stringify({...sourceProbe.native_video,path:'/tmp/silent-hdr.mp4'},null,2)+'\n');
      const result=await task('startAnalysis',{...input,videoPath:hdrFile});assert.equal(result.type,'analysis-result',JSON.stringify(result));
      const exported=await task('startExport',{...request,analysis_id:result.analysisId});assert.equal(exported.type,'export-result',JSON.stringify(exported));
      const probe=await page.evaluate(p=>window.ttcut.probeVideo(p),exported.data.outputPath);assert.equal(probe.video_codec,'hevc');assert.equal(probe.native_video.bitDepth,10);assert.equal(probe.color_transfer,transfer);
      const selected=await page.evaluate(p=>window.ttcut.acceptDroppedVideo(p),hdrFile);
      const proxy=await page.evaluate(v=>window.ttcut.preparePreview(v.mediaUrl,crypto.randomUUID()),selected);assert.notEqual(proxy,selected.mediaUrl);
      await page.evaluate(url=>new Promise((resolve,reject)=>{const video=document.createElement('video');video.src=url;video.muted=true;document.body.append(video);const timer=setTimeout(()=>{video.remove();reject(new Error('SDR preview playback timeout'));},15000);video.onplaying=()=>{clearTimeout(timer);video.pause();video.remove();resolve(true);};video.onerror=()=>{clearTimeout(timer);video.remove();reject(new Error('SDR preview decode failed'));};video.play().catch(reject);}),proxy);
      await page.evaluate(id=>window.ttcut.deleteHistory(id),result.analysisId);
    });
  }
  await check('VFR normalization, damaged cache detection, regeneration and deletion',async()=>{
    const vfr=path.join(run,'vfr.mp4');
    const generated=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=3','-vf','select=if(lt(t\\,1)\\,1\\,not(mod(n\\,3)))','-fps_mode','vfr','-c:v','libx264','-preset','ultrafast',vfr],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
    const initial=await page.evaluate(p=>window.ttcut.probeVideo(p),vfr);assert.equal(initial.variable_frame_rate,true);
    const normalized=await task('startAnalysis',{...input,videoPath:vfr,normalizeVariableFrameRate:true});assert.equal(normalized.type,'analysis-result',JSON.stringify(normalized));assert.equal(normalized.data.processing.mode,'normalized_cfr');assert.notEqual(normalized.data.video.path,vfr);assert.equal(normalized.data.source_video.path,vfr);
    const cache=normalized.data.video.path;assert.ok(cache.startsWith(userData));
    const exported=await task('startExport',{...request,analysis_id:normalized.analysisId});assert.equal(exported.type,'export-result',JSON.stringify(exported));
    await writeFile(cache,'damaged fixture');
    const error=await page.evaluate(async id=>{try{await window.ttcut.openHistory(id);return null;}catch(error){return String(error);}},normalized.analysisId);assert.match(error,/HISTORY_PROCESSING_MEDIA_CORRUPT/);
    const repaired=await task('startAnalysis',{...input,videoPath:vfr,normalizeVariableFrameRate:true});assert.equal(repaired.type,'analysis-result',JSON.stringify(repaired));assert.equal(repaired.data.processing.mode,'normalized_cfr');
    await page.evaluate(id=>window.ttcut.deleteHistory(id),repaired.analysisId);assert.equal(await stat(cache).then(()=>true,()=>false),false);assert.ok((await stat(vfr)).size>0);assert.ok((await stat(exported.data.outputPath)).size>0);
  });
  // Controlled nonempty history is test data only; real model results above are reported separately.
  const recordPath=path.join(userData,'history/records',analysis.analysisId+'.json');
  const record=JSON.parse(await readFile(recordPath,'utf8'));record.analysis.rallies=[{id:'rally_001',index:1,start_time_seconds:0.5,end_time_seconds:2,bounce_count:4},{id:'rally_002',index:2,start_time_seconds:2.5,end_time_seconds:3.5,bounce_count:8}];record.analysis.bounce_times_seconds=[0.5,0.8,1.1,1.5,2.5,2.6,2.7,2.8,2.9,3,3.2,3.4];await writeFile(recordPath,JSON.stringify(record));
  await check('history review with controlled nonempty fixture',async()=>{await page.reload();await page.waitForFunction(()=>Boolean(window.ttcut));await page.getByRole('button',{name:'History',exact:true}).click();await page.locator('.history-card').first().waitFor();
    await page.locator('.history-open').first().click();
    await page.locator('.mode-card').filter({hasText:'All rallies'}).waitFor();
    await page.locator('.mode-card').filter({hasText:'Highlight rallies'}).click();
    await page.getByText('> 7',{exact:true}).click();
    assert.match(await page.locator('.footer-actions').innerText(),/1 \/ 2/);
    await page.locator('.mode-card').filter({hasText:'Custom'}).click();
    await page.getByRole('button',{name:'Clear all',exact:true}).click();
    assert.equal(await page.locator('.custom-rally-list input:checked').count(),0);
    await page.getByRole('button',{name:'Select all',exact:true}).click();
    assert.equal(await page.locator('.custom-rally-list input:checked').count(),2);
    const timelineBox=await page.locator('.timeline-viewport').boundingBox();await page.mouse.move(timelineBox.x+timelineBox.width/2,timelineBox.y+20);await page.keyboard.down('Meta');await page.mouse.wheel(0,-100);await page.keyboard.up('Meta');
    await page.waitForFunction(()=>Number(document.querySelector('.timeline-viewport').dataset.zoom)>1);
    await page.keyboard.down('Meta');await page.mouse.wheel(0,100);await page.keyboard.up('Meta');
    const endHandle=page.locator('.clip-handle.end').last();const oldEnd=Number(await endHandle.getAttribute('aria-valuenow'));const handleBox=await endHandle.boundingBox();
    await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down();await page.mouse.move(handleBox.x-25,handleBox.y+handleBox.height/2,{steps:5});await page.mouse.up();
    assert.ok(Number(await endHandle.getAttribute('aria-valuenow'))<oldEnd);
    await page.getByRole('button',{name:'Add rally',exact:true}).click();const trackBox=await page.locator('.timeline-track-window').boundingBox();await page.mouse.click(trackBox.x+trackBox.width*0.8,trackBox.y+trackBox.height/2);
    await page.locator('.timeline-clip[data-clip-id^="manual_"]').waitFor();assert.equal(await page.locator('.timeline-clip').count(),3);
    await page.getByRole('button',{name:'Delete rally',exact:true}).click();await page.locator('.timeline-clip[data-clip-id^="manual_"]').click();assert.equal(await page.locator('.timeline-clip').count(),2);
    await page.locator('.custom-workspace').click({button:'right',position:{x:2,y:2}});
    await page.locator('video').evaluate(video=>{video.pause();video.currentTime=0;video.muted=true;});
    await page.locator('video').press('Space');
    await page.waitForFunction(()=>document.querySelector('video').currentTime>0.1,null,{polling:100});
    await page.locator('video').evaluate(video=>video.pause());});
  await check('history deletion preserves original and deliverables',async()=>{await appendFile(media,'changed source fixture');const changed=await page.evaluate(async id=>{try{await window.ttcut.openHistory(id);return '';}catch(error){return String(error);}},analysis.analysisId);assert.match(changed,/HISTORY_SOURCE_CHANGED/);await page.evaluate(id=>window.ttcut.deleteHistory(id),analysis.analysisId);assert.ok((await stat(media)).size>0);assert.ok((await stat(combined)).size>0);});
  await page.evaluate(()=>window.ttcut.confirmClose('exit')).catch(error=>{if(!String(error).includes('closed'))throw error;});
  await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>reject(new Error('App failed to quit')),10000).unref();});
  await writeFile(path.join(out,'latest-run.txt'),run+'\n');
  console.log(`Verification: ${run}`);
} catch(error) { await writeFile(path.join(run,'failure.txt'),error.stack+'\n'+stderr); if(page) await writeFile(path.join(run,'video-state.json'),JSON.stringify(await page.evaluate(()=>({visibility:document.visibilityState,videos:[...document.querySelectorAll('video')].map(v=>({src:v.src,paused:v.paused,time:v.currentTime,ready:v.readyState,network:v.networkState,error:v.error?.message}))})).catch(()=>null),null,2)); if(page) await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{}); throw error; }
finally { if(child.exitCode===null) child.kill('SIGTERM');await Promise.race([browser?.close().catch(()=>{}),new Promise(r=>setTimeout(r,1000))]);await writeFile(path.join(run,'electron.log'),stderr); }
