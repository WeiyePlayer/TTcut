// Smoke the shipped executable and original history workflow in an isolated profile.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
const executable=path.resolve(process.argv[2]);const recordFile=path.resolve(process.argv[3]);
const run=await mkdtemp(path.resolve('output/playwright/packaged-native-'));
const profile=path.join(run,'profile');const record=JSON.parse(await readFile(recordFile,'utf8'));
await mkdir(path.join(profile,'history/records'),{recursive:true});
record.custom_editor_draft.scoreboard={enabled:true,x:.1,y:.1,scale:1,left_name:'A',right_name:'B'};
record.custom_editor_draft.playbackMode='source';
record.custom_editor_draft.clips=record.custom_editor_draft.clips.map((c,i)=>{const {score,winner,...clip}=c;return {...clip,selected:i<2};});
await writeFile(path.join(profile,'history/records',record.id+'.json'),JSON.stringify(record));
await writeFile(path.join(profile,'history/index.json'),JSON.stringify({schema_version:1,entries:[{id:record.id,analyzed_at:record.analyzed_at}]}));
await writeFile(path.join(profile,'settings.json'),JSON.stringify({language:'en',calibration_method:'automatic',pre_roll_seconds:2.5,post_roll_seconds:1,normalize_variable_frame_rate:false}));
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const child=spawn(executable,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`],{windowsHide:false,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
let browser,page,passed=false;const report={executable,profile,source:record.source.path,checks:[]};
try{
  await expect.poll(async()=>{if(child.exitCode!==null)throw new Error(stderr);return fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.ok).catch(()=>false);},{timeout:30000}).toBe(true);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(20000);
  await page.getByRole('button',{name:'History',exact:true}).click();await page.locator('.history-open').click();
  await page.getByRole('button',{name:/Custom.*Choose individual/}).click();
  const surface=page.locator('[data-native-preview]');await expect.poll(()=>surface.getAttribute('data-ready')).toBe('true');


  const saved=async()=>JSON.parse(await readFile(path.join(profile,'history/records',record.id+'.json'),'utf8')).custom_editor_draft;
  const input=(action,x,y,options={})=>JSON.parse(execFileSync('C:/Program Files/PowerShell/7/pwsh.exe',['-NoLogo','-NoProfile','-File',path.resolve('scripts/scoreboard-native-physical-input.ps1'),'-ProcessId',String(child.pid),'-Action',action,'-X',String(x),'-Y',String(y),...Object.entries(options).flatMap(([k,v])=>v===true?['-'+k]:['-'+k,String(v)])],{windowsHide:true,encoding:'utf8'}));
  const boardPoint=async(rx,ry)=>{const b=(await saved()).scoreboard,box=await surface.boundingBox(),aspect=record.analysis.video.width/record.analysis.video.height;const vw=Math.min(box.width,box.height*aspect),vh=vw/aspect;return {x:((box.width-vw)/2+vw*(b.x+.28*b.scale*rx))/box.width,y:((box.height-vh)/2+vh*b.y+vw*.28*b.scale/5.2*ry)/box.height};};
  const physical=async(action,rx,ry,opts={})=>{const p=await boardPoint(rx,ry);return input(action,p.x,p.y,opts)};
  await page.locator('.custom-rally-table tbody tr').first().click();
  await expect.poll(()=>surface.getAttribute('data-paused')).toBe('false');
  await page.keyboard.press('Space');await expect.poll(()=>surface.getAttribute('data-paused')).toBe('true');
  const fields=[['left_name',.3,.25,'林昀儒 LIN'],['right_name',.3,.75,'王楚钦 WANG'],['left_games',.82,.25,'2'],['right_games',.82,.75,'1'],['left',.94,.25,'07'],['right',.94,.75,'3']];
  for(const [field,rx,ry,value] of fields){
    const shot=path.join(run,field+'-typing.png');
    const typed=await physical('liveEdit',rx,ry,{Value:value,Shot:shot});
    expect(typed.focusClass).toBe('Edit');
    expect(typed.focusText).toBe(field.endsWith('_name')?value:String(Number(value)));
    expect(typed.gui.Caret.value).toBe(typed.gui.Focus.value);
    expect(typed.gui.CaretRect.Bottom-typed.gui.CaretRect.Top).toBeGreaterThan(0);
    // An ordinary GDI edit HWND can have text/caret yet be invisible under mpv.
    // Verify its white editing background exists in the actual desktop pixels.
    expect(typed.whiteFraction).toBeGreaterThan(.25);
    const expected=field.endsWith('_name')?value:Number(value);
    await expect.poll(async()=>field.endsWith('_name')?(await saved()).scoreboard[field]:(await saved()).clips[0].score?.[field]).toBe(expected);
    report.checks.push({name:'visible live inline editing',field,value:expected,whitePixels:typed.whitePixels,caret:typed.gui.CaretRect});
  }
  await physical('double',.94,.25);await delay(200);
  const cleared=await physical('key',.94,.25,{KeepFocus:true,Delta:8});expect(cleared.focusText).toBe('0');
  const replaced=await physical('type',.94,.25,{KeepFocus:true,Value:'5'});expect(replaced.focusText).toBe('5');
  await physical('key',.94,.25,{KeepFocus:true,Delta:13});await expect.poll(async()=>(await saved()).clips[0].score?.left).toBe(5);
  await physical('double',.94,.25);await delay(200);
  await physical('type',.94,.25,{KeepFocus:true,Value:'9'});await physical('key',.94,.25,{KeepFocus:true,Delta:27});
  expect((await saved()).clips[0].score.left).toBe(5);
  report.checks.push({name:'numeric delete, replacement, leading zero normalization and Escape cancellation'});
  for(const [field,rx,ry,expected] of [['left_games',.82,.25,3],['right_games',.82,.75,2],['left',.94,.25,6],['right',.94,.75,4]]){
    await physical('wheel',rx,ry);await expect.poll(async()=>(await saved()).clips[0].score?.[field]).toBe(expected);
  }
  await expect(surface).toHaveAttribute('data-paused','true');
  report.checks.push({name:'wheel adjustment for all four scores remains available without toggling playback'});
  passed=true;
}catch(error){report.error=String(error.stack);console.error(error);}
await writeFile(path.join(run,'report.json'),JSON.stringify({passed,...report},null,2));
console.log(JSON.stringify({passed,run,checks:report.checks,error:report.error}));
if(page&&!page.isClosed())await page.evaluate(()=>window.ttcut.confirmClose('exit')).catch(()=>undefined);
await Promise.race([once(child,'exit'),delay(6000)]);if(child.exitCode===null){child.kill();passed=false;}await browser?.close().catch(()=>undefined);
if(!passed)process.exitCode=1;

