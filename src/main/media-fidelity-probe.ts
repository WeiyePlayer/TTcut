import { mediaFidelity, type MediaFidelity } from '../domain/media-fidelity';
import type { VideoMetadata } from '../shared/contracts';

export type ProbeSideData = Record<string, unknown>;

export function hdrSampleIntervals(duration: number): string {
  return [0, 0.25, 0.5, 0.75, 0.95].map((position) => `${(duration * position).toFixed(6)}%+#8`).join(',');
}

export function probeMediaFidelity(
  video: Pick<VideoMetadata, 'pixel_format' | 'color_transfer'>,
  rawDepth: string | undefined,
  sides: readonly ProbeSideData[],
): MediaFidelity {
  const result = mediaFidelity(video as VideoMetadata);
  const depth = Number(rawDepth);
  if (Number.isSafeInteger(depth) && depth > 0) result.bit_depth = depth;
  for (const side of sides) {
    const type = String(side.side_data_type ?? '');
    if (/DOVI|Dolby Vision/.test(type)) result.hdr = 'dolbyVision';
    if (/HDR10\+|HDR Dynamic Metadata SMPTE2094-40/.test(type) && result.hdr !== 'dolbyVision') result.hdr = 'hdr10Plus';
    if (type.includes('Mastering display')) {
      const unit = (key: string, scale: number) => {
        const [n, d = 1] = String(side[key] ?? '0').split('/').map(Number);
        if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) throw new Error('VIDEO_HDR_METADATA_INVALID');
        return Math.round(n! / d * scale);
      };
      result.mastering_display = `G(${unit('green_x', 50000)},${unit('green_y', 50000)})`
        + `B(${unit('blue_x', 50000)},${unit('blue_y', 50000)})R(${unit('red_x', 50000)},${unit('red_y', 50000)})`
        + `WP(${unit('white_point_x', 50000)},${unit('white_point_y', 50000)})`
        + `L(${unit('max_luminance', 10000)},${unit('min_luminance', 10000)})`;
    }
    if (type.includes('Content light')) {
      const max = Number(side.max_content), average = Number(side.max_average);
      if (![max, average].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error('VIDEO_HDR_METADATA_INVALID');
      result.max_cll = `${max},${average}`;
    }
  }
  return result;
}
