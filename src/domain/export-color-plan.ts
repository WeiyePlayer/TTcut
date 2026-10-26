import type { VideoMetadata } from '../shared/contracts';
import { assertMediaFidelity, mediaFidelity } from './media-fidelity';

export type ExportColorPlan = {
  source: VideoMetadata;
  target: VideoMetadata;
  toneMapTransfer: 'smpte2084' | 'arib-std-b67' | null;
};

/** Video export may convert a compatible base layer; preservation/analysis policy stays strict. */
export function exportColorPlan(source: VideoMetadata): ExportColorPlan {
  const fidelity = mediaFidelity(source);
  if (fidelity.hdr !== 'dolbyVision' && fidelity.hdr !== 'hdr10Plus') {
    assertMediaFidelity(source);
    return { source, target: source, toneMapTransfer: null };
  }
  let transfer: ExportColorPlan['toneMapTransfer'] = null;
  if (fidelity.hdr === 'hdr10Plus' && source.color_transfer === 'smpte2084') transfer = 'smpte2084';
  const dv = fidelity.dolby_vision;
  if (fidelity.hdr === 'dolbyVision' && dv?.profile === 8 && dv.base_layer_present) {
    if (dv.signal_compatibility_id === 1) transfer = 'smpte2084';
    if (dv.signal_compatibility_id === 4) transfer = 'arib-std-b67';
  }
  if (!transfer) throw new Error('DYNAMIC_HDR_UNSUPPORTED');
  // The base layer still has to satisfy the supported decoder precision/chroma contract.
  assertMediaFidelity({ ...source, media_fidelity: { ...fidelity, hdr: 'sdr' } });
  const target: VideoMetadata = {
    ...source, video_codec: 'h264', pixel_format: 'yuv420p', native_video: undefined,
    color_range: 'tv', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709',
    media_fidelity: { hdr: 'sdr', bit_depth: 8, chroma: '420', mastering_display: null, max_cll: null },
  };
  return { source, target, toneMapTransfer: transfer };
}

export function exportToneMapFilters(plan: ExportColorPlan): string[] {
  if (!plan.toneMapTransfer) return [];
  const range = ['pc', 'full', 'jpeg'].includes(plan.source.color_range ?? '') ? 'full' : 'limited';
  return [
    `zscale=pin=bt2020:tin=${plan.toneMapTransfer}:min=bt2020nc:rin=${range}:t=linear:npl=100`,
    'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=2',
    'zscale=t=bt709:m=bt709:r=limited', 'format=yuv420p',
    ...['MASTERING_DISPLAY_METADATA', 'CONTENT_LIGHT_LEVEL', 'DYNAMIC_HDR_PLUS', 'DOVI_RPU_BUFFER', 'DOVI_METADATA']
      .map((type) => `sidedata=mode=delete:type=${type}`),
  ];
}
