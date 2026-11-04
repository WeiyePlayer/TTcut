import type { VideoMetadata } from '../shared/contracts';

/** Compare video coverage, never a container duration extended by an audio tail. */
export function previewVideoDuration(video: VideoMetadata): number | null {
  if (video.video_duration_seconds && Number.isFinite(video.video_duration_seconds) && video.video_duration_seconds > 0) return video.video_duration_seconds;
  if (video.frame_count && video.frame_count > 0 && Number.isFinite(video.fps) && video.fps > 0) return video.frame_count / video.fps;
  return null;
}

// Keep in sync with MediaPreview.validate in the native renderer (including cache hits).
export function validatePreview(source: VideoMetadata, preview: VideoMetadata): void {
  if (preview.video_codec !== 'h264' || !['yuv420p', 'yuvj420p'].includes(preview.pixel_format ?? '')) {
    throw new Error('PREVIEW_VALIDATION_FAILED:FORMAT_UNSUPPORTED');
  }
  const expected = previewVideoDuration(source);
  const actual = previewVideoDuration(preview);
  if (expected !== null && actual !== null && expected - actual > Math.max(1, Math.min(5, expected * 0.005))) {
    throw new Error('PREVIEW_VALIDATION_FAILED:VIDEO_TRUNCATED');
  }
}
