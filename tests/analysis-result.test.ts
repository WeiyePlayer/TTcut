import { describe, expect, it } from 'vitest';
import { reconcileAnalysisVideoMetadata } from '../src/domain/analysis-result';
import provenance from './fixtures/hybrid-provenance.json';
import { hybridAnalysisResultV3Schema, type VideoMetadata } from '../src/shared/contracts';

const metadata = (duration: number, path = 'D:/source.mp4'): VideoMetadata => ({
  path,
  duration_seconds: duration,
  width: 1440,
  height: 808,
  fps: 30,
  variable_frame_rate: false,
  video_codec: 'hevc',
  audio_codec: null,
  container: 'mp4',
});

describe('analysis result media reconciliation', () => {
  it('does not shorten the already validated Worker timeline', () => {
    const reconciled = reconcileAnalysisVideoMetadata(
      metadata(125.2, 'worker-cache.mp4'),
      metadata(124.733, 'D:/source.mp4'),
    );

    expect(reconciled.path).toBe('D:/source.mp4');
    expect(reconciled.duration_seconds).toBe(125.2);
  });

  it('keeps a longer probed duration', () => {
    expect(reconcileAnalysisVideoMetadata(
      metadata(125.2),
      metadata(125.248),
    ).duration_seconds).toBe(125.248);
  });

  it('keeps a valid terminal exclusion when FFprobe reports fewer source frames', () => {
    const workerVideo = metadata(125.2, 'worker-cache.mp4');
    const result = hybridAnalysisResultV3Schema.parse({
      schema_version: 3,
      video: reconcileAnalysisVideoMetadata(workerVideo, metadata(124.733)),
      rallies: [{
        id: 'rally_001', index: 1, start_time_seconds: 1, end_time_seconds: 2, bounce_count: 1,
      }],
      bounce_times_seconds: [1.5],
      excluded_fragments: [{
        start_time_seconds: 124.9,
        end_time_seconds: 125.2,
        evidence: [{ reason: 'zero_bounce_rally', bounce_count: 0 }],
      }],
      rally_recognition: provenance,
    });

    expect(result.video.duration_seconds).toBe(125.2);
    expect(result.excluded_fragments[0]?.end_time_seconds).toBe(125.2);
  });
});
