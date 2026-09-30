import { smallAnalysisResultSchema } from '../../src/shared/contracts';
import source from './small-source-test1.json';

/** Source-project output on deliberately non-30-fps media metadata. */
export function smallResult(path = 'C:/video/small.mp4') {
  return smallAnalysisResultSchema.parse({
    schema_version: 4,
    video: { path, duration_seconds: 38, width: 1920, height: 1080, fps: 59.94,
      frame_count: 2278, variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4' },
    rally_recognition: { method: 'mobilenet_small', version: 4 },
    small_model: {
      checkpoint_sha256: source.source.checkpoint_sha256,
      config_sha256: '11e11a30e88e2717d97929a0cf5fd8f5817b16c36b966893893b32ac951346cd',
      decoder_id: source.decoder_id, preprocessing: source.source.preprocessing,
      engine: 'pytorch', device: 'cpu', sampling_fps: 30, sampling_frame_count: source.frame_count,
    },
    segments: source.segments,
    rallies: source.rallies.map((r, i) => ({
      id: `rally_${String(i + 1).padStart(3, '0')}`, index: i + 1,
      start_time_seconds: r.start_sec, end_time_seconds: r.end_sec,
      phases: r.phases, kind: r.kind, has_serve: r.has_serve, has_play: r.has_play,
      touches_video_start: r.touches_video_start, touches_video_end: r.touches_video_end,
    })),
  });
}
