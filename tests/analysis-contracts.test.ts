import { describe, expect, it } from 'vitest';
import {
  analysisRequestSchema,
  analysisResultSchema,
  continuousVisibilityRallySchema,
  tableAnalysisSchema,
} from '../src/shared/contracts';

it('preserves an optional transfer boundary while accepting older rallies', () => {
  const rally = { id: 'rally_001', index: 1, start_time_seconds: 10, end_time_seconds: 15 };
  expect(continuousVisibilityRallySchema.parse(rally)).toEqual(rally);
  expect(continuousVisibilityRallySchema.parse({ ...rally, lead_in_start_time_seconds: 9 }).lead_in_start_time_seconds).toBe(9);
  expect(continuousVisibilityRallySchema.safeParse({ ...rally, lead_in_start_time_seconds: 11 }).success).toBe(false);
});

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

it('round-trips FP16 CPU/NE provenance while retaining older Core ML history', () => {
  const result = {
    schema_version: 1,
    video: {
      path: 'match.mp4', duration_seconds: 10, width: 1280, height: 720, fps: 30,
      variable_frame_rate: false, video_codec: 'h264', audio_codec: null, container: 'mp4',
    },
    rallies: [], bounce_times_seconds: [],
  };
  const legacy = { engine: 'coreml', compute_units: 'cpuAndGPU', checkpoint_sha256: 'a'.repeat(64) };
  const current = { ...legacy, compute_units: 'cpuAndNeuralEngine', precision: 'float16', prediction_concurrency: 4 };
  for (const inference_runtime of [legacy, current]) {
    const parsed = analysisResultSchema.parse(JSON.parse(JSON.stringify({ ...result, inference_runtime })));
    expect(parsed.inference_runtime).toEqual(inference_runtime);
  }
  expect(analysisResultSchema.safeParse({
    ...result, inference_runtime: { ...current, prediction_concurrency: 0 },
  }).success).toBe(false);
});

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
    const { long_candidate_segmentation: _legacy, ...filter } =
      result.rally_recognition.inter_rally_fragment_filter!;
    const refined = analysisResultSchema.parse({
      ...result,
      rally_recognition: {
        ...result.rally_recognition,
        inter_rally_fragment_filter: {
          ...filter,
          motion_refinement: {
            version: 2,
            minimum_motion_run_seconds: 0.15,
            minimum_horizontal_range_ratio: 0.05,
            minimum_speed_ratio_per_second: 0.35,
            reversal_range_ratio: 0.06,
            gap_minimum_motion_range_ratio: 0.04,
            gap_minimum_motion_support_ratio: 0.35,
            short_gap_seconds: 1.25,
            long_gap_seconds: 2.25,
            stationary_run_seconds: 0.5,
            boundary_context_seconds: 0.25,
          },
        },
      },
    });
    if (refined.schema_version !== 2) throw new Error('Expected a v2 result');
    expect(refined.rally_recognition).toMatchObject({
      inter_rally_fragment_filter: { motion_refinement: { version: 2 } },
    });
    expect(refined.rally_recognition).not.toHaveProperty(
      'inter_rally_fragment_filter.long_candidate_segmentation',
    );
  });
});

describe('automatic table calibration diagnostics', () => {
  const planarKeypoints = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
  const keypointLabels = [
    'close_left', 'close_right', 'center_left', 'center_right', 'far_left', 'far_right',
    'net_left_bottom', 'net_right_bottom', 'net_center_bottom', 'net_left_top',
    'net_right_top', 'close_center', 'far_center',
  ] as const;

  const v2Diagnostics = {
    schema_version: 2 as const,
    model: { id: 'table_analyze' as const, filename: 'table_analyze.pt' as const, checkpoint_identifier: 'table_analyze' },
    device: 'cuda' as const,
    model_load_seconds: 0.2,
    video_info: {
      width: 1920, height: 1080, fps: 60, metadata_frame_count: 600, decoded_frame_count: 11,
      duration_seconds: 10, sampling_seconds: 0.1, seek_count: 11 as const,
      copied_frame_count: 0 as const, sample_count: 11 as const,
    },
    sampling: Array.from({ length: 11 }, (_, sampleIndex) => ({
      label: `sample_${String(sampleIndex + 1).padStart(2, '0')}`,
      sample_ratio: 0.05 + sampleIndex * 0.09,
      frame_index: 30 + sampleIndex * 54,
      time_seconds: 0.5 + sampleIndex * 0.9,
      target_frame_index: 30 + sampleIndex * 54,
      target_time_seconds: 0.5 + sampleIndex * 0.9,
      seek_method: 'frame' as const,
      position_error_seconds: 0,
      forward_seconds: 0.1,
      keypoints: keypointLabels.map((label, pointIndex) => ({
        keypoint: pointIndex + 1, label, x: 100 + pointIndex, y: 200 + pointIndex,
        activation: 0.7, valid: true,
      })),
    })),
    aggregation_rule: 'temporal_peak_clusters_geometric_consensus' as const,
    fixed_keypoints: keypointLabels.map((label, pointIndex) => planarKeypoints.has(pointIndex) ? ({
      keypoint: pointIndex + 1, label, valid: true as const, valid_candidate_count: 12,
      cluster_support: 11, selected_samples: Array.from({ length: 11 }, (_, index) => `sample_${String(index + 1).padStart(2, '0')}`),
      x: 100 + pointIndex, y: 200 + pointIndex, activation: 0.7,
    }) : ({
      keypoint: pointIndex + 1, label, valid: false as const, valid_candidate_count: 0, cluster_support: 0 as const,
    })),
    consensus: {
      sample_count: 11 as const, semantic_support: 11, score: 8.2,
      corner_candidate_counts: [4, 4, 4, 4] as [number, number, number, number],
    },
  };

  it('accepts the eleven-position geometric-consensus schema and enforces sample order', () => {
    expect(tableAnalysisSchema.parse(v2Diagnostics).schema_version).toBe(2);
    expect(() => tableAnalysisSchema.parse({
      ...v2Diagnostics,
      sampling: v2Diagnostics.sampling.map((sample, index) => (
        index === 1 ? { ...sample, label: 'sample_11' } : sample
      )),
    })).toThrow();
  });

  it('keeps the native Core ML five-sample diagnostics compatible with Python schema v2', () => {
    const nativeDiagnostics = {
      schema_version: 2 as const,
      engine: 'coreml' as const,
      compute_units: 'cpuOnly' as const,
      checkpoint_sha256: 'a'.repeat(64),
      aggregation_rule: 'closest_valid_table_pair_mean' as const,
      sampling: ['first', '25_percent', '50_percent', '75_percent', 'last'].map((label, sampleIndex) => ({
        label,
        time: sampleIndex,
        frameIndex: sampleIndex * 60,
        points: Array.from({ length: 13 }, (_, pointIndex) => ({
          index: pointIndex,
          position: { x: 100 + pointIndex, y: 200 + pointIndex },
          activation: 0.7,
          valid: true,
        })),
      })),
    };

    expect(tableAnalysisSchema.parse(nativeDiagnostics)).toMatchObject({
      schema_version: 2,
      engine: 'coreml',
    });
  });
});
