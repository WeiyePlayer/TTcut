// @vitest-environment node
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {} }));
import { fromNativeVideo } from '../src/main/macos/client';
import silent from './fixtures/native-silent-hdr.json';
it('maps a real native silent HDR probe without inventing audio channels', () => {
  const value = fromNativeVideo(silent);
  expect(value.audio_codec).toBeNull(); expect(value.audio_channels).toBeNull();
  expect(value.native_video?.bitDepth).toBe(10); expect(value.color_transfer).toBe('smpte2084');
  expect(value.native_video?.hdr).toBe('hdr10'); expect(value.path).toBe(silent.path);
});
it('rejects malformed native timing and preserves source rotation and SAR', () => {
  expect(() => fromNativeVideo({ ...silent, fps: 0 })).toThrow();
  const value = fromNativeVideo({ ...silent, rotation: 90, sar: '4:3' });
  expect(value.rotation).toBe(90); expect(value.sample_aspect_ratio).toBe('4:3');
});
