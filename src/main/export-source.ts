import type { AnalysisResultV1, VideoMetadata } from '../shared/contracts';
import { probeVideo } from './probe';
import { fidelityMismatch, mediaFidelity } from '../domain/media-fidelity';

/** An existing cache is usable for export only if its current contents still match its recorded properties. */
export async function usableExportCfr(analysis: AnalysisResultV1, signal?: AbortSignal): Promise<VideoMetadata | null> {
  const expected = analysis.video;
  if (analysis.processing?.mode !== 'normalized_cfr' || !(expected.media_fidelity || expected.native_video)) return null;
  try {
    const actual = await probeVideo(expected.path, signal, 'interactive');
    const recordedFidelity = mediaFidelity(expected);
    const actualFidelity = mediaFidelity(actual);
    const ratio = analysis.processing.target_fps_ratio?.split('/').map(Number);
    const targetFps = ratio && ratio[1] ? ratio[0]! / ratio[1] : expected.fps;
    if (actual.variable_frame_rate || actual.width !== expected.width || actual.height !== expected.height
      || Math.abs(actual.duration_seconds - expected.duration_seconds) > 0.1
      || !Number.isFinite(targetFps) || targetFps <= 0 || Math.abs(actual.fps - targetFps) / targetFps > 0.001
      || actual.video_codec !== expected.video_codec || (actual.audio_codec !== null) !== (expected.audio_codec !== null)
      || (expected.audio_codec && actual.audio_codec !== expected.audio_codec)
      || (expected.audio_channels && actual.audio_channels !== expected.audio_channels)
      || (expected.audio_sample_rate && actual.audio_sample_rate !== expected.audio_sample_rate)
      || (actual.video_duration_seconds != null && actual.audio_duration_seconds != null
        && Math.abs(actual.video_duration_seconds - actual.audio_duration_seconds) > 0.1)
      || (actual.video_start_time_seconds != null && actual.audio_start_time_seconds != null
        && Math.abs(actual.video_start_time_seconds - actual.audio_start_time_seconds) > 0.1)
      || recordedFidelity.mastering_display !== actualFidelity.mastering_display
      || recordedFidelity.max_cll !== actualFidelity.max_cll
      || recordedFidelity.dolby_vision?.profile !== actualFidelity.dolby_vision?.profile
      || recordedFidelity.dolby_vision?.base_layer_present !== actualFidelity.dolby_vision?.base_layer_present
      || recordedFidelity.dolby_vision?.signal_compatibility_id !== actualFidelity.dolby_vision?.signal_compatibility_id
      || fidelityMismatch(expected, actual)) return null;
    for (const field of ['color_range', 'color_space', 'color_transfer', 'color_primaries'] as const) {
      const value = expected[field];
      if (value && value !== 'unknown' && value !== 'N/A' && value !== actual[field]) return null;
    }
    return actual;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

export async function exportSourceVideo(analysis: AnalysisResultV1, signal?: AbortSignal): Promise<VideoMetadata> {
  let video = analysis.video;
  if (analysis.processing?.mode === 'normalized_cfr') {
    const cached = await usableExportCfr(analysis, signal);
    if (cached) video = cached;
    else if (analysis.source_video) video = analysis.source_video;
    else throw new Error('HISTORY_PROCESSING_MEDIA_CORRUPT');
  }
  // Reprobe old Windows histories: they did not record frame HDR side data. Old CFR
  // copies may already have lost it, so render those histories from the original.
  const fidelity = mediaFidelity(video);
  const dynamicCompatibilityMissing = fidelity.hdr === 'dolbyVision' && !fidelity.dolby_vision;
  if ((process.platform === 'win32' && !video.media_fidelity) || dynamicCompatibilityMissing) {
    video = await probeVideo(analysis.source_video?.path ?? video.path, signal);
  }
  return video;
}
