import path from 'node:path';
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root,'output/electron-macos'); await mkdir(output,{recursive:true});
const run = await mkdtemp(path.join(output,'ui-'));
const media = ['批处理 A.mp4','批处理 B.mp4'].map(name=>path.join(run,name));
for(const file of media) {
  const r=spawnSync(path.join(root,'.runtime/macos/bin/ffmpeg'),['-v','error','-f','lavfi','-i','color=c=black:size=320x180:rate=30:duration=10','-c:v','libx264','-preset','ultrafast',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
}
const instance = await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[root],env:{...process.env,TTCUT_E2E:'1',TTCUT_E2E_USER_DATA:path.join(run,'user-data'),TTCUT_E2E_VIDEOS:JSON.stringify(media),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});
const appProcess=instance.process();const page=await instance.firstWindow();const checks=[];const errors=[];page.on('pageerror',error=>errors.push(error.message));
async function check(name,work){await work();checks.push({name,passed:true});console.log(`PASS ${name}`);await writeFile(path.join(run,'report.json'),JSON.stringify({mode:'development dialog fixtures, real native workers',checks,errors},null,2));}
try {
  await page.waitForFunction(()=>Boolean(window.ttcut));await page.context().setOffline(true);
  await check('batch import and automatic calibration failure recovery',async()=>{
    await page.locator('.drop-zone').click();await expect(page.locator('.batch-row')).toHaveCount(2);
    await expect(page.getByText('手动标定',{exact:true})).toHaveCount(2,{timeout:180000});
    assert.equal(await page.getByText('完成本任务后关机',{exact:true}).count(),0);
    for(const name of media.map(p=>path.basename(p))) {
      await page.getByRole('button',{name:`${name} 手动标定`,exact:true}).click();
      const video=page.locator('.video-surface video');await expect(video).toBeVisible();
      const box=await video.boundingBox();const scale=Math.min(box.width/320,box.height/180);
      for(const [x,y] of [[60,40],[250,40],[275,145],[40,145]]) await page.mouse.click(box.x+(box.width-320*scale)/2+x*scale,box.y+(box.height-180*scale)/2+y*scale);
      await expect(page.getByRole('button',{name:'Calibration point 4',exact:true})).toBeVisible();
      await page.screenshot({path:path.join(run,`${name}-calibration.png`)});
      await page.getByRole('button',{name:'完成标定',exact:true}).click();
    }
    for(const row of await page.locator('.batch-row').all()) await row.locator('.batch-mode-options button').nth(2).click();
    await expect(page.locator('.batch-start')).toBeEnabled();
  });
  await check('batch cancellation, remaining queue and retry',async()=>{
    await page.locator('.batch-start').click();
    const active=page.locator('.batch-row.processing');await expect(active).toHaveCount(1,{timeout:30000});
    await active.locator('.batch-cover').click();
    await expect(page.locator('.batch-row.cancelled')).toHaveCount(1,{timeout:30000});
    await expect(page.locator('.batch-start')).toBeEnabled({timeout:180000});
    await page.locator('.batch-start').click();
    await page.evaluate(()=>{window.__retainedBatch=true;return window.ttcut.close();});
    await page.waitForFunction(async()=>!(await window.ttcut.bootstrap()).windowState.visible);
    await expect(page.locator('.batch-row.done')).toHaveCount(2,{timeout:180000});
    await instance.evaluate(({app})=>app.emit('activate'));
    await page.waitForFunction(async()=>(await window.ttcut.bootstrap()).windowState.visible);
    assert.equal(await page.evaluate(()=>window.__retainedBatch),true);
    const entries=await page.evaluate(()=>window.ttcut.listHistory());assert.equal(entries.length,2);assert.ok(entries.every(e=>e.rally_count===0));
    const dismiss=page.getByRole('button',{name:'拒绝',exact:true});if(await dismiss.isVisible())await dismiss.click();
    await page.screenshot({path:path.join(run,'batch-zh.png')});
  });
  await check('explicit menu quit confirms cancellation and waits for cleanup',async()=>{
    await page.evaluate(async videoPath=>window.ttcut.startAnalysis({videoPath,calibrationChoice:{method:'manual',calibration:{video_width:320,video_height:180,points:{top_left:[60,40],top_right:[250,40],bottom_right:[275,145],bottom_left:[40,145]}}},device:'auto',historyVisibility:'visible',analysisMode:'full',normalizeVariableFrameRate:false,blurballConfidenceThreshold:0.7,blurballStage1ConfidenceThreshold:0.3,blurballStage2ConfidenceThreshold:0.7}),media[0]);
    // This is the same app.quit path used by the native app menu and Cmd+Q.
    await instance.evaluate(({app})=>app.quit());
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await instance.evaluate(({app})=>app.quit());
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({path:path.join(run,'quit-confirm-zh.png')});
    const closed=instance.waitForEvent('close',{timeout:30000});
    await page.getByRole('dialog').getByRole('button',{name:'退出',exact:true}).click();await closed;
    for(const file of media) assert.ok((await stat(file)).size>0);
  });
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'latest-ui-run.txt'),run+'\n');console.log(`Verification: ${run}`);
} catch(error){await writeFile(path.join(run,'failure.txt'),String(error.stack));await page.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});throw error;}
finally {if(appProcess.exitCode===null){await page.evaluate(()=>window.ttcut.confirmClose('exit')).catch(()=>{});await instance.close();}}
