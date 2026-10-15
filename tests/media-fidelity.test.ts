import { describe, expect, it } from 'vitest';
import policy from './fixtures/export-fidelity-policy.json';
import { assertMediaFidelity, fidelityMismatch, mediaFidelity, outputVideoCodec, type MediaFidelity } from '../src/domain/media-fidelity';
import { buildCfrNormalizationArgs, buildConcatArgs, buildReencodeArgs, buildSegmentReencodeArgs, canUseStreamCopy, selectMediaEncoder } from '../src/main/media-plan';
import { assertBatchFidelity, batchOutputProfile, buildBatchSegmentArgs } from '../src/main/batch-media-plan';
import { hdrSampleIntervals, probeMediaFidelity } from '../src/main/media-fidelity-probe';
import type { CutGroup, VideoMetadata } from '../src/shared/contracts';

const base: VideoMetadata = { path: 'source.mp4', duration_seconds: 2, width: 320, height: 180,
  fps: 60, nominal_fps_ratio: '60/1', variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4', pixel_format: 'yuv420p' };
const group: CutGroup = { start: 0, end: 1, rawStart: 0, rawEnd: 1, rallyIds: ['rally_001'] };

describe('shared macOS and Windows fidelity policy', () => {
  it.each(policy)('$name', (test) => {
    const video: VideoMetadata = { ...base, video_codec: test.codec,
      pixel_format: `yuv${test.chroma}p${test.depth > 8 ? `${test.depth}le` : ''}`,
      media_fidelity: { hdr: test.hdr as MediaFidelity['hdr'], bit_depth: test.depth, chroma: test.chroma, mastering_display: null, max_cll: null } };
    if (test.error) {
      expect(() => buildReencodeArgs(video.path, 'output.mp4', [group], video)).toThrow(test.error);
      expect(() => buildSegmentReencodeArgs(video.path, 'output.mp4', group, 0, video)).toThrow(test.error);
      expect(() => buildCfrNormalizationArgs(video.path, 'output.mp4', video, '60/1', 'libx264')).toThrow(test.error);
      expect(() => canUseStreamCopy([group], [0, 1], [], video)).toThrow(test.error);
      expect(() => buildConcatArgs('list.txt', 'out.mp4', video)).toThrow(test.error);
      return;
    }
    const args = buildReencodeArgs(video.path, 'output.mp4', [group], video);
    expect(selectMediaEncoder(video)).toBe(test.encoder);
    expect(args[args.indexOf('-c:v') + 1]).toBe(test.encoder);
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe(video.pixel_format);
    expect(outputVideoCodec(video)).toBe(test.encoder === 'libx265' ? 'hevc' : 'h264');
    if (test.encoder === 'libx265') expect(args).toContain('hvc1');
  });

  it('does not let copy optimization bypass an HDR codec conversion', () => {
    const video = { ...base, color_transfer: 'arib-std-b67', video_time_base: '1/90000' };
    expect(canUseStreamCopy([group], [0, 1], [], video)).toBe(false);
  });

  it('recognizes depth in legacy histories and rejects silent downgrades', () => {
    expect(mediaFidelity({ ...base, pixel_format: 'yuv420p10le' }).bit_depth).toBe(10);
    expect(() => assertMediaFidelity({ ...base, pixel_format: 'yuv420p12le' })).toThrow('BIT_DEPTH_UNSUPPORTED');
    expect(fidelityMismatch({ ...base, pixel_format: 'yuv422p10le' }, base)).toBe('EXPORT_BIT_DEPTH_MISMATCH');
  });

  it('samples bounded windows and converts frame static HDR metadata without dropping dynamic HDR', () => {
    expect(hdrSampleIntervals(100)).toBe('0.000000%+#8,25.000000%+#8,50.000000%+#8,75.000000%+#8,95.000000%+#8');
    const result = probeMediaFidelity({ pixel_format: 'yuv420p10le', color_transfer: 'smpte2084' }, '10', [
      { side_data_type: 'Mastering display metadata', green_x: '13250/50000', green_y: '34500/50000', blue_x: '7500/50000', blue_y: '3000/50000', red_x: '34000/50000', red_y: '16000/50000', white_point_x: '15635/50000', white_point_y: '16450/50000', max_luminance: '10000000/10000', min_luminance: '50/10000' },
      { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 },
      { side_data_type: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' },
    ]);
    expect(result).toMatchObject({ hdr: 'hdr10Plus', bit_depth: 10, mastering_display: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)', max_cll: '1000,400' });
    expect(() => assertMediaFidelity({ ...base, media_fidelity: result })).toThrow('DYNAMIC_HDR_UNSUPPORTED');
  });

  it('preserves static HDR and rejects incompatible mixed batch inputs', () => {
    const video = { ...base, video_codec: 'hevc', pixel_format: 'yuv420p10le', color_transfer: 'arib-std-b67', color_primaries: 'bt2020', color_space: 'bt2020nc', color_range: 'tv' };
    const output = batchOutputProfile(video, false);
    const args = buildBatchSegmentArgs(video, output, group, 'out.mp4', 'libx264');
    expect(args).toContain('libx265'); expect(args).toContain('yuv420p10le');
    expect(args).toContain('arib-std-b67');
    expect(() => assertBatchFidelity(base, output)).toThrow('BATCH_EXPORT_FIDELITY_MISMATCH');
    const hdr10 = { ...video, media_fidelity: { hdr: 'hdr10' as const, bit_depth: 10, chroma: '420', mastering_display: 'G(1,2)B(3,4)R(5,6)WP(7,8)L(100,1)', max_cll: '1000,400' } };
    const encoded = buildReencodeArgs(hdr10.path, 'out.mp4', [group], hdr10);
    expect(encoded[encoded.indexOf('-x265-params') + 1]).toContain('max-cll=1000,400');
    expect(encoded[encoded.indexOf('-x265-params') + 1]).toContain('master-display=G(1,2)');
  });
});
