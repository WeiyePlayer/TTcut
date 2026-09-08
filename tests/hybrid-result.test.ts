import { describe, expect, it } from 'vitest';
import provenance from './fixtures/hybrid-provenance.json';
import legacyProvenance from './fixtures/hybrid-provenance-v1.json';
import previousProvenance from './fixtures/hybrid-provenance-v2.json';
import { analysisResultSchema, hasBounceCounts, hybridAnalysisResultV3Schema } from '../src/shared/contracts';
import { buildCutGroups, selectRallies } from '../src/domain/segments';
import { calculateManualBounceCount } from '../src/domain/custom-clips';

const rally = (start: number, end: number, index = 1, count = 4) => ({
  id: `rally_${String(index).padStart(3, '0')}`, index, start_time_seconds: start, end_time_seconds: end, bounce_count: count,
});
const fixture = () => ({
  schema_version: 3, video: { path: 'match.mp4', duration_seconds: 30, width: 1280, height: 720,
    fps: 30, variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4' },
  rally_recognition: structuredClone(provenance), rallies: [rally(1, 5)], bounce_times_seconds: [1, 2, 3, 5],
  excluded_fragments: [{ start_time_seconds: 6, end_time_seconds: 8, evidence: [{
    reason: 'dead_bounce_cluster', bounce_times_seconds: [6, 7, 7.8], intervals: [1, .8],
    rebound_heights: [10, 8], departure_speeds: [null, null], matched_metrics: ['intervals', 'rebound_heights'],
  }] }],
});

describe('hybrid result and editing/export rules', () => {
  it('parses production provenance and exposes positive board counts', () => {
    const result = analysisResultSchema.parse(fixture());
    expect(hasBounceCounts(result)).toBe(true);
    expect(result.schema_version).toBe(3);
  });
  it('reads v1/v2 history unchanged and rejects mislabelled safeguard versions', () => {
    for (const rally_recognition of [legacyProvenance, previousProvenance]) {
      expect(analysisResultSchema.parse({ ...fixture(), rally_recognition })).toMatchObject({ rally_recognition });
    }
    for (const rally_recognition of [
      { ...provenance, version: 1 },
      { ...legacyProvenance, version: 2 },
      { ...previousProvenance, version: 3 },
      { ...provenance, candidate_refinement_version: 1 },
      { ...provenance, dead_bounce_filter: { ...provenance.dead_bounce_filter, reenergization_veto: false } },
    ]) {
      expect(analysisResultSchema.safeParse({ ...fixture(), rally_recognition }).success).toBe(false);
    }
  });
  it('rejects invalid counts, overlap, unordered events and out-of-source fragments', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.rallies[0]!.bounce_count = 0; },
      (f: ReturnType<typeof fixture>) => { f.rallies[0]!.bounce_count = 3; },
      (f: ReturnType<typeof fixture>) => { f.bounce_times_seconds.push(6); },
      (f: ReturnType<typeof fixture>) => { f.bounce_times_seconds.reverse(); },
      (f: ReturnType<typeof fixture>) => { f.excluded_fragments.push(f.excluded_fragments[0]!); },
      (f: ReturnType<typeof fixture>) => { f.excluded_fragments[0]!.end_time_seconds = 31; },
      (f: ReturnType<typeof fixture>) => { f.rallies[0]!.end_time_seconds = 7; },
    ]) { const value = fixture(); mutate(value); expect(hybridAnalysisResultV3Schema.safeParse(value).success).toBe(false); }
  });
  it('uses strict board thresholds and only valid events for manual extensions', () => {
    const result = hybridAnalysisResultV3Schema.parse(fixture());
    expect(selectRallies(result, { mode: 'highlight', criterion: { kind: 'bounce_count', threshold: 3 }, pre_roll_seconds: 2.5, post_roll_seconds: 1 })).toHaveLength(1);
    expect(() => selectRallies(result, { mode: 'highlight', criterion: { kind: 'bounce_count', threshold: 5 }, pre_roll_seconds: 2.5, post_roll_seconds: 1 })).toThrow('NO_HIGHLIGHTS');
    expect(calculateManualBounceCount(0, 9, result.bounce_times_seconds)).toBe(4);
  });
  it('merges only raw gaps strictly below three seconds without a fixed tail', () => {
    expect(buildCutGroups([rally(1, 5), rally(7.999, 10, 2)], 0, 0, 30, 'hybrid_motion_bounce')).toHaveLength(1);
    const groups = buildCutGroups([rally(1, 5), rally(8, 10, 2)], 0, 0, 30, 'hybrid_motion_bounce');
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.end)).toEqual([5, 10]);
    expect(buildCutGroups([rally(1, 5)], 0, 4, 30, 'hybrid_motion_bounce')[0]?.end).toBe(9);
    expect(buildCutGroups([rally(1, 5), rally(8, 10, 2)], 0, 0, 30, 'bounce_events')).toHaveLength(1);
  });
});
