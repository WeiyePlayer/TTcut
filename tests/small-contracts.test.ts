import { describe, expect, it } from 'vitest';
import { analysisResultSchema, hasBounceCounts, smallAnalysisRequestSchema } from '../src/shared/contracts';
import { createCutGroups, selectRallies } from '../src/domain/segments';
import { createCustomClipDraft, customExportSegments } from '../src/domain/custom-clips';
import { smallResult } from './fixtures/small-result';

describe('Small result and editing contracts', () => {
  it('keeps media fps separate from the sample grid, without invented board counts', () => {
    const result = analysisResultSchema.parse(smallResult());
    expect(result.video.fps).toBe(59.94);
    expect(hasBounceCounts(result)).toBe(false);
    expect(result).not.toHaveProperty('calibration');
    expect(result.rallies[0]).not.toHaveProperty('bounce_count');
    expect(smallResult().small_model.sampling_fps).toBe(30);
  });

  it('accepts 12 fps with explicit transferred calibration and still reads old 30 fps history', () => {
    const old = smallResult();
    const result = { ...old, small_model: { ...old.small_model, sampling_fps: 12,
      base_config_sha256: old.small_model.config_sha256, calibration_training_fps: 30,
      calibration_status: 'transferred_30fps_without_refit', decoder_fps: 12 } };
    expect(analysisResultSchema.safeParse(result).success).toBe(true);
    expect(analysisResultSchema.safeParse({ ...result, small_model: { ...old.small_model, sampling_fps: 12 } }).success).toBe(false);
    expect(analysisResultSchema.safeParse(old).success).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])('records real %i fps experiments with matching decoder provenance', fps => {
    const old = smallResult();
    const result = { ...old, small_model: { ...old.small_model, sampling_fps: fps,
      base_config_sha256: old.small_model.config_sha256, calibration_training_fps: 30,
      calibration_status: 'transferred_30fps_without_refit', decoder_fps: fps } };
    expect(analysisResultSchema.safeParse(result).success).toBe(true);
    expect(analysisResultSchema.safeParse({ ...result, small_model: { ...result.small_model, decoder_fps: 12 } }).success).toBe(false);
  });

  it('accepts adjacent and zero rounds; rejects overlaps and out-of-media boundaries', () => {
    const result = smallResult();
    result.rallies[1]!.start_time_seconds = result.rallies[0]!.end_time_seconds;
    expect(analysisResultSchema.safeParse(result).success).toBe(true);
    result.rallies[1]!.start_time_seconds -= 0.1;
    expect(analysisResultSchema.safeParse(result).success).toBe(false);
    expect(analysisResultSchema.safeParse({ ...smallResult(), rallies: [] }).success).toBe(true);
    const outside = smallResult();
    outside.rallies[2]!.end_time_seconds = 39;
    expect(analysisResultSchema.safeParse(outside).success).toBe(false);
  });

  it('accepts the refitted 6 fps candidate and rejects mismatched fit provenance', () => {
    const old = smallResult();
    const native = { ...old, small_model: { ...old.small_model, sampling_fps: 6,
      base_config_sha256: old.small_model.config_sha256, calibration_training_fps: 6,
      checkpoint_calibration_status: 'refitted_for_pinned_finetuned_checkpoint',
      calibration_status: 'refitted_6fps', decoder_fps: 6 } };
    expect(analysisResultSchema.safeParse(native).success).toBe(true);
    for (const changes of [{ calibration_training_fps: 30 }, { decoder_fps: 12 },
      { checkpoint_calibration_status: undefined }, { sampling_fps: 12 },
      { base_config_sha256: 'f'.repeat(64) }]) {
      expect(analysisResultSchema.safeParse({ ...native, small_model: { ...native.small_model, ...changes } }).success).toBe(false);
    }
    for (const fps of [12, 30]) {
      const transferred = { ...native, small_model: { ...native.small_model, sampling_fps: fps,
        calibration_status: 'transferred_6fps_without_refit', decoder_fps: fps === 30 ? 6 : fps } };
      expect(analysisResultSchema.safeParse(transferred).success).toBe(true);
    }
  });

  it.each([['short_rally', 2.7], ['rally', 4], ['long_rally', 4.8]] as const)(
    'uses strict full-rally duration for %s', (tier, threshold) => {
      const result = smallResult();
      result.rallies = [
        { ...result.rallies[0]!, start_time_seconds: 0, end_time_seconds: threshold,
          phases: [{ ...result.rallies[0]!.phases[1]!, start_sec: 0, end_sec: threshold }] },
        { ...result.rallies[1]!, start_time_seconds: 10, end_time_seconds: 10 + threshold + 0.01,
          phases: [{ ...result.rallies[1]!.phases[1]!, start_sec: 10, end_sec: 10 + threshold + 0.01 }] },
      ];
      const selected = selectRallies(result, { mode: 'highlight', criterion: { kind: 'duration_tier', tier },
        pre_roll_seconds: 2.5, post_roll_seconds: 1 });
      expect(selected.map(r => r.id)).toEqual(['rally_002']);
      expect(() => selectRallies(result, { mode: 'highlight', criterion: { kind: 'bounce_count', threshold: 3 },
        pre_roll_seconds: 2.5, post_roll_seconds: 1 })).toThrow('INVALID_HIGHLIGHT_CRITERION');
    },
  );

  it('supports automatic and custom export selections without calibration', () => {
    const result = smallResult();
    const groups = createCutGroups(result, { mode: 'all', pre_roll_seconds: 2.5, post_roll_seconds: 1 });
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every(g => g.start >= 0 && g.end <= 38)).toBe(true);
    const clips = createCustomClipDraft(result.rallies, 2.5, 1, 38, 59.94, 'mobilenet_small');
    expect(clips.every(c => c.bounceCount === null)).toBe(true);
    expect(customExportSegments(clips)).toHaveLength(3);
  });

  it('requires a no-calibration Small request', () => {
    const request = { schema_version: 6, task_id: '11111111-1111-4111-8111-111111111111',
      video_path: 'C:/video/small.mp4', video_metadata: smallResult().video, device: 'auto' };
    expect(smallAnalysisRequestSchema.safeParse(request).success).toBe(true);
    expect(smallAnalysisRequestSchema.parse(request).sampling_fps).toBe(6);
    expect(smallAnalysisRequestSchema.safeParse({ ...request, calibration_choice: { method: 'automatic' } }).success).toBe(false);
    expect(smallAnalysisRequestSchema.safeParse({ ...request, device: 'directml' }).success).toBe(false);
  });
});
