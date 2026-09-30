import { describe, expect, it } from 'vitest';
import { analysisRollSettings } from '../src/domain/analysis-settings';
import { buildCutGroups, createCutGroups, rallyLeadInStart, selectRallies } from '../src/domain/segments';
import { createCustomClipDraft } from '../src/domain/custom-clips';
import { appSettingsSchema } from '../src/shared/contracts';
import { smallResult } from './fixtures/small-result';
import { updateSmallHistoryBoundaries } from '../src/domain/small-history';

describe('Small export timing', () => {
  it('defaults independently from existing padding and follows the result backend', () => {
    const settings = appSettingsSchema.parse({ analysis_backend: 'existing', language: 'en', calibration_method: 'automatic', pre_roll_seconds: 2.5, post_roll_seconds: 1 });
    expect(analysisRollSettings(settings, 'mobilenet_small')).toEqual({ pre_roll_seconds: 0, post_roll_seconds: 0 });
    expect(analysisRollSettings(settings, 'existing')).toEqual({ pre_roll_seconds: 2.5, post_roll_seconds: 1 });
    expect(analysisRollSettings({ ...settings, small_pre_roll_seconds: 0.5, small_post_roll_seconds: 2 }, 'mobilenet_small')).toEqual({ pre_roll_seconds: 0.5, post_roll_seconds: 0 });
  });

  it('trims each serve without merging back the discarded preparation, for automatic and custom clips', () => {
    const result = smallResult();
    const selection = { mode: 'all' as const, pre_roll_seconds: 0 as const, post_roll_seconds: 0 as const };
    const groups = createCutGroups(result, selection);
    const clips = createCustomClipDraft(result.rallies, 0, 0, 38, 59.94, 'mobilenet_small');
    expect(groups).toHaveLength(result.rallies.length);
    expect(groups[0]!.start).toBeCloseTo(0.7);
    expect(groups[1]!.start).toBeCloseTo(16);
    groups.forEach((group, index) => {
      expect(group.end).toBeCloseTo(result.rallies[index]!.end_time_seconds + 0.5);
      expect(clips[index]!.start).toBeCloseTo(group.start);
      expect(clips[index]!.end).toBeCloseTo(group.end);
    });
    expect(selectRallies(result, { ...selection, mode: 'highlight', criterion: { kind: 'duration_tier', tier: 'rally' } })).toEqual(
      result.rallies.filter(r => r.end_time_seconds - r.start_time_seconds > 4),
    );
  });

  it('fills a 1.5-second lead for short serves and play-only rallies, and expands from that start', () => {
    const rally = smallResult().rallies[0]!;
    const serve = rally.phases[0]!;
    const serveOnly = { ...rally, end_time_seconds: 2.2, phases: [serve] };
    expect(rallyLeadInStart(serveOnly, 0, 'mobilenet_small')).toBeCloseTo(0.7);
    expect(rallyLeadInStart({ ...serveOnly, phases: [{ ...serve, end_sec: 0.6 }] }, 0, 'mobilenet_small')).toBe(0);
    const shortServe = { ...rally, start_time_seconds: 4, end_time_seconds: 7,
      phases: [{ ...serve, start_sec: 4, end_sec: 4.6 }, { ...rally.phases[1]!, start_sec: 4.6, end_sec: 7 }] };
    const playOnly = { ...rally, id: 'rally_002', index: 2, start_time_seconds: 10, end_time_seconds: 12,
      phases: [{ ...rally.phases[1]!, start_sec: 10, end_sec: 12 }] };
    expect(rallyLeadInStart(shortServe, 0, 'mobilenet_small')).toBe(2.5);
    expect(rallyLeadInStart(playOnly, 0, 'mobilenet_small')).toBe(8.5);
    expect(rallyLeadInStart(shortServe, 0.5, 'mobilenet_small')).toBe(2);
    const groups = buildCutGroups([shortServe, playOnly], 0, 0, 14, 'mobilenet_small');
    const clips = createCustomClipDraft([shortServe, playOnly], 0, 0, 14, 30, 'mobilenet_small');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.start).toBe(2.5);
    expect(groups[1]!.start).toBe(8.5);
    expect(clips.map(clip => clip.start)).toEqual([2.5, 8.5]);
    expect(rallyLeadInStart(rally, 0.5, 'mobilenet_small')).toBeCloseTo(0.2);
    expect(rallyLeadInStart(rally, 5, 'mobilenet_small')).toBe(0);
    expect(rallyLeadInStart(playOnly, 1.5, 'hybrid_motion_bounce')).toBeCloseTo(8.5);
  });

  it('removes short play before selection, history and custom editing; keeps exactly two seconds', () => {
    const result = smallResult();
    const first = result.rallies[0]!;
    const play = first.phases.find(phase => phase.label === 'play')!;
    const short = { ...first, phases: first.phases.map(phase => phase.label === 'play'
      ? { ...phase, end_sec: play.start_sec + 1.999, duration_sec: 99 } : phase) };
    const exact = { ...result.rallies[1]!, phases: [{ ...play, start_sec: 18, end_sec: 20, duration_sec: 2 }] };
    const serveOnly = { ...result.rallies[2]!, phases: result.rallies[2]!.phases.filter(p => p.label === 'serve') };
    result.rallies = [short, exact, serveOnly];
    const selection = { mode: 'all' as const, pre_roll_seconds: 0 as const, post_roll_seconds: 0 as const };
    expect(selectRallies(result, selection)).toEqual([exact]);
    expect(createCustomClipDraft(result.rallies, 0, 4, 38, 30, 'mobilenet_small')).toHaveLength(1);
    expect(buildCutGroups(result.rallies, 0, 4, 38, 'mobilenet_small')).toHaveLength(1);
    const normalized = updateSmallHistoryBoundaries(result);
    expect(normalized.rallies.map(r => [r.id, r.index])).toEqual([['rally_001', 1]]);
    expect(updateSmallHistoryBoundaries(normalized)).toBe(normalized);
    expect(() => selectRallies({ ...result, rallies: [short, serveOnly] }, selection)).toThrow('NO_RALLIES');
  });

  it('uses a fixed half-second tail even with stale padding settings, capped by actual video end', () => {
    const result = smallResult();
    const groups = createCutGroups(result, { mode: 'all', pre_roll_seconds: 0, post_roll_seconds: 4 });
    expect(groups[0]!.end).toBeCloseTo(result.rallies[0]!.end_time_seconds + 0.5);
    const end = result.rallies.at(-1)!.end_time_seconds;
    const clips = createCustomClipDraft(result.rallies, 0, 4, end + 0.2, 30, 'mobilenet_small');
    expect(clips.at(-1)!.end).toBeCloseTo(end + 0.2);
  });
});
