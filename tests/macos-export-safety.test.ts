// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
const state=vi.hoisted(()=>({root:'',record:{} as any,fault:'',render:vi.fn()}));
vi.mock('electron',()=>({app:{},dialog:{}}));
vi.mock('../src/main/logger',()=>({logLine:vi.fn()}));
vi.mock('../src/main/history',()=>({getHistoryStore:()=>({open:async()=>state.record})}));
vi.mock('../src/main/components',()=>({resolveUsableMediaComponents:async()=>({ffmpeg:'bundled',ffprobe:'bundled',mediaEncoder:'libx264'})}));
vi.mock('../src/main/macos/client',()=>({renderMacMedia:state.render}));
vi.mock('node:fs/promises',async(importOriginal)=>{
  const real=await importOriginal<typeof import('node:fs/promises')>();
  return {...real,statfs:async()=>({bavail:state.fault==='space'?0n:999999999n,bsize:4096n}),open:async(...args:Parameters<typeof real.open>)=>{
    if(state.fault==='write'&&String(args[0]).endsWith('.write-test'))throw Object.assign(new Error('fixture EACCES'),{code:'EACCES'});
    return real.open(...args);
  }};
});
import { startExport } from '../src/main/export';
import { hasActiveTasks } from '../src/main/processes';
const id='11111111-1111-4111-8111-111111111111';
beforeEach(async()=>{
  state.root=await mkdtemp(path.join(tmpdir(),'ttcut-export-safety-'));state.render.mockClear();
  const source=path.join(state.root,'source.mp4');await writeFile(source,'source fixture');await writeFile(path.join(state.root,'finished.mp4'),'completed export');
  state.record={id,analysis:{schema_version:1,video:{path:source,width:320,height:180,duration_seconds:3,fps:30,variable_frame_rate:false,video_codec:'h264',audio_codec:null,container:'mp4'},rallies:[{id:'rally_001',index:1,start_time_seconds:1,end_time_seconds:2,bounce_count:4}]}};
});
afterEach(async()=>{await rm(state.root,{recursive:true,force:true});});
describe.skipIf(process.platform!=='darwin')('Mac export filesystem failures',()=>{
  it.each([['space','DISK_SPACE_LOW'],['write','OUTPUT_DIRECTORY_UNWRITABLE']])('preserves source and completed output when %s fails',async(fault,code)=>{
    state.fault=fault;
    await expect(startExport({isDestroyed:()=>false,webContents:{send:vi.fn()}} as unknown as BrowserWindow,{analysis_id:id,destination:'source',selection:{mode:'all',pre_roll_seconds:1.5,post_roll_seconds:0.5}})).rejects.toThrow(code);
    expect(state.render).not.toHaveBeenCalled();expect(hasActiveTasks()).toBe(false);
    expect(await readFile(path.join(state.root,'source.mp4'),'utf8')).toBe('source fixture');expect(await readFile(path.join(state.root,'finished.mp4'),'utf8')).toBe('completed export');expect((await readdir(state.root)).sort()).toEqual(['finished.mp4','source.mp4']);
  });
});
