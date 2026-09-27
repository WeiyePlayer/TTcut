import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/main/processes', () => ({ runProcess: mocks.run }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => ({ ffprobe: 'ffprobe' }) }));
import { probeVideo } from '../src/main/probe';
beforeEach(() => {
  mocks.run.mockReset().mockImplementation(async (_file, args: string[]) => ({ stdout: JSON.stringify(args.includes('-count_frames') ? { streams: [{ nb_read_frames: '108000' }] } : args.includes('-show_packets') ? { packets: [{ duration_time: '.033' }, { duration_time: '.034' }, { duration_time: '.070' }] } : { format: { duration: '3600' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '30/1', r_frame_rate: '30/1' }] }), stderr: '', code: 0 }));
});
it('opens metadata without decoding the entire file when container frame count is absent, retaining bounded VFR sampling', async () => {
  const metadata = await probeVideo('long.mov', undefined, 'interactive');
  expect(metadata.frame_count).toBeNull(); expect(metadata.variable_frame_rate).toBe(true);
  expect(mocks.run.mock.calls.some(([, args]) => args.includes('-count_frames'))).toBe(false);
});
it('preserves complete frame counting for analysis and export callers', async () => {
  expect((await probeVideo('long.mov')).frame_count).toBe(108000);
  expect(mocks.run.mock.calls.some(([, args]) => args.includes('-count_frames'))).toBe(true);
});
