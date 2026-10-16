// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResultV1 } from '../src/shared/contracts';
const state = vi.hoisted(() => ({ run: vi.fn(), frames: [] as Record<string, unknown>[], streamSideData: [] as Record<string, unknown>[] }));
vi.mock('../src/main/processes', () => ({ runProcess: state.run }));
vi.mock('../src/main/components', () => ({ resolveUsableMediaComponents: async () => ({ ffprobe: 'ffprobe', ffmpeg: 'ffmpeg', mediaEncoder: 'libx264' }) }));
vi.mock('../src/main/macos/client', () => ({ probeMacVideo: vi.fn() }));
import { probeVideo } from '../src/main/probe';
import { exportSourceVideo } from '../src/main/export-source';
import { assertMediaFidelity } from '../src/domain/media-fidelity';

const platform = process.platform;
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
afterAll(() => Object.defineProperty(process, 'platform', { value: platform }));
beforeEach(() => {
  state.frames = []; state.streamSideData = [];
  state.run.mockReset().mockImplementation(async (_executable, args: string[]) => ({ code: 0, stderr: '', stdout: JSON.stringify(
    args.includes('-show_streams') ? { format: { duration: '100' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 3840, height: 2160, avg_frame_rate: '60000/1001', r_frame_rate: '60000/1001', nb_frames: '5994', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67', side_data_list: state.streamSideData }] }
      : args.includes('-show_packets') ? { packets: [{ duration_time: '0.016683' }, { duration_time: '0.016683' }, { duration_time: '0.016683' }] }
        : { frames: state.frames },
  ) }));
});

describe('Windows HDR probing and historical exports', () => {
  it('records HDR10+ metadata carried only by frames while keeping analysis allowed', async () => {
    state.frames = [{ side_data_list: [{ side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' }] }];
    const video = await probeVideo('source.mp4');
    expect(video.media_fidelity).toMatchObject({ hdr: 'hdr10Plus', bit_depth: 10, chroma: '420' });
    expect(() => assertMediaFidelity(video)).toThrow('DYNAMIC_HDR_UNSUPPORTED');
    expect(state.run).toHaveBeenCalledWith('ffprobe', expect.arrayContaining(['-read_intervals', '0.000000%+#8,25.000000%+#8,50.000000%+#8,75.000000%+#8,95.000000%+#8']), { timeoutMs: 60000 });
  });
  it('recognizes Dolby Vision configuration from the stream header', async () => {
    state.streamSideData = [{ side_data_type: 'DOVI configuration record' }];
    expect((await probeVideo('source.mp4')).media_fidelity?.hdr).toBe('dolbyVision');
  });
  it('does not silently treat a failed HDR side-data probe as SDR', async () => {
    state.run.mockImplementationOnce(() => Promise.reject(new Error('probe failed')));
    await expect(probeVideo('source.mp4')).rejects.toThrow('probe failed');
  });
  it('reprobes the original rather than a legacy CFR copy before exporting old history', async () => {
    const record = { video: { path: 'legacy-cfr.mp4' }, source_video: { path: 'original.mov' } } as AnalysisResultV1;
    const video = await exportSourceVideo(record);
    expect(video.path.endsWith('original.mov')).toBe(true);
    expect(state.run.mock.calls.every(([, args]) => args.at(-1) === 'original.mov')).toBe(true);
    expect(record.video.path).toBe('legacy-cfr.mp4');
  });
});
