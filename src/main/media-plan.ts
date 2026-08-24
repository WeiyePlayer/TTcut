import type { CutGroup, VideoMetadata } from '../shared/contracts';
import type { MediaEncoder } from './components';

const TIME_EPSILON = 0.000_001;

export function expectedOutputDuration(groups: readonly CutGroup[]): number {
  return groups.reduce((sum, group) => sum + group.end - group.start, 0);
}

export function selectSeekStart(segmentStart: number, keyframes: readonly number[]): number {
  let selected = 0;
  for (const keyframe of keyframes) {
    if (Number.isFinite(keyframe) && keyframe <= segmentStart + TIME_EPSILON && keyframe >= selected) {
      selected = keyframe;
    }
  }
  return selected;
}

function hasStableTimeBase(value: string | null | undefined): boolean {
  if (!value) return false;
  const [numerator, denominator] = value.split('/').map(Number);
  return Number.isSafeInteger(numerator)
    && Number.isSafeInteger(denominator)
    && (numerator ?? 0) > 0
    && (denominator ?? 0) > 0;
}

function boundaryAligned(boundary: number, candidates: readonly number[], tolerance: number): boolean {
  return candidates.some((candidate) => Math.abs(candidate - boundary) <= tolerance + TIME_EPSILON);
}

export function canUseStreamCopy(
  groups: readonly CutGroup[],
  keyframes: readonly number[],
  audioPacketBoundaries: readonly number[],
  metadata: VideoMetadata,
): boolean {
  if (groups.length !== 1 || metadata.variable_frame_rate || !hasStableTimeBase(metadata.video_time_base)) {
    return false;
  }
  const group = groups[0]!;
  const tolerance = 1 / metadata.fps;
  if (![group.start, group.end].every((boundary) => boundaryAligned(boundary, keyframes, tolerance))) {
    return false;
  }
  if (metadata.audio_codec !== null) {
    if (!hasStableTimeBase(metadata.audio_time_base) || audioPacketBoundaries.length === 0) return false;
    if (![group.start, group.end].every(
      (boundary) => boundaryAligned(boundary, audioPacketBoundaries, tolerance),
    )) return false;
  }
  return true;
}

export function buildStreamCopyArgs(input: string, output: string, group: CutGroup): string[] {
  return [
    '-hide_banner', '-y', '-noautorotate',
    '-ss', group.start.toFixed(6), '-to', group.end.toFixed(6), '-i', input,
    '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0',
    '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', output,
  ];
}

export function normalizedSar(value: string | null | undefined): string {
  const match = /^(\d+):(\d+)$/.exec(value ?? '');
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return '1/1';
  return `${match[1]}/${match[2]}`;
}

export function videoEncodingOptions(metadata: VideoMetadata, encoder: MediaEncoder): string[] {
  const sourceVideoBitrate = metadata.average_bitrate ?? 8_000_000;
  const videoBitrate = Math.round(Math.max(
    sourceVideoBitrate,
    Math.min(sourceVideoBitrate * 2, 50_000_000),
  ));
  return encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']
    : ['-c:v', 'libopenh264', '-profile:v', 'high', '-b:v', String(videoBitrate)];
}

export function outputPixelFormat(metadata: VideoMetadata, encoder: MediaEncoder): string {
  const x264PixelFormats = new Set([
    'yuv420p', 'yuvj420p', 'yuv422p', 'yuvj422p', 'yuv444p', 'yuvj444p',
    'nv12', 'nv16', 'nv21', 'yuv420p10le', 'yuv422p10le', 'yuv444p10le',
    'nv20le', 'gray', 'gray10le',
  ]);
  return encoder === 'libx264' && metadata.pixel_format && x264PixelFormats.has(metadata.pixel_format)
    ? metadata.pixel_format
    : 'yuv420p';
}

export function appendAudioEncodingOptions(args: string[], metadata: VideoMetadata): void {
  args.push('-c:a', 'aac', '-b:a', String(Math.round(metadata.audio_bitrate ?? 192_000)));
  if (metadata.audio_sample_rate) args.push('-ar', String(metadata.audio_sample_rate));
  if (metadata.audio_channels) args.push('-ac', String(metadata.audio_channels));
}

function appendMediaOutputOptions(
  args: string[],
  metadata: VideoMetadata,
  encoder: MediaEncoder,
  hasAudio: boolean,
): void {
  // Legacy history records predate exact frame-rate ratios and retain their old VFR export semantics.
  const hasExactFrameRate = Boolean(metadata.nominal_fps_ratio ?? metadata.average_fps_ratio);
  const outputIsCfr = !metadata.variable_frame_rate && hasExactFrameRate;
  args.push(
    '-map_metadata', '0', '-sn', '-dn',
    ...videoEncodingOptions(metadata, encoder),
    '-pix_fmt', outputPixelFormat(metadata, encoder),
    '-fps_mode', outputIsCfr ? 'cfr' : 'vfr',
    '-max_muxing_queue_size', '2048',
  );
  if (outputIsCfr) {
    args.push('-r', metadata.nominal_fps_ratio ?? metadata.average_fps_ratio ?? String(metadata.fps));
  }
  if (hasAudio) appendAudioEncodingOptions(args, metadata);
  args.push('-metadata:s:v:0', 'rotate=0');
  const colorOptions: Array<[string, string | null | undefined]> = [
    ['-color_range', metadata.color_range],
    ['-colorspace', metadata.color_space],
    ['-color_trc', metadata.color_transfer],
    ['-color_primaries', metadata.color_primaries],
  ];
  for (const [flag, value] of colorOptions) {
    if (value && value !== 'unknown') args.push(flag, value);
  }
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats');
}

export function buildTrimFilter(
  groups: readonly CutGroup[],
  hasAudio: boolean,
  sampleAspectRatio: string | null | undefined,
): { filter: string; maps: string[] } {
  const parts: string[] = [];
  const sar = normalizedSar(sampleAspectRatio);
  if (groups.length === 1) {
    const group = groups[0]!;
    parts.push(
      `[0:v:0]trim=start=${group.start.toFixed(6)}:end=${group.end.toFixed(6)},`
      + `setpts=PTS-STARTPTS:strip_fps=1,setsar=sar=${sar}[vout]`,
    );
    if (hasAudio) {
      parts.push(
        `[0:a:0]atrim=start=${group.start.toFixed(6)}:end=${group.end.toFixed(6)},`
        + 'asetpts=PTS-STARTPTS[aout]',
      );
    }
  } else {
    const videoSources = groups.map((_, index) => `[vsrc${index}]`).join('');
    parts.push(`[0:v:0]split=${groups.length}${videoSources}`);
    if (hasAudio) {
      const audioSources = groups.map((_, index) => `[asrc${index}]`).join('');
      parts.push(`[0:a:0]asplit=${groups.length}${audioSources}`);
    }
    groups.forEach((group, index) => {
      parts.push(
        `[vsrc${index}]trim=start=${group.start.toFixed(6)}:end=${group.end.toFixed(6)},`
        + `setpts=PTS-STARTPTS:strip_fps=1[v${index}]`,
      );
      if (hasAudio) {
        parts.push(
          `[asrc${index}]atrim=start=${group.start.toFixed(6)}:end=${group.end.toFixed(6)},`
          + `asetpts=PTS-STARTPTS[a${index}]`,
        );
      }
    });
    const inputs = groups.map(
      (_, index) => hasAudio ? `[v${index}][a${index}]` : `[v${index}]`,
    ).join('');
    if (hasAudio) {
      parts.push(`${inputs}concat=n=${groups.length}:v=1:a=1[vcat][aout]`);
    } else {
      parts.push(`${inputs}concat=n=${groups.length}:v=1:a=0[vcat]`);
    }
    parts.push(`[vcat]setsar=sar=${sar}[vout]`);
  }
  return {
    filter: parts.join(';'),
    maps: ['-map', '[vout]', ...(hasAudio ? ['-map', '[aout]'] : [])],
  };
}

export function buildReencodeArgs(
  input: string,
  output: string,
  groups: readonly CutGroup[],
  metadata: VideoMetadata,
  encoder: MediaEncoder = 'libopenh264',
): string[] {
  const hasAudio = metadata.audio_codec !== null;
  const filter = buildTrimFilter(groups, hasAudio, metadata.sample_aspect_ratio);
  const args = [
    '-hide_banner', '-y', '-autorotate', '-i', input,
    '-filter_complex', filter.filter, ...filter.maps,
  ];
  appendMediaOutputOptions(args, metadata, encoder, hasAudio);
  args.push(output);
  return args;
}

export function buildCfrNormalizationArgs(
  input: string,
  output: string,
  metadata: VideoMetadata,
  targetFpsRatio: string,
  encoder: MediaEncoder,
): string[] {
  const hasAudio = metadata.audio_codec !== null;
  const filters = [`fps=${targetFpsRatio}`, `setsar=${normalizedSar(metadata.sample_aspect_ratio)}`];
  const args = [
    '-hide_banner', '-y', '-autorotate', '-i', input,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', filters.join(','),
    '-map_metadata', '0', '-sn', '-dn',
    ...videoEncodingOptions(metadata, encoder),
    '-pix_fmt', outputPixelFormat(metadata, encoder),
    '-fps_mode:v', 'cfr',
    '-max_muxing_queue_size', '2048',
  ];
  if (hasAudio) {
    appendAudioEncodingOptions(args, metadata);
    args.push(
      '-af', `aresample=async=1:first_pts=0,apad=whole_dur=${metadata.duration_seconds.toFixed(6)}`,
      '-shortest',
    );
  }
  const colorOptions: Array<[string, string | null | undefined]> = [
    ['-color_range', metadata.color_range],
    ['-colorspace', metadata.color_space],
    ['-color_trc', metadata.color_transfer],
    ['-color_primaries', metadata.color_primaries],
  ];
  for (const [flag, value] of colorOptions) {
    if (value && value !== 'unknown') args.push(flag, value);
  }
  args.push(
    '-metadata:s:v:0', 'rotate=0',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', output,
  );
  return args;
}

export function buildSegmentReencodeArgs(
  input: string,
  output: string,
  group: CutGroup,
  seekStart: number,
  metadata: VideoMetadata,
  encoder: MediaEncoder = 'libopenh264',
): string[] {
  const safeSeekStart = Math.max(0, Math.min(seekStart, group.start));
  const relativeStart = group.start - safeSeekStart;
  const relativeEnd = group.end - safeSeekStart;
  const relativeGroup: CutGroup = {
    ...group,
    start: relativeStart,
    end: relativeEnd,
  };
  const hasAudio = metadata.audio_codec !== null;
  const filter = buildTrimFilter([relativeGroup], hasAudio, metadata.sample_aspect_ratio);
  const args = [
    '-hide_banner', '-y', '-autorotate',
    '-ss', safeSeekStart.toFixed(6),
    '-t', relativeEnd.toFixed(6),
    '-i', input,
    '-filter_complex', filter.filter, ...filter.maps,
  ];
  appendMediaOutputOptions(args, metadata, encoder, hasAudio);
  // Independently encoded MP4 segments need decode timestamps that remain ordered at concat boundaries.
  if (encoder === 'libx264') args.push('-bf', '0');
  args.push(output);
  return args;
}

function escapeConcatPath(value: string): string {
  return value.replaceAll('\\', '/').replaceAll("'", "'\\''");
}

export function buildConcatManifest(
  relativePaths: readonly string[],
  durationsSeconds?: readonly number[],
  durationGuardSeconds = 0,
): string {
  if (durationsSeconds && durationsSeconds.length !== relativePaths.length) {
    throw new Error('CONCAT_DURATION_COUNT_MISMATCH');
  }
  if (!Number.isFinite(durationGuardSeconds) || durationGuardSeconds < 0) {
    throw new Error('CONCAT_DURATION_GUARD_INVALID');
  }
  return `ffconcat version 1.0\n${relativePaths
    .flatMap((relativePath, index) => [
      `file '${escapeConcatPath(relativePath)}'`,
      ...(durationsSeconds
        ? [`duration ${(durationsSeconds[index]! + durationGuardSeconds).toFixed(6)}`]
        : []),
    ])
    .join('\n')}\n`;
}

export function buildConcatArgs(
  manifest: string,
  output: string,
  metadata: VideoMetadata,
): string[] {
  const args = [
    '-hide_banner', '-y',
    '-f', 'concat', '-safe', '1', '-i', manifest,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'copy',
  ];
  if (metadata.audio_codec !== null) {
    appendAudioEncodingOptions(args, metadata);
    args.push('-af', 'aresample=async=1:first_pts=0,apad', '-shortest');
  }
  args.push(
    // MP4 represents AAC priming with an edit list. make_zero would shift the copied video
    // forward by the encoder delay; auto keeps both public stream start times at zero.
    '-avoid_negative_ts', 'auto',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', output,
  );
  return args;
}
