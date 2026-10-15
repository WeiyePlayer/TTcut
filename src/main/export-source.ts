import type { AnalysisResultV1, VideoMetadata } from '../shared/contracts';
import { probeVideo } from './probe';

export async function exportSourceVideo(analysis: AnalysisResultV1, signal?: AbortSignal): Promise<VideoMetadata> {
  let video = analysis.video;
  // Reprobe old Windows histories: they did not record frame HDR side data. Old CFR
  // copies may already have lost it, so render those histories from the original.
  if (process.platform === 'win32' && !video.media_fidelity) {
    video = await probeVideo(analysis.source_video?.path ?? video.path, signal);
  }
  return video;
}
