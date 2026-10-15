import type { CutGroup, VideoMetadata } from '../shared/contracts';
import type { MediaEncoder } from './components';
import { buildColorSetParams, outputPixelFormat, selectMediaEncoder, videoEncodingOptions } from './media-plan';
import { assertMediaFidelity, mediaFidelity } from '../domain/media-fidelity';

function validRate(value: string | null | undefined): boolean {
  if (!value || !/^\d+\/\d+$/.test(value)) return false;
  const [numerator, denominator] = value.split('/').map(Number);
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
    && numerator! > 0 && denominator! > 0;
}

/** One output specification for every segment, including silent source videos. */
export function batchOutputProfile(first: VideoMetadata, hasAudio: boolean): VideoMetadata {
  const fidelity = assertMediaFidelity(first);
  if (!Number.isFinite(first.fps) || first.fps <= 0) throw new Error('EXPORT_FRAME_RATE_INVALID');
  // Older native macOS histories have only a numeric nominal frame rate.
  const nominal = first.nominal_fps;
  const average = validRate(first.average_fps_ratio) ? first.average_fps_ratio! : null;
  const averageRate = average ? Number(average.split('/')[0]) / Number(average.split('/')[1]) : 0;
  const fallbackRate = nominal && Number.isFinite(nominal) && nominal > 0 ? nominal : first.fps;
  const ratio = validRate(first.nominal_fps_ratio) ? first.nominal_fps_ratio!
    : average && Math.abs(averageRate - fallbackRate) < 0.001 ? average
      : `${Math.round(fallbackRate * 1_000_000)}/1000000`;
  const [numerator, denominator = 1] = ratio.split('/').map(Number);
  const fps = numerator! / denominator;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('EXPORT_FRAME_RATE_INVALID');
  return {
    ...first,
    width: Math.ceil(first.width / 2) * 2,
    height: Math.ceil(first.height / 2) * 2,
    fps, nominal_fps: fps, nominal_fps_ratio: ratio, average_fps_ratio: ratio,
    variable_frame_rate: false,
    video_codec: first.video_codec, pixel_format: outputPixelFormat(first, 'libx264'), media_fidelity: fidelity,
    audio_codec: hasAudio ? 'aac' : null,
    audio_sample_rate: hasAudio ? 48_000 : null,
    audio_channels: hasAudio ? 2 : null,
    audio_bitrate: hasAudio ? 192_000 : null,
    rotation: 0, sample_aspect_ratio: '1:1',
    color_space: first.color_space ?? (fidelity.hdr === 'sdr' ? 'bt709' : null),
    color_primaries: first.color_primaries ?? (fidelity.hdr === 'sdr' ? 'bt709' : null),
    color_transfer: first.color_transfer ?? (fidelity.hdr === 'sdr' ? 'bt709' : null),
    color_range: first.color_range ?? (fidelity.hdr === 'sdr' ? 'tv' : null),
    video_time_base: null, audio_time_base: null,
  };
}

export function assertBatchFidelity(input: VideoMetadata, output: VideoMetadata): void {
  const source = assertMediaFidelity(input);
  const target = mediaFidelity(output);
  if ((['hdr', 'bit_depth', 'chroma', 'mastering_display', 'max_cll'] as const).some((field) => source[field] !== target[field])
    || (['color_range', 'color_space', 'color_transfer', 'color_primaries'] as const).some((field) => {
      const value = input[field];
      return value && !['unknown', 'unspecified'].includes(value) && value !== output[field];
    })) throw new Error('BATCH_EXPORT_FIDELITY_MISMATCH');
}

export function batchSegmentDuration(group: CutGroup, output: VideoMetadata): number {
  return Math.max(1, Math.round((group.end - group.start) * output.fps)) / output.fps;
}

export function buildBatchSegmentArgs(
  input: VideoMetadata,
  output: VideoMetadata,
  group: CutGroup,
  destination: string,
  encoder: MediaEncoder,
): string[] {
  assertBatchFidelity(input, output);
  const duration = batchSegmentDuration(group, output);
  const rateNumerator = Number(output.nominal_fps_ratio!.split('/')[0]);
  const trackTimescale = rateNumerator * Math.max(1, Math.ceil(1000 / rateNumerator));
  const args = [
    '-hide_banner', '-y', '-autorotate', '-ss', group.start.toFixed(6),
    '-t', (group.end - group.start).toFixed(6), '-i', input.path,
  ];
  const hasAudio = output.audio_codec !== null;
  if (hasAudio && input.audio_codec === null) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  }
  const pixelFormat = outputPixelFormat(output, encoder);
  const colorParams = buildColorSetParams(output);
  const videoFilters = [
    'setpts=PTS-STARTPTS',
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`,
    `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `format=${pixelFormat}`,
    ...(colorParams ? [colorParams] : []),
    `fps=${output.nominal_fps_ratio}`,
    `tpad=stop_mode=clone:stop_duration=${(1 / output.fps).toFixed(9)}`,
    `trim=duration=${duration.toFixed(9)}`,
    'setpts=PTS-STARTPTS',
  ];
  const filters = [`[0:v:0]${videoFilters.join(',')}[vout]`];
  if (hasAudio) {
    filters.push(`[${input.audio_codec === null ? '1' : '0'}:a:0]asetpts=PTS-STARTPTS,`
      + `aresample=48000:async=1:first_pts=0,apad,atrim=duration=${duration.toFixed(9)}[aout]`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
  if (hasAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192000');
  args.push(
    ...videoEncodingOptions(output, encoder), '-pix_fmt', pixelFormat,
    '-fps_mode:v', 'cfr', '-r', output.nominal_fps_ratio!, '-video_track_timescale', String(trackTimescale),
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0', '-sn', '-dn',
    '-t', duration.toFixed(9), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
  );
  for (const [flag, value] of [['-color_range', output.color_range], ['-colorspace', output.color_space], ['-color_trc', output.color_transfer], ['-color_primaries', output.color_primaries]]) {
    if (value && value !== 'unknown') args.push(flag!, value);
  }
  if (selectMediaEncoder(output, encoder) !== 'libopenh264') args.push('-bf', '0');
  args.push(destination);
  return args;
}
