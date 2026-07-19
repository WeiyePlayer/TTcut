import { describe, expect, it } from 'vitest';
import { buildCutGroups, selectRallies, SelectionError } from '../src/domain/segments';
import type { AnalysisResultV1, Rally } from '../src/shared/contracts';

function rally(id: string, start: number, end: number, bounceCount = 4, index = 1): Rally {
  return {
    id,
    index,
    bounce_count: bounceCount,
    start_time_seconds: start,
    end_time_seconds: end,
  };
}

describe('buildCutGroups', () => {
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

  it('rejects empty custom selection', () => {
    expect(() => selectRallies(result, {
      mode: 'custom', selected_rally_ids: ['missing'], pre_roll_seconds: 2.5, post_roll_seconds: 2,
    })).toThrowError(SelectionError);
  });
});
