import { describe, expect, it } from 'vitest';
import policy from './fixtures/export-color-policy.json';
import { exportColorPlan } from '../src/domain/export-color-plan';
import type { VideoMetadata } from '../src/shared/contracts';

describe('shared automatic Windows and macOS export color policy', () => {
  it.each(policy)('$name', (test) => {
    const dv = test.dolbyVision;
    const source: VideoMetadata = {
      path: 'source.mp4', width: 320, height: 180, duration_seconds: 2, fps: 24,
      variable_frame_rate: false, container: 'mp4', video_codec: test.codec, audio_codec: null,
      color_transfer: test.transfer,
      media_fidelity: { hdr: test.hdr as NonNullable<VideoMetadata['media_fidelity']>['hdr'],
        bit_depth: test.depth, chroma: '420', mastering_display: null, max_cll: null,
        ...(dv ? { dolby_vision: { profile: dv.profile, base_layer_present: dv.baseLayerPresent,
          signal_compatibility_id: dv.signalCompatibilityID } } : {}) },
    };
    if (test.error) {
      expect(() => exportColorPlan(source)).toThrow(test.error);
    } else {
      const plan = exportColorPlan(source);
      expect(plan.target.media_fidelity?.hdr).toBe(test.outputHDR);
      expect(plan.target.video_codec).toBe(test.outputCodec);
      expect(plan.target.media_fidelity?.bit_depth).toBe(test.outputDepth);
      expect(source.media_fidelity?.hdr).toBe(test.hdr);
    }
  });
});
