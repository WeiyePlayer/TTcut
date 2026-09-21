import type { VideoMetadata } from '../shared/contracts';

export function reconcileAnalysisVideoMetadata(
  workerVideo: VideoMetadata,
  processingVideo: VideoMetadata,
): VideoMetadata {
  return {
    ...processingVideo,
    // The Worker result has already been validated against the decoded media
    // duration. FFprobe can report a slightly shorter container duration for
    // damaged or timestamp-irregular HEVC files; shortening the envelope here
    // would make otherwise valid rallies or exclusions fail the second parse.
    duration_seconds: Math.max(
      processingVideo.duration_seconds,
      workerVideo.duration_seconds,
    ),
  };
}
