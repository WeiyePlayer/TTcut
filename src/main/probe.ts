import { probeMacVideo } from './macos/client';
import path from 'node:path';
import { displayVideoDimensions, videoContainerFromFileName } from '../domain/video-input';
import { videoMetadataSchema, type VideoMetadata } from '../shared/contracts';
import { resolveUsableMediaComponents } from './components';
import { runProcess } from './processes';

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  level?: number;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  bit_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  start_time?: string;
  time_base?: string;
  extradata_hash?: string;
  channel_layout?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
};

type ProbeData = {
  format?: {
    duration?: string;
    start_time?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams?: ProbeStream[];
};

function rational(value?: string): number {
  if (!value) return 0;
  const parts = value.split('/').map(Number);
  const first = parts[0];
  const second = parts[1];
  if (!Number.isFinite(first) || !Number.isFinite(second) || !second) return 0;
  return (first ?? 0) / second;
}

function rationalRatio(value?: string): string | null {
  if (!value || !/^\d+\/\d+$/.test(value)) return null;
  const [numeratorText, denominatorText] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator <= 0 || denominator <= 0) return null;
  return `${numerator}/${denominator}`;
}

function optionalInteger(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function optionalNumber(value?: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson<T>(value: string, errorCode = 'VIDEO_UNREADABLE'): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(errorCode);
  }
}

async function countFrames(ffprobe: string, videoPath: string, signal?: AbortSignal): Promise<number | null> {
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'json', videoPath,
  ], signal ? { signal } : {});
  const data = parseJson<{ streams?: ProbeStream[] }>(result.stdout);
  return optionalInteger(data.streams?.[0]?.nb_read_frames);
}

async function sampledVfr(ffprobe: string, videoPath: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+60',
    '-show_packets', '-show_entries', 'packet=duration_time', '-of', 'json', videoPath,
  ], signal ? { timeoutMs: 60_000, signal } : { timeoutMs: 60_000 });
  const data = parseJson<{ packets?: Array<{ duration_time?: string }> }>(result.stdout);
  const durations = (data.packets ?? [])
    .map((packet) => Number(packet.duration_time))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (durations.length < 3) return false;
  const median = durations[Math.floor(durations.length / 2)]!;
  const tolerance = Math.max(0.000_5, median * 0.05);
  return durations.some((duration) => Math.abs(duration - median) > tolerance);
}

export async function probeVideo(videoPath: string, signal?: AbortSignal): Promise<VideoMetadata> {
  if (process.platform === 'darwin') return probeMacVideo(videoPath, signal);
  const container = videoContainerFromFileName(videoPath);
  if (!container) throw new Error('INVALID_INPUT');
  const components = await resolveUsableMediaComponents();
  if (!components.ffprobe) throw new Error('MEDIA_COMPONENT_MISSING');
  const result = await runProcess(components.ffprobe, [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', videoPath,
  ], signal ? { timeoutMs: 30_000, signal } : { timeoutMs: 30_000 });
  const data = parseJson<ProbeData>(result.stdout);
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  const averageFps = rational(video?.avg_frame_rate);
  const nominalFps = rational(video?.r_frame_rate);
  if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0 || averageFps <= 0) {
    throw new Error('VIDEO_UNREADABLE');
  }
  let frameCount = optionalInteger(video.nb_frames);
  if (frameCount === null) frameCount = await countFrames(components.ffprobe, videoPath, signal);
  const fieldRatesDiffer = nominalFps > 0 && Math.abs(nominalFps - averageFps) / averageFps > 0.001;
  let packetDurationsDiffer = false;
  try {
    packetDurationsDiffer = await sampledVfr(components.ffprobe, videoPath, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    // The rate fields remain the conservative fallback when packet sampling is unavailable.
  }
  const rotation = video.side_data_list?.find((item) => Number.isFinite(item.rotation))?.rotation
    ?? (video.tags?.rotate ? Number(video.tags.rotate) : null);
  const displayDimensions = displayVideoDimensions(video.width, video.height, rotation);
  return videoMetadataSchema.parse({
    path: path.resolve(videoPath),
    duration_seconds: duration,
    width: displayDimensions.width,
    height: displayDimensions.height,
    fps: averageFps,
    nominal_fps: nominalFps > 0 ? nominalFps : null,
    average_fps_ratio: rationalRatio(video.avg_frame_rate),
    nominal_fps_ratio: rationalRatio(video.r_frame_rate),
    variable_frame_rate: fieldRatesDiffer || packetDurationsDiffer,
    video_codec: video.codec_name ?? 'unknown',
    audio_codec: audio?.codec_name ?? null,
    container,
    frame_count: frameCount,
    average_bitrate: optionalInteger(video.bit_rate ?? data.format?.bit_rate),
    audio_bitrate: optionalInteger(audio?.bit_rate),
    pixel_format: video.pix_fmt ?? null,
    audio_sample_rate: optionalInteger(audio?.sample_rate),
    audio_channels: audio?.channels ?? null,
    video_duration_seconds: optionalNumber(video.duration),
    audio_duration_seconds: optionalNumber(audio?.duration),
    video_start_time_seconds: optionalNumber(video.start_time),
    audio_start_time_seconds: optionalNumber(audio?.start_time),
    video_time_base: video.time_base ?? null,
    audio_time_base: audio?.time_base ?? null,
    rotation: Number.isFinite(rotation) ? rotation : null,
    sample_aspect_ratio: video.sample_aspect_ratio ?? null,
    display_aspect_ratio: video.display_aspect_ratio ?? null,
    color_range: video.color_range ?? null,
    color_space: video.color_space ?? null,
    color_transfer: video.color_transfer ?? null,
    color_primaries: video.color_primaries ?? null,
  });
}

export async function probeKeyframes(
  videoPath: string,
  ffprobeOverride?: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const ffprobe = ffprobeOverride ?? (await resolveUsableMediaComponents()).ffprobe;
  if (!ffprobe) throw new Error('MEDIA_COMPONENT_MISSING');
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'json', videoPath,
  ], signal ? { signal } : {});
  const parsed = parseJson<{
    packets?: Array<{ pts_time?: string; flags?: string }>;
  }>(result.stdout);
  return (parsed.packets ?? [])
    .filter((packet) => packet.flags?.includes('K'))
    .map((packet) => Number(packet.pts_time))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
}

export async function probeAudioPacketBoundaries(
  videoPath: string,
  ffprobeOverride?: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const ffprobe = ffprobeOverride ?? (await resolveUsableMediaComponents()).ffprobe;
  if (!ffprobe) throw new Error('MEDIA_COMPONENT_MISSING');
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', videoPath,
  ], signal ? { signal } : {});
  const parsed = parseJson<{
    packets?: Array<{ pts_time?: string; duration_time?: string }>;
  }>(result.stdout);
  const boundaries = new Set<number>();
  for (const packet of parsed.packets ?? []) {
    const start = Number(packet.pts_time);
    const duration = Number(packet.duration_time);
    if (Number.isFinite(start) && start >= 0) boundaries.add(start);
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
      boundaries.add(start + duration);
    }
  }
  return [...boundaries].sort((a, b) => a - b);
}

export type StreamSignature = {
  video: {
    codec: string | null;
    profile: string | null;
    level: number | null;
    pixelFormat: string | null;
    width: number | null;
    height: number | null;
    timeBase: string | null;
    extradataHash: string | null;
  };
  audio: {
    codec: string | null;
    sampleRate: number | null;
    channels: number | null;
    channelLayout: string | null;
    timeBase: string | null;
  } | null;
};

export async function probeStreamSignature(
  videoPath: string,
  ffprobeOverride?: string,
  signal?: AbortSignal,
): Promise<StreamSignature> {
  const ffprobe = ffprobeOverride ?? (await resolveUsableMediaComponents()).ffprobe;
  if (!ffprobe) throw new Error('MEDIA_COMPONENT_MISSING');
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-show_streams', '-show_data_hash', 'sha256', '-of', 'json', videoPath,
  ], signal ? { timeoutMs: 30_000, signal } : { timeoutMs: 30_000 });
  const data = parseJson<ProbeData>(result.stdout);
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video) throw new Error('EXPORT_SEGMENT_FAILED');
  return {
    video: {
      codec: video.codec_name ?? null,
      profile: video.profile ?? null,
      level: Number.isFinite(video.level) ? video.level! : null,
      pixelFormat: video.pix_fmt ?? null,
      width: Number.isInteger(video.width) ? video.width! : null,
      height: Number.isInteger(video.height) ? video.height! : null,
      timeBase: video.time_base ?? null,
      extradataHash: video.extradata_hash ?? null,
    },
    audio: audio ? {
      codec: audio.codec_name ?? null,
      sampleRate: optionalInteger(audio.sample_rate),
      channels: Number.isInteger(audio.channels) ? audio.channels! : null,
      channelLayout: audio.channel_layout ?? null,
      timeBase: audio.time_base ?? null,
    } : null,
  };
}

export function sameStreamSignature(left: StreamSignature, right: StreamSignature): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
