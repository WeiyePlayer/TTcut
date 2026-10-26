import type { VideoMetadata } from '../shared/contracts';

export type MediaFidelity = NonNullable<VideoMetadata['media_fidelity']>;

/** Old histories can infer depth and static transfer, but must be reprobed for side data. */
export function mediaFidelity(video: VideoMetadata): MediaFidelity {
  if (video.media_fidelity) return video.media_fidelity;
  const native = video.native_video;
  const pixel = video.pixel_format ?? 'yuv420p';
  const depth = /(?:p|gray|gbrp)(9|10|12|14|16)(?:le|be)?$/.exec(pixel)?.[1]
    ?? (/p0(10|12|16)/.exec(pixel)?.[1]);
  return {
    hdr: native?.hdr ?? (video.color_transfer === 'smpte2084' ? 'hdr10'
      : video.color_transfer === 'arib-std-b67' ? 'hlg' : 'sdr'),
    bit_depth: native?.bitDepth ?? (depth ? Number(depth) : 8),
    chroma: native?.chroma ?? (pixel.includes('444') ? '444' : pixel.includes('422') || pixel === 'nv16' || pixel.startsWith('nv20') ? '422' : '420'),
    mastering_display: native?.masteringDisplay ?? null,
    max_cll: native?.maxCLL ?? null,
    ...(native?.dolbyVision ? { dolby_vision: { profile: native.dolbyVision.profile,
      base_layer_present: native.dolbyVision.baseLayerPresent, signal_compatibility_id: native.dolbyVision.signalCompatibilityID } } : {}),
  };
}

export function assertMediaFidelity(video: VideoMetadata): MediaFidelity {
  const fidelity = mediaFidelity(video);
  if (fidelity.hdr === 'dolbyVision' || fidelity.hdr === 'hdr10Plus') throw new Error('DYNAMIC_HDR_UNSUPPORTED');
  if (![8, 10].includes(fidelity.bit_depth)) throw new Error('BIT_DEPTH_UNSUPPORTED');
  if (!['420', '422', '444'].includes(fidelity.chroma)) throw new Error('CHROMA_UNSUPPORTED');
  return fidelity;
}

export function outputVideoCodec(video: VideoMetadata): 'hevc' | 'h264' {
  return mediaFidelity(video).hdr !== 'sdr' || video.video_codec === 'hevc' ? 'hevc' : 'h264';
}

export function fidelityMismatch(source: VideoMetadata, output: VideoMetadata): string | null {
  const expected = mediaFidelity(source);
  const actual = mediaFidelity(output);
  if (actual.bit_depth !== expected.bit_depth) return 'EXPORT_BIT_DEPTH_MISMATCH';
  if (actual.chroma !== expected.chroma) return 'EXPORT_CHROMA_MISMATCH';
  if (actual.hdr !== expected.hdr) return 'EXPORT_HDR_MISMATCH';
  if (expected.mastering_display && expected.mastering_display !== actual.mastering_display
    || expected.max_cll && expected.max_cll !== actual.max_cll) return 'EXPORT_HDR_METADATA_LOST';
  return null;
}
