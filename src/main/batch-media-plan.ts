import type { CutGroup, VideoMetadata } from '../shared/contracts';
import type { MediaEncoder } from './components';
import { videoEncodingOptions } from './media-plan';

function validRate(value: string | null | undefined): boolean {
  if (!value || !/^\d+\/\d+$/.test(value)) return false;
  const [numerator, denominator] = value.split('/').map(Number);
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator)
    && numerator! > 0 && denominator! > 0;
}

/** One output specification for every segment, including silent source videos. */
export function batchOutputProfile(first: VideoMetadata, hasAudio: boolean): VideoMetadata {
  if (!Number.isFinite(first.fps) || first.fps <= 0) throw new Error('EXPORT_FRAME_RATE_INVALID');
  // Native macOS metadata exposes nominal FPS as a number, without a ratio.
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
    video_codec: 'h264', pixel_format: 'yuv420p',
    audio_codec: hasAudio ? 'aac' : null,
    audio_sample_rate: hasAudio ? 48_000 : null,
    audio_channels: hasAudio ? 2 : null,
    audio_bitrate: hasAudio ? 192_000 : null,
    rotation: 0, sample_aspect_ratio: '1:1',
    color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', color_range: 'tv',
    video_time_base: null, audio_time_base: null,
  };
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
  // Supply defaults only for unspecified color metadata. Known source colors are converted,
  // rather than merely relabelled as the common output color space.
  const colorDefaults = [
    ['ispace', input.color_space], ['iprimaries', input.color_primaries], ['itrc', input.color_transfer],
  ].filter(([, value]) => !value || value === 'unknown' || value === 'unspecified')
    .map(([key]) => `${key}=bt709`);
  const videoFilters = [
    'setpts=PTS-STARTPTS',
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`,
    `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `colorspace=all=bt709:range=tv:format=yuv420p${colorDefaults.length ? `:${colorDefaults.join(':')}` : ''}`,
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
    ...videoEncodingOptions(output, encoder), '-pix_fmt', 'yuv420p',
    '-fps_mode:v', 'cfr', '-r', output.nominal_fps_ratio!, '-video_track_timescale', String(trackTimescale),
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709',
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0', '-sn', '-dn',
    '-t', duration.toFixed(9), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
  );
  if (encoder === 'libx264') args.push('-bf', '0');
  args.push(destination);
  return args;
}
