import { describe, expect, it } from 'vitest';
import {
  analysisResultSchema,
  continuousVisibilityAnalysisResultV3Schema,
  hasBounceCounts,
} from '../src/shared/contracts';
import { createCustomClipDraft } from '../src/domain/custom-clips';

const fixture = () => ({
  schema_version: 3,
  video: {
    path: '/Users/example/match.mp4', duration_seconds: 30, width: 1280, height: 720,
    fps: 30, variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4',
  },
  rallies: [
    { id: 'rally_001', index: 1, bounce_count: 2, start_time_seconds: 1, end_time_seconds: 4 },
    { id: 'rally_002', index: 2, bounce_count: 0, start_time_seconds: 8, end_time_seconds: 12 },
  ],
  bounce_times_seconds: [1.5, 3.5, 20],
  rally_recognition: {
    method: 'continuous_visibility', start_visible_seconds: 0.2, end_invisible_seconds: 0.5,
    board_count: {
      detector: 'blurball_trajectory_change', minimum_interval_seconds: 0.315,
      source_path: 'worker/ttcut_worker/blurball_bounce.py',
      source_sha256: 'e1e7674cd1209a6f4deffe5ff0e57633e2859605f031b1c012cb2d16c9f49ea8',
      landing_region: 'expanded_table', table_length_margin_cm: 35, table_width_margin_cm: 25,
    },
  },
});

describe('continuous-visibility board-count metadata', () => {
  it('validates the historical detector provenance independently of the current Windows source', () => {
    // The macOS port records its original source, not the evolving Windows file
    // (whose bytes also depend on checkout line endings).
    const result = fixture();
    expect(continuousVisibilityAnalysisResultV3Schema.safeParse(result).success).toBe(true);
    result.rally_recognition.board_count.source_sha256 = '0'.repeat(64);
    expect(continuousVisibilityAnalysisResultV3Schema.safeParse(result).success).toBe(false);
  });

  it('preserves visibility boundaries while exposing per-rally board counts', () => {
    const result = analysisResultSchema.parse(fixture());
    expect(hasBounceCounts(result)).toBe(true);
    expect(createCustomClipDraft(
      result.rallies, 0, 0, result.video.duration_seconds, result.video.fps,
      'continuous_visibility',
    ).map((clip) => clip.bounceCount)).toEqual([2, 0]);
  });

  it('rejects counts that do not match the ordered, source-bound bounce events', () => {
    const wrongCount = fixture();
    wrongCount.rallies[0]!.bounce_count = 1;
    expect(continuousVisibilityAnalysisResultV3Schema.safeParse(wrongCount).success).toBe(false);

    const unordered = fixture();
    unordered.bounce_times_seconds = [3.5, 1.5, 20];
    expect(continuousVisibilityAnalysisResultV3Schema.safeParse(unordered).success).toBe(false);

    const outOfSource = fixture();
    outOfSource.bounce_times_seconds = [1.5, 3.5, 31];
    expect(continuousVisibilityAnalysisResultV3Schema.safeParse(outOfSource).success).toBe(false);
  });
});
