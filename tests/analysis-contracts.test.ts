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

  it('limits TrackNet selection to the explicit local-test v4 request schema', () => {
    expect(analysisRequestSchema.parse({
      schema_version: 4,
      ...base,
      ball_model_profile: 'tracknet_v1',
      analysis: { mode: 'full', confidence_threshold: 0.7 },
      rally_recognition: { method: 'bounce_events' },
    })).toMatchObject({ schema_version: 4, ball_model_profile: 'tracknet_v1' });
    expect(() => analysisRequestSchema.parse({
      schema_version: 3,
      ...base,
      ball_model_profile: 'tracknet_v1',
      analysis: { mode: 'full', confidence_threshold: 0.7 },
      rally_recognition: { method: 'bounce_events' },
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
        method: 'continuous_visibility', detection_confidence_threshold: 0.3,
        start_visible_seconds: 0.2, end_invisible_seconds: 0.5,
        motion_filter: {
          minimum_horizontal_excursion_ratio: 20 / 618,
          maximum_reversal_gap_seconds: 0.35,
          minimum_horizontal_to_vertical_range_ratio: 0.7,
          maximum_monotonic_vertical_reversals: 1,
          minimum_monotonic_horizontal_range_ratio: 200 / 618,
          minimum_monotonic_duration_seconds: 0.6,
          short_vertical_filter_seconds: 1.2,
          maximum_short_vertical_range_ratio: 0.5,
          vertical_exchange_enabled: true,
          minimum_vertical_to_horizontal_range_ratio: 1,
          end_on_min_opposing_edge_balance: 0.85,
          end_on_min_screen_aspect_ratio: 2,
        },
        fragment_bridge: {
          maximum_gap_seconds: 1.5,
          maximum_boundary_displacement_ratio: 0.35,
          maximum_boundary_speed_ratio_per_second: 0.26,
        },
        tracknet_filter: {
          minimum_rally_seconds: 0.9,
          strong_evidence_minimum_rally_seconds: 0.75,
          strong_evidence_minimum_expanded_table_ratio: 0.8,
          minimum_horizontal_run_reversals: 1,
          short_rally_seconds: 2,
          minimum_short_rally_expanded_table_ratio: 0.2,
          expanded_table_length_margin_cm: 35,
          expanded_table_width_margin_cm: 25,
          reliable_fragment_bridge_seconds: 1.5,
        },
      },
      model_provenance: {
        profile: 'tracknet_v1', component_version: null,
        roi: { x: 364, y: 113, width: 611, height: 340 },
        main_input: { width: 248, height: 136 }, aux_input: null,
        tracknet: {
          confidence_threshold: 0.35, roi_model_scale: 1,
          inference_seconds: 26.7, predictor_seconds: 64.8,
          detected_frames: 5588, missing_frames: 9619,
        },
      },
    });
    expect(result.rallies[0]).not.toHaveProperty('bounce_count');
    if (result.schema_version !== 2 || result.rally_recognition.method !== 'continuous_visibility') {
      throw new Error('Expected a continuous-visibility v2 result');
    }
    expect(result.rally_recognition.tracknet_filter?.minimum_rally_seconds).toBe(0.9);
    expect(
      result.rally_recognition.tracknet_filter?.strong_evidence_minimum_rally_seconds,
    ).toBe(0.75);
    expect(result.model_provenance?.tracknet?.confidence_threshold).toBe(0.35);
    expect(() => analysisResultSchema.parse({
      ...result,
      rallies: [{ ...result.rallies[0], bounce_count: 3 }],
    })).toThrow();
  });

  it('models BlurBall inter-rally fragment filter provenance', () => {
    const result = analysisResultSchema.parse({
      schema_version: 2,
      video: {
        path: 'match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30,
        variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4',
      },
      rallies: [],
      rally_recognition: {
        method: 'continuous_visibility',
        start_visible_seconds: 0.2,
        end_invisible_seconds: 0.5,
        inter_rally_fragment_filter: {
          side_on_views_only: true,
          minimum_candidate_seconds: 1,
          maximum_candidate_seconds: 6,
          maximum_expanded_table_ratio: 0.45,
          minimum_visible_run_count: 3,
          minimum_one_way_range_ratio: 0.55,
          maximum_sparse_visibility_ratio: 0.3,
          minimum_contiguous_flight_seconds: 0.15,
          minimum_coherent_reversal_ratio: 0.2,
          minimum_coherent_flight_displacement_ratio: 0.15,
          expanded_table_length_margin_cm: 35,
          expanded_table_width_margin_cm: 25,
          long_candidate_segmentation: {
            minimum_candidate_seconds: 10,
            minimum_motion_run_seconds: 0.15,
            minimum_motion_run_horizontal_range_ratio: 0.15,
            short_gap_seconds: 1.25,
            long_gap_seconds: 2.25,
            minimum_visible_gap_ratio: 0.36,
            minimum_stationary_run_seconds: 0.5,
            boundary_context_seconds: 0.25,
            leading_pass_minimum_motion_seconds: 2.5,
            leading_pass_minimum_run_count: 3,
            leading_pass_maximum_expanded_table_ratio: 0.36,
            internal_transfer_minimum_motion_seconds: 1,
            internal_transfer_minimum_strict_table_ratio: 0.9,
          },
        },
      },
    });
    if (result.schema_version !== 2 || result.rally_recognition.method !== 'continuous_visibility') {
      throw new Error('Expected a continuous-visibility v2 result');
    }
    expect(result.rally_recognition.inter_rally_fragment_filter?.minimum_visible_run_count).toBe(3);
    expect(
      result.rally_recognition.inter_rally_fragment_filter
        ?.long_candidate_segmentation?.minimum_candidate_seconds,
    ).toBe(10);
  });
});
