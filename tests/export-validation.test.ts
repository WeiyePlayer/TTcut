import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoMetadata } from '../src/shared/contracts';

const state = vi.hoisted(() => ({
  probeVideo: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
}));

vi.mock('../src/main/probe', () => ({
  probeAudioPacketBoundaries: vi.fn(),
  probeKeyframes: vi.fn(),
  probeStreamSignature: vi.fn(),
  probeVideo: state.probeVideo,
  sameStreamSignature: vi.fn(),
}));

import { validateExportOutput } from '../src/main/export';

const source: VideoMetadata = {
  path: 'source.mp4',
  duration_seconds: 2,
  width: 320,
  height: 240,
  fps: 60,
  nominal_fps: 60,
  variable_frame_rate: false,
  video_codec: 'h264',
  audio_codec: 'aac',
  container: 'mp4',
  frame_count: 120,
  average_bitrate: 1_000_000,
  audio_bitrate: 128_000,
  pixel_format: 'yuv420p',
  audio_sample_rate: 44_100,
  audio_channels: 2,
  video_duration_seconds: 2,
  audio_duration_seconds: 2,
  video_start_time_seconds: 0,
  audio_start_time_seconds: 0,
  video_time_base: '1/15360',
  audio_time_base: '1/44100',
  rotation: 0,
  sample_aspect_ratio: '1:1',
  display_aspect_ratio: '4:3',
  color_range: 'tv',
  color_space: 'bt709',
  color_transfer: 'bt709',
  color_primaries: 'bt709',
};

describe('export timestamp validation', () => {
  let directory: string;
  let output: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ttcut-export-validation-'));
    output = path.join(directory, 'output.mp4');
    await writeFile(output, Buffer.alloc(2048));
    state.probeVideo.mockReset();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('accepts an AAC-frame-sized start offset at 44.1 kHz', async () => {
    state.probeVideo.mockResolvedValue({
      ...source,
      path: output,
      video_start_time_seconds: 1024 / 44_100,
      audio_start_time_seconds: 0,
    });

    await expect(validateExportOutput(output, 2, source)).resolves.toBeDefined();
  });

  it('rejects an audio start timestamp beyond the frame-based tolerance', async () => {
    state.probeVideo.mockResolvedValue({
      ...source,
      path: output,
      video_start_time_seconds: 0,
      audio_start_time_seconds: -0.1,
    });

    await expect(validateExportOutput(output, 2, source)).rejects.toThrow('EXPORT_TIMESTAMP_INVALID');
  });
});
