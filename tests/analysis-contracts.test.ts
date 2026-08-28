import { describe, expect, it } from 'vitest';
import { analysisRequestSchema, analysisResultSchema } from '../src/shared/contracts';

const base = {
  task_id: '22222222-2222-4222-8222-222222222222',
  video_path: 'match.mp4',
  device: 'cpu' as const,
  video_metadata: {
    duration_seconds: 10,
    fps: 30,
    frame_count: 300,
    variable_frame_rate: false,
  },
  calibration_choice: {
    method: 'manual' as const,
    calibration: {
      video_width: 1280,
      video_height: 720,
      points: {
        top_left: [1, 1] as [number, number],
        top_right: [2, 1] as [number, number],
        bottom_right: [2, 2] as [number, number],
        bottom_left: [1, 2] as [number, number],
      },
    },
  },
};

describe('BlurBall analysis request contracts', () => {
  it('keeps legacy v1 requests valid and defaults their threshold', () => {
    const parsed = analysisRequestSchema.parse({ schema_version: 1, ...base });
    expect(parsed).toMatchObject({ schema_version: 1, blurball_confidence_threshold: 0.7 });
  });

  it('accepts full and two-stage v2 configurations', () => {
    expect(analysisRequestSchema.parse({
      schema_version: 2,
      ...base,
      analysis: { mode: 'full', confidence_threshold: 0.55 },
    })).toMatchObject({ analysis: { mode: 'full', confidence_threshold: 0.55 } });
    expect(analysisRequestSchema.parse({
      schema_version: 2,
      ...base,
      analysis: {
        mode: 'two_stage',
        stage1_confidence_threshold: 0.3,
        stage2_confidence_threshold: 0.7,
      },
    })).toMatchObject({ analysis: { mode: 'two_stage' } });
  });

  it('adds v3 rally recognition while preserving v1 and v2 as bounce-event requests', () => {
    expect(analysisRequestSchema.parse({
      schema_version: 3,
      ...base,
      analysis: { mode: 'full', confidence_threshold: 0.7 },
      rally_recognition: { method: 'continuous_visibility' },
    })).toMatchObject({ rally_recognition: { method: 'continuous_visibility' } });
    expect(() => analysisRequestSchema.parse({
      schema_version: 3,
      ...base,
      analysis: { mode: 'full', confidence_threshold: 0.7 },
      rally_recognition: { method: 'unknown' },
    })).toThrow();
  });

  it('rejects out-of-range stage thresholds and unknown config fields', () => {
    expect(() => analysisRequestSchema.parse({
      schema_version: 2,
      ...base,
      analysis: { mode: 'two_stage', stage1_confidence_threshold: 0.05, stage2_confidence_threshold: 0.7 },
    })).toThrow();
    expect(() => analysisRequestSchema.parse({
      schema_version: 2,
      ...base,
      analysis: { mode: 'full', confidence_threshold: 0.7, fallback: true },
    })).toThrow();
  });

  it('parses v2 model provenance while keeping the result envelope compatible', () => {
    const result = analysisResultSchema.parse({
      schema_version: 1,
      video: {
        path: 'match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30,
        variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4',
      },
      rallies: [],
      model_provenance: {
        profile: 'blurball_v1', component_version: '1.0.0',
        roi: { x: 0, y: 0, width: 1280, height: 720 },
        main_input: { width: 512, height: 288 }, aux_input: null,
        detection: { confidence_threshold: 0.7, step: 1, maximum_displacement_pixels: 100, landing_region: 'expanded_table' },
        analysis: {
          schema_version: 2,
          mode: 'two_stage', interval_expansion_seconds: 0.75,
          stages: [
            { name: 'candidate', confidence_threshold: 0.3, window_size: 3, window_stride: 3, retained_output: 'all_window_frames' },
            { name: 'refinement', confidence_threshold: 0.7, window_size: 3, window_stride: 1, retained_output: 'center_frame' },
          ],
        },
      },
    });
    expect(result.model_provenance?.analysis?.mode).toBe('two_stage');
  });

  it('models continuous-visibility results without bounce fields', () => {
    const result = analysisResultSchema.parse({
      schema_version: 2,
      video: {
        path: 'match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30,
        variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4',
      },
      rallies: [{ id: 'rally_001', index: 1, start_time_seconds: 1, end_time_seconds: 5 }],
      rally_recognition: {
        method: 'continuous_visibility', start_visible_seconds: 0.2, end_invisible_seconds: 0.5,
        motion_filter: {
          minimum_horizontal_excursion_ratio: 20 / 618,
          maximum_reversal_gap_seconds: 0.35,
          minimum_horizontal_to_vertical_range_ratio: 0.7,
          maximum_monotonic_vertical_reversals: 1,
          minimum_monotonic_horizontal_range_ratio: 200 / 618,
          minimum_monotonic_duration_seconds: 0.6,
          short_vertical_filter_seconds: 1.2,
          maximum_short_vertical_range_ratio: 0.5,
        },
        fragment_bridge: {
          maximum_gap_seconds: 1.5,
          maximum_boundary_displacement_ratio: 0.35,
          maximum_boundary_speed_ratio_per_second: 0.26,
        },
      },
    });
    expect(result.rallies[0]).not.toHaveProperty('bounce_count');
    expect(() => analysisResultSchema.parse({
      ...result,
      rallies: [{ ...result.rallies[0], bounce_count: 3 }],
    })).toThrow();
  });
});
