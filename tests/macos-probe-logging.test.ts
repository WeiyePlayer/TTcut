// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/native-silent-hdr.json';

const state = vi.hoisted(() => ({
  spawn: vi.fn(), log: vi.fn(), code: null as string | null,
  source: '', hdr: 'hdr10Plus',
}));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
vi.mock('../src/main/macos/runtime', () => ({ verifyMacRuntime: async () => {}, macRuntimeRoot: () => '/runtime' }));
vi.mock('../src/main/logger', () => ({ logLine: state.log }));
vi.mock('../src/main/processes', () => ({
  getTaskController: () => undefined, trackBackgroundProcess: () => {}, terminateChild: async () => {}, spawnTracked: vi.fn(),
}));
import { probeMacVideo } from '../src/main/macos/client';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-hdr-log-'));
  state.source = path.join(directory, 'source.mp4');
  await writeFile(state.source, 'probe fixture');
  state.code = null;
  state.hdr = 'hdr10Plus';
  state.log.mockReset().mockResolvedValue(undefined);
  state.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    });
    let input = '';
    child.stdin.on('data', (data) => { input += String(data); });
    child.stdin.on('finish', () => {
      const request = JSON.parse(input) as { taskID: string };
      child.stdout.write(JSON.stringify({
        schemaVersion: 1, taskID: request.taskID, type: state.code ? 'error' : 'result',
        ...(state.code ? { error: { code: state.code, message: 'Native probe error' } }
          : { video: { ...fixture, path: state.source, hdr: state.hdr } }),
      }) + '\n');
      child.emit('close', state.code ? 1 : 0, null);
    });
    return child;
  });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('macOS HDR probe diagnostics', () => {
  it('records the actual HDR kind without rejecting a dynamic HDR probe', async () => {
    const video = await probeMacVideo(state.source);
    expect(video.native_video?.hdr).toBe('hdr10Plus');
    expect(state.log).toHaveBeenCalledWith('app', 'INFO', expect.stringContaining('"hdr":"hdr10Plus"'));
    expect(state.log.mock.calls[0]![2]).toContain(JSON.stringify(state.source));
  });

  it('records native failures for a selected source and preserves the original error code', async () => {
    state.code = 'DYNAMIC_HDR_UNSUPPORTED';
    await expect(probeMacVideo(state.source)).rejects.toMatchObject({ code: 'DYNAMIC_HDR_UNSUPPORTED' });
    expect(state.log).toHaveBeenCalledWith('app', 'ERROR', expect.stringContaining('"code":"DYNAMIC_HDR_UNSUPPORTED"'));
  });

  it('keeps the native failure if logging is unavailable', async () => {
    state.code = 'NATIVE_MEDIA_ERROR';
    state.log.mockRejectedValue(new Error('EACCES'));
    await expect(probeMacVideo(state.source)).rejects.toMatchObject({ code: 'NATIVE_MEDIA_ERROR' });
  });

  it('does not report cancellation or an absent cache as a video error', async () => {
    state.code = 'PROCESS_CANCELLED';
    await expect(probeMacVideo(state.source)).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
    state.code = 'MEDIA_FAILED';
    await expect(probeMacVideo(path.join(directory, 'missing-cache.mp4'))).rejects.toMatchObject({ code: 'MEDIA_FAILED' });
    expect(state.log).not.toHaveBeenCalled();
  });
});
