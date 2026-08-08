import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  runProcess: vi.fn(),
}));

vi.mock('../src/main/processes', () => ({
  runProcess: state.runProcess,
}));

vi.mock('../src/main/components', () => ({
  resolveUsableMediaComponents: vi.fn(),
}));

import { probeKeyframes } from '../src/main/probe';

describe('keyframe probing', () => {
  beforeEach(() => {
    state.runProcess.mockReset();
  });

  it('returns sorted keyframe packet timestamps without a fixed timeout', async () => {
    state.runProcess.mockResolvedValue({
      stdout: JSON.stringify({
        packets: [
          { pts_time: '4.250000', flags: 'K__' },
          { pts_time: '1.500000', flags: '___' },
          { pts_time: '0.000000', flags: 'K__' },
          { pts_time: '-0.250000', flags: 'K__' },
          { pts_time: 'invalid', flags: 'K__' },
          { pts_time: '2.125000', flags: '__K' },
        ],
      }),
      stderr: '',
      code: 0,
    });

    await expect(probeKeyframes('source.mp4', 'ffprobe.exe')).resolves.toEqual([
      0,
      2.125,
      4.25,
    ]);
    expect(state.runProcess).toHaveBeenCalledWith('ffprobe.exe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_packets',
      '-show_entries', 'packet=pts_time,flags', '-of', 'json', 'source.mp4',
    ], {});
  });
});
