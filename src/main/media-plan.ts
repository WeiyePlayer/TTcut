import type { CutGroup, VideoMetadata } from '../shared/contracts';

const TIME_EPSILON = 0.000_001;

export function expectedOutputDuration(groups: readonly CutGroup[]): number {
  return groups.reduce((sum, group) => sum + group.end - group.start, 0);
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

function normalizedSar(value: string | null | undefined): string {
  const match = /^(\d+):(\d+)$/.exec(value ?? '');
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return '1/1';
  return `${match[1]}/${match[2]}`;
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
      + `setpts=PTS-STARTPTS,setsar=sar=${sar}[vout]`,
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
        + `setpts=PTS-STARTPTS[v${index}]`,
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
): string[] {
  const hasAudio = metadata.audio_codec !== null;
  const filter = buildTrimFilter(groups, hasAudio, metadata.sample_aspect_ratio);
  const sourceVideoBitrate = metadata.average_bitrate ?? 8_000_000;
  // Re-encoding an already compressed H.264 source at the same nominal bitrate
  // compounded loss (SSIM 0.9337 on the real baseline). A 2x target was the
  // lowest tested value with a useful safety margin over the 0.95 release gate.
  const videoBitrate = Math.round(Math.max(
    sourceVideoBitrate,
    Math.min(sourceVideoBitrate * 2, 50_000_000),
  ));
  const audioBitrate = Math.round(metadata.audio_bitrate ?? 192_000);
  const args = [
    '-hide_banner', '-y', '-noautorotate', '-i', input,
    '-filter_complex', filter.filter, ...filter.maps,
    '-map_metadata', '0', '-sn', '-dn',
    '-c:v', 'libopenh264', '-profile:v', 'high', '-b:v', String(videoBitrate),
    '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-max_muxing_queue_size', '2048',
  ];
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', String(audioBitrate));
    if (metadata.audio_sample_rate) args.push('-ar', String(metadata.audio_sample_rate));
    if (metadata.audio_channels) args.push('-ac', String(metadata.audio_channels));
  }
  if (metadata.rotation !== null && metadata.rotation !== undefined) {
    args.push('-metadata:s:v:0', `rotate=${metadata.rotation}`);
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
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output);
  return args;
}
