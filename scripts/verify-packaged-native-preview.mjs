// Smoke the shipped executable and original history workflow in an isolated profile.
import { spawn } from 'node:child_process';
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
await copyFile(recordFile,path.join(profile,'history/records',record.id+'.json'));
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
  report.checks.push({name:'packaged original media first frame',state:await surface.evaluate(e=>({...e.dataset}))});
  await page.locator('.custom-rally-table tbody tr').first().click();const before=Number(await surface.getAttribute('data-time'));
  await expect.poll(async()=>Number(await surface.getAttribute('data-time'))).toBeGreaterThan(before+.3);
  await page.keyboard.press('Space');await expect.poll(()=>surface.getAttribute('data-paused')).toBe('true');
  report.checks.push({name:'packaged playback advances and pauses',state:await surface.evaluate(e=>({...e.dataset}))});
  await page.locator('.workflow-back').click();await expect(surface).toHaveCount(0);
  await page.getByRole('button',{name:/Custom.*Choose individual/}).click();await expect.poll(()=>surface.getAttribute('data-ready')).toBe('true');
  report.checks.push({name:'leave and reopen custom editor',state:await surface.evaluate(e=>({...e.dataset}))});
  const ruler=page.locator('.timeline-ruler');const box=await ruler.boundingBox();
  await page.mouse.click(box.x+box.width*.4,box.y+box.height/2);
  const playhead=page.locator('.timeline-playhead');
  const target=Number(await playhead.getAttribute('aria-valuenow'));
  await expect.poll(async()=>Math.abs(Number(await surface.getAttribute('data-time'))-target)<.06&&await surface.getAttribute('data-seeking')==='false').toBe(true);
  report.checks.push({name:'timeline click after reopening',state:await surface.evaluate(e=>({...e.dataset}))});
  const handle=await playhead.boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+8);await page.mouse.down();
  await page.mouse.move(box.x+box.width*.6,handle.y+8,{steps:12});await page.mouse.up();
  const releasedTarget=Number(await playhead.getAttribute('aria-valuenow'));
  await expect.poll(async()=>Math.abs(Number(await surface.getAttribute('data-time'))-releasedTarget)<.06&&await surface.getAttribute('data-seeking')==='false').toBe(true);
  report.checks.push({name:'scrub release resolves accurately and remains paused',target:releasedTarget,state:await surface.evaluate(e=>({...e.dataset}))});
  await page.screenshot({path:path.join(run,'ui.png')});passed=true;
}catch(error){report.error=String(error);console.error(error);if(page)console.error((await page.locator('body').innerText()).slice(-4000));}
await writeFile(path.join(run,'report.json'),JSON.stringify({passed,...report},null,2));console.log(JSON.stringify({passed,...report}));console.log('Evidence:',run);
if(process.argv.includes('--hold')){process.stdin.setEncoding('utf8');await new Promise(resolve=>process.stdin.once('data',resolve));process.stdin.pause();}
if(page&&!page.isClosed())await page.evaluate(()=>window.ttcut.confirmClose('exit')).catch(()=>undefined);
await Promise.race([once(child,'exit'),delay(6000)]);
if(child.exitCode===null){report.forcedShutdown=true;child.kill();passed=false;}
await browser?.close().catch(()=>undefined);
await writeFile(path.join(run,'report.json'),JSON.stringify({passed,...report},null,2));
if(!passed)process.exitCode=1;
