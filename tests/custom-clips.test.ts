import { describe, expect, it } from 'vitest';
import {
  createCustomClipDraft,
  customExportSegments,
  InvalidCustomSegmentsError,
  resizeCustomClip,
  setCustomClipSelected,
  validateAndBuildCustomCutGroups,
  validateCustomExportSegments,
  type CustomExportSegment,
} from '../src/domain/custom-clips';
import type { AnalysisResultV1, Rally } from '../src/shared/contracts';
import { cutSelectionSchema, exportRequestSchema } from '../src/shared/contracts';

function rally(id: string, index: number, start: number, end: number): Rally {
  return { id, index, bounce_count: index + 2, start_time_seconds: start, end_time_seconds: end };
}

function analysis(rallies: Rally[] = [rally('rally_001', 1, 10, 12), rally('rally_002', 2, 15, 17)]): AnalysisResultV1 {
  return {
    schema_version: 1,
    video: {
      path: 'D:/match.mp4', duration_seconds: 30, width: 1280, height: 720, fps: 30,
      variable_frame_rate: false, video_codec: 'h264', audio_codec: 'aac', container: 'mp4',
    },
    rallies,
  };
}

describe('custom rally clip draft', () => {
  it('applies configured rolls, the fixed closing second, and source clamping', () => {
    const clips = createCustomClipDraft([
      rally('rally_001', 1, 1, 2),
      rally('rally_002', 2, 28, 29.5),
    ], 2.5, 2, 30, 30);
    expect(clips.map((clip) => [clip.start, clip.end])).toEqual([[0, 5], [25.5, 30]]);
  });

  it('splits default overlap at its midpoint', () => {
    const clips = createCustomClipDraft([
      rally('rally_001', 1, 10, 12),
      rally('rally_002', 2, 14, 16),
    ], 2.5, 2, 30, 30);
    expect(clips[0]?.end).toBe(13.25);
    expect(clips[1]?.start).toBe(13.25);
  });

  it('constrains handles to the source, selected neighbors, and one source frame', () => {
    const clips = createCustomClipDraft([
      rally('rally_001', 1, 10, 12),
      rally('rally_002', 2, 15, 17),
    ], 0, 0, 30, 30);
    const expanded = resizeCustomClip(clips, 'rally_001', 'end', 16, 30, 30);
    expect(expanded[0]?.end).toBe(expanded[1]?.start);
    const oneFrame = resizeCustomClip(expanded, 'rally_001', 'start', 99, 30, 30);
    expect(oneFrame[0]!.end - oneFrame[0]!.start).toBeCloseTo(1 / 30, 5);
  });

  it('removes hidden clips as constraints and rebuilds only a conflicting region when reselected', () => {
    const initial = createCustomClipDraft([
      rally('rally_001', 1, 5, 6),
      rally('rally_002', 2, 10, 11),
      rally('rally_003', 3, 20, 21),
    ], 1, 1, 30, 30);
    const hidden = setCustomClipSelected(initial, 'rally_002', false, 30, 30);
    const expanded = resizeCustomClip(hidden, 'rally_001', 'end', 12, 30, 30);
    expect(customExportSegments(expanded).map((segment) => segment.rally_id)).toEqual(['rally_001', 'rally_003']);
    const restored = setCustomClipSelected(expanded, 'rally_002', true, 30, 30);
    expect(restored[0]!.end).toBeLessThanOrEqual(restored[1]!.start);
    expect(restored[2]!.start).toBe(initial[2]!.start);
  });
});

describe('custom export validation', () => {
  it('uses explicit segments and rejects the removed global-roll contract', () => {
    expect(cutSelectionSchema.parse({
      mode: 'custom',
      segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }],
    })).toEqual({
      mode: 'custom',
      segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }],
    });
    expect(cutSelectionSchema.safeParse({
      mode: 'custom', selected_rally_ids: ['rally_001'], pre_roll_seconds: 2.5, post_roll_seconds: 2,
    }).success).toBe(false);
  });
  it('accepts valid ranges and merges touching ranges', () => {
    expect(validateAndBuildCustomCutGroups(analysis(), [
      { rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 },
      { rally_id: 'rally_002', start_time_seconds: 14, end_time_seconds: 20 },
    ])).toEqual([{
      rallyIds: ['rally_001', 'rally_002'], rawStart: 8, rawEnd: 20, start: 8, end: 20,
    }]);
  });

  it('validates custom artifact output combinations without changing legacy requests', () => {
    const base = {
      analysis_id: '11111111-1111-4111-8111-111111111111',
      selection: { mode: 'custom' as const, segments: [{ rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 }] },
      destination: 'source' as const,
    };
    expect(exportRequestSchema.safeParse(base).success).toBe(true);
    expect(exportRequestSchema.safeParse({
      ...base,
      outputs: { combined_video: false, rally_videos: true, premiere_xml: true },
    }).success).toBe(true);
    expect(exportRequestSchema.safeParse({
      ...base,
      outputs: { combined_video: true, rally_videos: true, premiere_xml: false },
    }).success).toBe(false);
    expect(exportRequestSchema.safeParse({
      ...base,
      outputs: { combined_video: false, rally_videos: false, premiere_xml: false },
    }).success).toBe(false);
    expect(exportRequestSchema.safeParse({
      ...base,
      selection: { mode: 'all', pre_roll_seconds: 2.5, post_roll_seconds: 2 },
      outputs: { combined_video: false, rally_videos: false, premiere_xml: true },
    }).success).toBe(false);
  });

  it('keeps touching ranges separate for per-rally artifact exports', () => {
    expect(validateCustomExportSegments(analysis(), [
      { rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 14 },
      { rally_id: 'rally_002', start_time_seconds: 14, end_time_seconds: 20 },
    ])).toMatchObject([
      { rallyId: 'rally_001', rallyIndex: 1, start: 8, end: 14 },
      { rallyId: 'rally_002', rallyIndex: 2, start: 14, end: 20 },
    ]);
  });

  const invalidSegments: CustomExportSegment[][] = [
    [{ rally_id: 'missing', start_time_seconds: 1, end_time_seconds: 2 }],
    [
      { rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: 2 },
      { rally_id: 'rally_001', start_time_seconds: 3, end_time_seconds: 4 },
    ],
    [{ rally_id: 'rally_001', start_time_seconds: -1, end_time_seconds: 2 }],
    [{ rally_id: 'rally_001', start_time_seconds: 1, end_time_seconds: Number.POSITIVE_INFINITY }],
    [{ rally_id: 'rally_001', start_time_seconds: 2, end_time_seconds: 2.01 }],
    [
      { rally_id: 'rally_002', start_time_seconds: 10, end_time_seconds: 12 },
      { rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 9 },
    ],
    [
      { rally_id: 'rally_001', start_time_seconds: 8, end_time_seconds: 11 },
      { rally_id: 'rally_002', start_time_seconds: 10, end_time_seconds: 12 },
    ],
  ];

  invalidSegments.forEach((segments, index) => {
    it(`rejects invalid custom range case ${index + 1}`, () => {
      expect(() => validateAndBuildCustomCutGroups(analysis(), segments)).toThrow(InvalidCustomSegmentsError);
    });
  });
});
