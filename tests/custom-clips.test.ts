import { describe, expect, it } from 'vitest';
import {
  calculateManualBounceCount,
  createCustomClipDraft,
  createManualCustomClip,
  customExportSegments,
  deleteCustomClip,
  InvalidCustomSegmentsError,
  resizeCustomClip,
  setCustomClipSelected,
  validateAndBuildCustomCutGroups,
  validateCustomExportSegments,
} from '../src/domain/custom-clips';
import type { AnalysisResultV1, BounceRally, CustomExportSegmentInput } from '../src/shared/contracts';
import { cutSelectionSchema, exportRequestSchema } from '../src/shared/contracts';

function rally(id: string, index: number, start: number, end: number): BounceRally {
  return { id, index, bounce_count: index + 2, start_time_seconds: start, end_time_seconds: end };
}

function analysis(rallies: BounceRally[] = [rally('rally_001', 1, 10, 12), rally('rally_002', 2, 15, 17)]): AnalysisResultV1 {
  return {
    schema_version: 1,
    video: {
      path: 'D:/match.mp4', duration_seconds: 30, width: 1280, height: 720, fps: 30,
      variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4',
    },
    rallies,
    bounce_times_seconds: [1.25, 2.25, 4.75, 12, 16.5],
  };
}

describe('custom rally clip draft', () => {
  it('applies configured rolls, the fixed closing second, and source clamping', () => {
    const clips = createCustomClipDraft([rally('rally_001', 1, 1, 2), rally('rally_002', 2, 28, 29.5)], 2.5, 2, 30, 30);
    expect(clips.map((clip) => [clip.start, clip.end])).toEqual([[0, 5], [25.5, 30]]);
    expect(clips[0]).toMatchObject({ clipId: 'rally_001', source: 'detected', sourceRallyId: 'rally_001' });
  });

  it('splits default overlap at its midpoint', () => {
    const clips = createCustomClipDraft([rally('rally_001', 1, 10, 12), rally('rally_002', 2, 14, 16)], 2.5, 2, 30, 30);
    expect(clips[0]?.end).toBe(13.25);
    expect(clips[1]?.start).toBe(13.25);
  });

  it('constrains detected handles to selected neighbors and one source frame', () => {
    const clips = createCustomClipDraft([rally('rally_001', 1, 10, 12), rally('rally_002', 2, 15, 17)], 0, 0, 30, 30);
    const expanded = resizeCustomClip(clips, 'rally_001', 'end', 16, 30, 30);
    expect(expanded[0]?.end).toBe(expanded[1]?.start);
    const oneFrame = resizeCustomClip(expanded, 'rally_001', 'start', 99, 30, 30);
    expect(oneFrame[0]!.end - oneFrame[0]!.start).toBeCloseTo(1 / 30, 5);
    expect(oneFrame[0]?.bounceCount).toBe(3);
  });

  it('keeps hidden detected clips out of detected-resize constraints and restores a conflicting region when reselected', () => {
    const initial = createCustomClipDraft([rally('rally_001', 1, 5, 6), rally('rally_002', 2, 10, 11), rally('rally_003', 3, 20, 21)], 1, 1, 30, 30);
    const hidden = setCustomClipSelected(initial, 'rally_002', false, 30, 30);
    const expanded = resizeCustomClip(hidden, 'rally_001', 'end', 12, 30, 30);
    expect(customExportSegments(expanded).map((segment) => segment.clip_id)).toEqual(['rally_001', 'rally_003']);
    const restored = setCustomClipSelected(expanded, 'rally_002', true, 30, 30);
    expect(restored[0]!.end).toBeLessThanOrEqual(restored[1]!.start);
    expect(restored[2]!.start).toBe(initial[2]!.start);
  });

  it('creates a selected exact one-second Manual Rally Clip and reindexes all clips by time', () => {
    const detected = createCustomClipDraft([rally('rally_001', 8, 5, 6)], 0, 0, 20, 30);
    const created = createManualCustomClip(detected, 'manual_a', 2, 20, [2, 2.4, 3, 5.2]);
    expect(created).not.toBeNull();
    expect(created?.map((clip) => [clip.clipId, clip.rallyIndex])).toEqual([['manual_a', 1], ['rally_001', 2]]);
    expect(created?.[0]).toMatchObject({ source: 'manual', sourceRallyId: null, start: 2, end: 3, bounceCount: 2, selected: true });
  });

  it('rejects a manual creation outside source bounds or overlapping every draft clip, including an unselected clip', () => {
    const initial = createManualCustomClip([], 'manual_a', 4, 6, []);
    expect(initial).not.toBeNull();
    const hidden = setCustomClipSelected(initial!, 'manual_a', false, 6, 30);
    expect(createManualCustomClip(hidden, 'manual_b', 4.25, 6, [])).toBeNull();
    expect(createManualCustomClip(hidden, 'manual_c', 5.1, 6, [])).toBeNull();
  });

  it('uses every draft neighbor for manual resize and recomputes only manual board counts', () => {
    const first = createManualCustomClip([], 'manual_a', 2, 10, [2.2, 4.9, 5, 5.2]);
    const clips = createManualCustomClip(first!, 'manual_b', 5, 10, [2.2, 4.9, 5, 5.2])!;
    const resized = resizeCustomClip(clips, 'manual_a', 'end', 9, 10, 30, [2.2, 4.9, 5, 5.2]);
    expect(resized[0]).toMatchObject({ end: 5, bounceCount: 2 });
    expect(calculateManualBounceCount(2, 5, undefined)).toBeNull();
  });

  it('deletes from only the draft and reindexes the retained clips', () => {
    const first = createManualCustomClip([], 'manual_a', 1, 10, [])!;
    const clips = createManualCustomClip(first, 'manual_b', 4, 10, [])!;
    expect(deleteCustomClip(clips, 'manual_a')).toMatchObject([{ clipId: 'manual_b', rallyIndex: 1 }]);
  });
});

describe('custom export validation', () => {
  it('accepts legacy detected segments and source-aware manual/detected segments', () => {
    expect(cutSelectionSchema.parse({ mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }] })).toEqual({ mode: 'custom', segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }] });
    const groups = validateCustomExportSegments(analysis(), [
      { clip_id: 'rally_001', source: 'detected', rally_id: 'rally_001', display_index: 1, start_time_seconds: 8, end_time_seconds: 14 },
      { clip_id: 'manual_one', source: 'manual', display_index: 2, start_time_seconds: 14, end_time_seconds: 15 },
    ]);
    expect(groups).toMatchObject([
      { clipId: 'rally_001', source: 'detected', sourceRallyId: 'rally_001', rallyIndex: 1 },
      { clipId: 'manual_one', source: 'manual', sourceRallyId: null, rallyIndex: 2 },
    ]);
    expect(cutSelectionSchema.safeParse({ mode: 'custom', selected_rally_ids: ['rally_001'], pre_roll_seconds: 2.5, post_roll_seconds: 2 }).success).toBe(false);
  });

  it('merges touching source-aware ranges for combined export while preserving their clip IDs', () => {
    expect(validateAndBuildCustomCutGroups(analysis(), [
      { clip_id: 'rally_001', source: 'detected', rally_id: 'rally_001', display_index: 1, start_time_seconds: 8, end_time_seconds: 14 },
      { clip_id: 'manual_one', source: 'manual', display_index: 2, start_time_seconds: 14, end_time_seconds: 20 },
    ])).toEqual([{ rallyIds: ['rally_001', 'manual_one'], rawStart: 8, rawEnd: 20, start: 8, end: 20 }]);
  });

  it('validates custom artifact output combinations without changing legacy requests', () => {
    const base = { analysis_id: '11111111-1111-4111-8111-111111111111', selection: { mode: 'custom' as const, segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }] }, destination: 'source' as const };
    expect(exportRequestSchema.safeParse(base).success).toBe(true);
    expect(exportRequestSchema.safeParse({ ...base, outputs: { combined_video: false, rally_videos: true, premiere_xml: true } }).success).toBe(true);
    expect(exportRequestSchema.safeParse({ ...base, outputs: { combined_video: true, rally_videos: true, premiere_xml: false } }).success).toBe(false);
    expect(exportRequestSchema.safeParse({ ...base, outputs: { combined_video: false, rally_videos: false, premiere_xml: false } }).success).toBe(false);
  });

  const invalidSegments: CustomExportSegmentInput[][] = [
    [{ clip_id: 'missing', source: 'detected', rally_id: 'missing', display_index: 1, start_time_seconds: 1, end_time_seconds: 2 }],
    [{ clip_id: 'manual_a', source: 'manual', display_index: 1, start_time_seconds: 1, end_time_seconds: 2 }, { clip_id: 'manual_a', source: 'manual', display_index: 2, start_time_seconds: 3, end_time_seconds: 4 }],
    [{ clip_id: 'manual_a', source: 'manual', display_index: 1, start_time_seconds: -1, end_time_seconds: 2 }],
    [{ clip_id: 'manual_a', source: 'manual', display_index: 1, start_time_seconds: 1, end_time_seconds: Number.POSITIVE_INFINITY }],
    [{ clip_id: 'manual_a', source: 'manual', display_index: 1, start_time_seconds: 2, end_time_seconds: 2.01 }],
    [{ clip_id: 'manual_b', source: 'manual', display_index: 2, start_time_seconds: 10, end_time_seconds: 12 }, { clip_id: 'manual_a', source: 'manual', display_index: 1, start_time_seconds: 8, end_time_seconds: 9 }],
    [{ clip_id: 'manual_a', source: 'manual', display_index: 1, start_time_seconds: 8, end_time_seconds: 11 }, { clip_id: 'manual_b', source: 'manual', display_index: 2, start_time_seconds: 10, end_time_seconds: 12 }],
  ];

  invalidSegments.forEach((segments, index) => {
    it(`rejects invalid custom range case ${index + 1}`, () => {
      expect(() => validateAndBuildCustomCutGroups(analysis(), segments)).toThrow(InvalidCustomSegmentsError);
    });
  });
});
