// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NativeReplyReader } from '../src/main/macos/protocol';
const taskID = 'c3d03580-ce2e-4b35-88df-ae4c934e9e1f';
const event = (value: object) => JSON.stringify({ schemaVersion: 1, taskID, ...value });
describe('native subprocess protocol', () => {
  it('accepts split JSONL and a last line without newline only after a successful exit', () => {
    const progress: number[] = []; const reader = new NativeReplyReader(taskID, (e) => progress.push(e.current!));
    const lines = event({ type: 'progress', stage: 'analysis', current: 1, total: 2 }) + '\n' + event({ type: 'result', rallies: [], bounceTimes: [] });
    for (const part of [lines.slice(0, 17), lines.slice(17)]) reader.feed(part);
    expect(reader.finish(0, null).rallies).toEqual([]); expect(progress).toEqual([1]);
  });
  it.each([['wrong task', { taskID: 'a3d03580-ce2e-4b35-88df-ae4c934e9e1f', type: 'result' }], ['wrong version', { schemaVersion: 2, type: 'result' }], ['invalid progress', { type: 'progress', stage: 'analysis', current: 3, total: 2 }]])('rejects %s', (_name, value) => {
    expect(() => new NativeReplyReader(taskID).feed(event(value) + '\n')).toThrow();
  });
  it('rejects duplicate terminal events and truncated JSON', () => {
    const reader = new NativeReplyReader(taskID); reader.feed(event({ type: 'result' }) + '\n');
    expect(() => reader.feed(event({ type: 'result' }) + '\n')).toThrow('NATIVE_EVENT_AFTER_TERMINAL');
    const truncated = new NativeReplyReader(taskID); truncated.feed('{'); expect(() => truncated.finish(0, null)).toThrow();
  });
  it('rejects result followed by nonzero exit, missing result, and signal termination', () => {
    const reader = new NativeReplyReader(taskID); reader.feed(event({ type: 'result' }) + '\n');
    expect(() => reader.finish(1, null)).toThrow(); expect(() => reader.finish(null, 'SIGTERM')).toThrow();
    expect(() => new NativeReplyReader(taskID).finish(0, null)).toThrow();
  });
  it('preserves native error codes and bounds output memory', () => {
    const reader = new NativeReplyReader(taskID); reader.feed(event({ type: 'error', error: { code: 'DYNAMIC_HDR_UNSUPPORTED', message: 'Unsupported HDR' } }) + '\n');
    expect(() => reader.finish(1, null)).toThrow(expect.objectContaining({ code: 'DYNAMIC_HDR_UNSUPPORTED' }));
    expect(() => new NativeReplyReader(taskID).feed('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('NATIVE_OUTPUT_LIMIT');
  });
});
