import { describe, expect, it } from 'vitest';
import { buildCutGroups, createCutGroups, SelectionError, selectRallies } from '../src/domain/segments';
import type { AnalysisResultV1, BounceRally, Rally } from '../src/shared/contracts';

function rally(id: string, start: number, end: number, bounceCount = 4, index = 1): BounceRally {
  return {
    id,
    index,
    bounce_count: bounceCount,
    start_time_seconds: start,
    end_time_seconds: end,
  };
}

describe('buildCutGroups', () => {
  it('stops continuous lead-in at an observed transfer without moving the rally', () => {
    const detected = { id: 'rally_001', index: 1, start_time_seconds: 10, end_time_seconds: 15, lead_in_start_time_seconds: 9 };
    expect(buildCutGroups([detected], 2.5, 1, 30, 'continuous_visibility')[0]).toMatchObject({
      start: 9, end: 16, rawStart: 10, rawEnd: 15,
    });
    expect(buildCutGroups([detected], 0.5, 1, 30, 'continuous_visibility')[0]?.start).toBe(9.5);
    expect(buildCutGroups([detected], 2.5, 1, 30, 'bounce_events')[0]).toMatchObject({ start: 7.5, end: 17 });
  });
  it('merges a 4.999 second gap', () => {
    expect(buildCutGroups([rally('rally_001', 10, 15), rally('rally_002', 19.999, 21)], 0, 0, 60)).toHaveLength(1);
  });

  it('does not merge an exact 5 second gap', () => {
    expect(buildCutGroups([rally('rally_001', 10, 15), rally('rally_002', 20, 21)], 0, 0, 60)).toHaveLength(2);
  });

  it('sorts, deduplicates, clamps and merges expanded overlap', () => {
    const first = rally('rally_001', 1, 3, 4, 1);
    const groups = buildCutGroups([
      rally('rally_003', 12, 14, 4, 3),
      first,
      rally('rally_002', 8, 9, 4, 2),
      first,
    ], 2.5, 4, 15);
    expect(groups).toEqual([{
      rallyIds: ['rally_001', 'rally_002', 'rally_003'],
      rawStart: 1,
      rawEnd: 14,
      start: 0,
      end: 15,
    }]);
  });

  it('returns empty for invalid input', () => {
    expect(buildCutGroups([], 2.5, 2, 60)).toEqual([]);
    expect(buildCutGroups([rally('rally_001', 1, 2)], 2.5, 2, 0)).toEqual([]);
  });

  it('adds one closing second only after the final rally in a cut group', () => {
    expect(buildCutGroups([
      rally('rally_001', 10, 15),
      rally('rally_002', 18, 20),
    ], 0, 2, 60)).toEqual([{
      rallyIds: ['rally_001', 'rally_002'],
      rawStart: 10,
      rawEnd: 20,
      start: 10,
      end: 23,
    }]);
  });

  it('ends at the source boundary when the final closing time exceeds it', () => {
    expect(buildCutGroups([rally('rally_001', 55, 59)], 0, 4, 60)[0]?.end).toBe(60);
  });
});

describe('selectRallies', () => {
  const result: AnalysisResultV1 = {
    schema_version: 1,
    video: {
      path: 'D:/match.mp4', duration_seconds: 30, width: 1280, height: 720,
      fps: 60, variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4',
    },
    rallies: [rally('rally_001', 1, 2, 5, 1), rally('rally_002', 4, 6, 6, 2)],
  };

  it('uses strict highlight threshold', () => {
    expect(selectRallies(result, {
      mode: 'highlight', highlight_threshold: 5, pre_roll_seconds: 2.5, post_roll_seconds: 2,
    }).map((item) => item.id)).toEqual(['rally_002']);
  });

  it('uses the result recognition method for all and highlight export tails', () => {
    const visibility: AnalysisResultV1 = {
      schema_version: 2,
      video: result.video,
      rallies: [{ id: 'rally_001', index: 1, start_time_seconds: 10, end_time_seconds: 15 }],
      rally_recognition: { method: 'continuous_visibility', start_visible_seconds: 0.2, end_invisible_seconds: 0.5 },
    };
    const rolls = { pre_roll_seconds: 2.5 as const, post_roll_seconds: 1 as const };
    expect(createCutGroups(visibility, { mode: 'all', ...rolls })[0]).toMatchObject({ start: 7.5, end: 16 });
    expect(createCutGroups(visibility, {
      mode: 'highlight', criterion: { kind: 'duration_tier', tier: 'long_rally' }, ...rolls,
    })[0]?.end).toBe(16);
    expect(createCutGroups({ ...result, rallies: [rally('rally_001', 10, 15)] }, {
      mode: 'all', ...rolls,
    })[0]?.end).toBe(17);
  });

  it('keeps legacy highlight selections compatible with bounce results', () => {
    expect(selectRallies(result, {
      mode: 'highlight', highlight_threshold: 5, pre_roll_seconds: 2.5, post_roll_seconds: 2,
    }).map((item) => item.id)).toEqual(['rally_002']);
  });

  it('uses strict, cumulative duration tiers for continuous visibility results', () => {
    const visibilityResult: AnalysisResultV1 = {
      schema_version: 2,
      video: result.video,
      rallies: [
        { id: 'rally_001', index: 1, start_time_seconds: 0, end_time_seconds: 2.7 },
        { id: 'rally_002', index: 2, start_time_seconds: 3, end_time_seconds: 7.01 },
        { id: 'rally_003', index: 3, start_time_seconds: 8, end_time_seconds: 12.81 },
      ],
      rally_recognition: {
        method: 'continuous_visibility', start_visible_seconds: 0.2, end_invisible_seconds: 0.5,
      },
    };
    const common = { mode: 'highlight' as const, pre_roll_seconds: 2.5 as const, post_roll_seconds: 2 as const };
    const short = selectRallies(visibilityResult, { ...common, criterion: { kind: 'duration_tier', tier: 'short_rally' } });
    const medium = selectRallies(visibilityResult, { ...common, criterion: { kind: 'duration_tier', tier: 'rally' } });
    const long = selectRallies(visibilityResult, { ...common, criterion: { kind: 'duration_tier', tier: 'long_rally' } });
    expect(short.map((item) => item.id)).toEqual(['rally_002', 'rally_003']);
    expect(medium.map((item) => item.id)).toEqual(['rally_002', 'rally_003']);
    expect(long.map((item) => item.id)).toEqual(['rally_003']);
  });

  it('rejects a criterion for the other recognition method', () => {
    const visibilityResult: AnalysisResultV1 = {
      schema_version: 2,
      video: result.video,
      rallies: [{ id: 'rally_001', index: 1, start_time_seconds: 0, end_time_seconds: 5 }],
      rally_recognition: {
        method: 'continuous_visibility', start_visible_seconds: 0.2, end_invisible_seconds: 0.5,
      },
    };
    expect(() => selectRallies(visibilityResult, {
      mode: 'highlight', criterion: { kind: 'bounce_count', threshold: 3 }, pre_roll_seconds: 2.5, post_roll_seconds: 2,
    })).toThrow(new SelectionError('INVALID_HIGHLIGHT_CRITERION'));
    expect(() => selectRallies(result, {
      mode: 'highlight', criterion: { kind: 'duration_tier', tier: 'short_rally' }, pre_roll_seconds: 2.5, post_roll_seconds: 2,
    })).toThrow(new SelectionError('INVALID_HIGHLIGHT_CRITERION'));
  });
});
