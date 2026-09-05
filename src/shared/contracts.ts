import { z } from 'zod';

export const DEVICE_VALUES = ['auto', 'cuda', 'cpu'] as const;
export const PRE_ROLL_VALUES = [1.5, 2.5, 5] as const;
export const POST_ROLL_VALUES = [0.5, 1, 2, 4] as const;
export const HIGHLIGHT_VALUES = [3, 5, 7] as const;
export const BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT = 0.7;
export const BLURBALL_STAGE1_CONFIDENCE_THRESHOLD_DEFAULT = 0.3;
export const BLURBALL_CONFIDENCE_THRESHOLD_MIN = 0.1;
export const BLURBALL_CONFIDENCE_THRESHOLD_MAX = 0.95;
export const BLURBALL_CONFIDENCE_THRESHOLD_STEP = 0.05;
export const BLURBALL_ANALYSIS_MODE_VALUES = ['full', 'two_stage'] as const;
export const BLURBALL_ANALYSIS_MODE_DEFAULT = 'full' as const;
export const BLURBALL_REFINEMENT_EXPANSION_SECONDS = 0.75;
export const RALLY_RECOGNITION_METHOD_VALUES = ['bounce_events', 'continuous_visibility'] as const;
export const RALLY_RECOGNITION_METHOD_DEFAULT = 'bounce_events' as const;
export const DURATION_HIGHLIGHT_TIER_VALUES = ['short_rally', 'rally', 'long_rally'] as const;
export const DURATION_HIGHLIGHT_SECONDS = {
  short_rally: 2.7,
  rally: 4,
  long_rally: 4.8,
} as const;
export const BALL_MODEL_PROFILE_VALUES = ['tracknet_v1', 'blurball_v1'] as const;
const LEGACY_RESULT_MODEL_PROFILES = BALL_MODEL_PROFILE_VALUES;

const finiteNumber = z.number().finite();
const point = z.tuple([finiteNumber, finiteNumber]);
const tableSampleLabelSchema = z.enum(['first', '25_percent', '50_percent', '75_percent', 'last']);
const tableKeypointLabelSchema = z.enum([
  'close_left',
  'close_right',
  'center_left',
  'center_right',
  'far_left',
  'far_right',
  'net_left_bottom',
  'net_right_bottom',
  'net_center_bottom',
  'net_left_top',
  'net_right_top',
  'close_center',
  'far_center',
]);

const tableSampleKeypointSchema = z.object({
  keypoint: z.number().int().min(1).max(13),
  label: tableKeypointLabelSchema,
  x: finiteNumber,
  y: finiteNumber,
  activation: finiteNumber,
  valid: z.boolean(),
}).strict();

const tableSampleSchema = z.object({
  label: tableSampleLabelSchema,
  frame_index: z.number().int().nonnegative(),
  time_seconds: finiteNumber.nonnegative(),
  target_frame_index: z.number().int().nonnegative().nullable().optional(),
  target_time_seconds: finiteNumber.nonnegative().optional(),
  seek_method: z.enum(['frame', 'time']).optional(),
  position_error_seconds: finiteNumber.nonnegative().optional(),
  forward_seconds: finiteNumber.nonnegative(),
  keypoints: z.array(tableSampleKeypointSchema).length(13),
}).strict();

const fixedTableKeypointSchema = z.discriminatedUnion('valid', [
  z.object({
    keypoint: z.number().int().min(1).max(13),
    label: tableKeypointLabelSchema,
    valid: z.literal(false),
    valid_candidate_count: z.number().int().min(0).max(1),
  }).strict(),
  z.object({
    keypoint: z.number().int().min(1).max(13),
    label: tableKeypointLabelSchema,
    valid: z.literal(true),
    valid_candidate_count: z.number().int().min(2).max(5),
    selected_samples: z.tuple([tableSampleLabelSchema, tableSampleLabelSchema]),
    pair_distance_pixels: finiteNumber.nonnegative(),
    x: finiteNumber,
    y: finiteNumber,
    activation: finiteNumber,
  }).strict(),
]);

export const tableAnalysisSchema = z.object({
  schema_version: z.literal(1),
  model: z.object({
    id: z.literal('table_analyze'),
    filename: z.literal('table_analyze.pt'),
    checkpoint_identifier: z.string().min(1),
  }).strict(),
  device: z.enum(['cpu', 'cuda']),
  model_load_seconds: finiteNumber.nonnegative(),
  video_info: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: finiteNumber.positive(),
    metadata_frame_count: z.number().int().nonnegative(),
    decoded_frame_count: z.number().int().positive(),
    duration_seconds: finiteNumber.positive(),
    sampling_seconds: finiteNumber.nonnegative().optional(),
    seek_count: z.number().int().nonnegative().optional(),
    copied_frame_count: z.number().int().nonnegative().optional(),
  }).strict(),
  sampling: z.array(tableSampleSchema).length(5).superRefine((samples, context) => {
    const expected = ['first', '25_percent', '50_percent', '75_percent', 'last'];
    samples.forEach((sample, index) => {
      if (sample.label !== expected[index]) context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'label'],
        message: 'Table samples must use the fixed five-frame order.',
      });
    });
  }),
  aggregation_rule: z.literal('closest_valid_pair_mean'),
  fixed_keypoints: z.array(fixedTableKeypointSchema).length(13),
}).strict();

export const calibrationSchema = z.object({
  video_width: z.number().int().positive(),
  video_height: z.number().int().positive(),
  points: z.object({
    top_left: point,
    top_right: point,
    bottom_right: point,
    bottom_left: point,
  }).strict(),
}).strict();

export const calibrationChoiceSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('manual'), calibration: calibrationSchema }).strict(),
  z.object({ method: z.literal('automatic') }).strict(),
  z.object({ method: z.literal('precalibrated'), calibration: calibrationSchema, table_analysis: tableAnalysisSchema.optional() }).strict(),
]);

const analysisVideoMetadataSchema = z.object({
  duration_seconds: finiteNumber.positive(),
  fps: finiteNumber.positive(),
  frame_count: z.number().int().positive().nullable(),
  variable_frame_rate: z.boolean(),
}).strict();

export const analysisRequestV1Schema = z.object({
  schema_version: z.literal(1),
  task_id: z.string().uuid(),
  video_path: z.string().min(1),
  device: z.enum(DEVICE_VALUES),
  video_metadata: analysisVideoMetadataSchema,
  calibration_choice: calibrationChoiceSchema,
  blurball_confidence_threshold: finiteNumber
    .min(BLURBALL_CONFIDENCE_THRESHOLD_MIN)
    .max(BLURBALL_CONFIDENCE_THRESHOLD_MAX)
    .default(BLURBALL_CONFIDENCE_THRESHOLD_DEFAULT),
}).strict();

const blurballFullAnalysisConfigSchema = z.object({
  mode: z.literal('full'),
  confidence_threshold: finiteNumber
    .min(BLURBALL_CONFIDENCE_THRESHOLD_MIN)
    .max(BLURBALL_CONFIDENCE_THRESHOLD_MAX),
}).strict();

const blurballTwoStageAnalysisConfigSchema = z.object({
  mode: z.literal('two_stage'),
  stage1_confidence_threshold: finiteNumber
    .min(BLURBALL_CONFIDENCE_THRESHOLD_MIN)
    .max(BLURBALL_CONFIDENCE_THRESHOLD_MAX),
  stage2_confidence_threshold: finiteNumber
    .min(BLURBALL_CONFIDENCE_THRESHOLD_MIN)
    .max(BLURBALL_CONFIDENCE_THRESHOLD_MAX),
}).strict();

export const blurballAnalysisConfigSchema = z.discriminatedUnion('mode', [
  blurballFullAnalysisConfigSchema,
  blurballTwoStageAnalysisConfigSchema,
]);

export const rallyRecognitionConfigSchema = z.object({
  method: z.enum(RALLY_RECOGNITION_METHOD_VALUES),
}).strict();

export const analysisRequestV2Schema = z.object({
  schema_version: z.literal(2),
  task_id: z.string().uuid(),
  video_path: z.string().min(1),
  device: z.enum(DEVICE_VALUES),
  video_metadata: analysisVideoMetadataSchema,
  calibration_choice: calibrationChoiceSchema,
  analysis: blurballAnalysisConfigSchema,
}).strict();

export const analysisRequestV3Schema = analysisRequestV2Schema.extend({
  schema_version: z.literal(3),
  rally_recognition: rallyRecognitionConfigSchema,
}).strict();

// Schema v4 is intentionally only emitted by a local development run when a
// TrackNet test weight has been configured outside the application package.
export const analysisRequestV4Schema = analysisRequestV3Schema.extend({
  schema_version: z.literal(4),
  ball_model_profile: z.enum(BALL_MODEL_PROFILE_VALUES),
}).strict();

export const analysisRequestSchema = z.union([
  analysisRequestV1Schema,
  analysisRequestV2Schema,
  analysisRequestV3Schema,
  analysisRequestV4Schema,
]);

export const videoMetadataSchema = z.object({
  path: z.string().min(1),
  duration_seconds: finiteNumber.nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: finiteNumber.positive(),
  nominal_fps: finiteNumber.positive().nullable().optional(),
  average_fps_ratio: z.string().regex(/^\d+\/\d+$/).nullable().optional(),
  nominal_fps_ratio: z.string().regex(/^\d+\/\d+$/).nullable().optional(),
  variable_frame_rate: z.boolean(),
  video_codec: z.string().min(1),
  audio_codec: z.string().nullable(),
  container: z.enum(['mp4', 'mov']),
  frame_count: z.number().int().positive().nullable().optional(),
  average_bitrate: z.number().int().positive().nullable().optional(),
  audio_bitrate: z.number().int().positive().nullable().optional(),
  pixel_format: z.string().nullable().optional(),
  audio_sample_rate: z.number().int().positive().nullable().optional(),
  audio_channels: z.number().int().positive().nullable().optional(),
  video_duration_seconds: finiteNumber.positive().nullable().optional(),
  audio_duration_seconds: finiteNumber.positive().nullable().optional(),
  video_start_time_seconds: finiteNumber.nullable().optional(),
  audio_start_time_seconds: finiteNumber.nullable().optional(),
  video_time_base: z.string().nullable().optional(),
  audio_time_base: z.string().nullable().optional(),
  rotation: finiteNumber.nullable().optional(),
  sample_aspect_ratio: z.string().nullable().optional(),
  display_aspect_ratio: z.string().nullable().optional(),
  color_range: z.string().nullable().optional(),
  color_space: z.string().nullable().optional(),
  color_transfer: z.string().nullable().optional(),
  color_primaries: z.string().nullable().optional(),
}).strict();

export const bounceRallySchema = z.object({
  id: z.string().regex(/^rally_\d{3,}$/),
  index: z.number().int().positive(),
  bounce_count: z.number().int().positive(),
  start_time_seconds: finiteNumber.nonnegative(),
  end_time_seconds: finiteNumber.positive(),
}).strict().refine(
  (rally) => rally.end_time_seconds > rally.start_time_seconds,
  { message: 'Rally end time must be after start time' },
);

export const continuousVisibilityRallySchema = z.object({
  id: z.string().regex(/^rally_\d{3,}$/),
  index: z.number().int().positive(),
  start_time_seconds: finiteNumber.nonnegative(),
  end_time_seconds: finiteNumber.positive(),
  lead_in_start_time_seconds: finiteNumber.nonnegative().optional(),
}).strict().refine(
  (rally) => rally.end_time_seconds > rally.start_time_seconds,
  { message: 'Rally end time must be after start time' },
).refine(
  (rally) => rally.lead_in_start_time_seconds === undefined
    || rally.lead_in_start_time_seconds <= rally.start_time_seconds,
  { message: 'Rally lead-in must not start after the rally' },
);

export const rallySchema = z.union([bounceRallySchema, continuousVisibilityRallySchema]);

const analysisResultBaseSchema = z.object({
  video: videoMetadataSchema,
  source_video: videoMetadataSchema.optional(),
  processing: z.object({
    mode: z.enum(['source_cfr', 'normalized_cfr', 'original_vfr', 'vfr_fallback']),
    target_fps_ratio: z.string().regex(/^\d+\/\d+$/).nullable(),
    encoder: z.enum(['libopenh264', 'libx264']).nullable(),
    warning_code: z.string().min(1).nullable(),
  }).strict().optional(),
  calibration: calibrationSchema.optional(),
  table_analysis: tableAnalysisSchema.optional(),
  model_provenance: z.object({
    // TrackNet remains readable for legacy history and explicit local development analyses.
    profile: z.enum(LEGACY_RESULT_MODEL_PROFILES),
    component_version: z.string().min(1).nullable(),
    roi: z.object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict(),
    main_input: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    aux_input: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().nullable(),
    detection: z.object({
      confidence_threshold: finiteNumber.min(0).max(1),
      step: z.union([z.literal(1), z.literal(3)]),
      maximum_displacement_pixels: finiteNumber.positive(),
      landing_region: z.literal('expanded_table'),
    }).strict().optional(),
    analysis: z.object({
      schema_version: z.literal(2),
      mode: z.enum(BLURBALL_ANALYSIS_MODE_VALUES),
      interval_expansion_seconds: finiteNumber.nonnegative().optional(),
      stages: z.array(z.object({
        name: z.enum(['full', 'candidate', 'refinement']),
        confidence_threshold: finiteNumber.min(0).max(1),
        window_size: z.literal(3),
        window_stride: z.union([z.literal(1), z.literal(3)]),
        retained_output: z.enum(['all_window_frames', 'center_frame']),
      }).strict()).min(1),
    }).strict().optional(),
    tracknet: z.object({
      confidence_threshold: finiteNumber.min(0).max(1),
      roi_model_scale: finiteNumber.positive(),
      inference_seconds: finiteNumber.nonnegative(),
      predictor_seconds: finiteNumber.nonnegative(),
      detected_frames: z.number().int().nonnegative(),
      missing_frames: z.number().int().nonnegative(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

export const legacyAnalysisResultV1Schema = analysisResultBaseSchema.extend({
  schema_version: z.literal(1),
  rallies: z.array(bounceRallySchema),
  bounce_times_seconds: z.array(finiteNumber.nonnegative()).optional(),
}).strict();

export const bounceAnalysisResultV2Schema = analysisResultBaseSchema.extend({
  schema_version: z.literal(2),
  rallies: z.array(bounceRallySchema),
  bounce_times_seconds: z.array(finiteNumber.nonnegative()),
  rally_recognition: z.object({
    method: z.literal('bounce_events'),
    maximum_gap_seconds: finiteNumber.nonnegative(),
    minimum_bounce_count: z.number().int().positive(),
  }).strict(),
}).strict();

export const continuousVisibilityAnalysisResultV2Schema = analysisResultBaseSchema.extend({
  schema_version: z.literal(2),
  rallies: z.array(continuousVisibilityRallySchema),
  rally_recognition: z.object({
    method: z.literal('continuous_visibility'),
    detection_confidence_threshold: finiteNumber.nonnegative().max(1).optional(),
    start_visible_seconds: finiteNumber.positive(),
    end_invisible_seconds: finiteNumber.positive(),
    motion_filter: z.object({
      minimum_horizontal_excursion_ratio: finiteNumber.positive(),
      maximum_reversal_gap_seconds: finiteNumber.positive(),
      minimum_horizontal_to_vertical_range_ratio: finiteNumber.positive(),
      maximum_monotonic_vertical_reversals: z.number().int().nonnegative(),
      minimum_monotonic_horizontal_range_ratio: finiteNumber.positive(),
      minimum_monotonic_duration_seconds: finiteNumber.positive().optional(),
      short_vertical_filter_seconds: finiteNumber.positive().optional(),
      maximum_short_vertical_range_ratio: finiteNumber.positive().optional(),
      vertical_exchange_enabled: z.boolean().optional(),
      minimum_vertical_to_horizontal_range_ratio: finiteNumber.positive().optional(),
      end_on_min_opposing_edge_balance: finiteNumber.positive().max(1).optional(),
      end_on_min_screen_aspect_ratio: finiteNumber.positive().optional(),
    }).strict().optional(),
    fragment_bridge: z.object({
      maximum_gap_seconds: finiteNumber.positive(),
      maximum_boundary_displacement_ratio: finiteNumber.positive(),
      maximum_boundary_speed_ratio_per_second: finiteNumber.positive(),
    }).strict().optional(),
    tracknet_filter: z.object({
      minimum_rally_seconds: finiteNumber.positive(),
      strong_evidence_minimum_rally_seconds: finiteNumber.positive().optional(),
      strong_evidence_minimum_expanded_table_ratio: finiteNumber.min(0).max(1).optional(),
      minimum_horizontal_run_reversals: z.number().int().positive(),
      short_rally_seconds: finiteNumber.positive(),
      minimum_short_rally_expanded_table_ratio: finiteNumber.min(0).max(1),
      expanded_table_length_margin_cm: finiteNumber.nonnegative(),
      expanded_table_width_margin_cm: finiteNumber.nonnegative(),
      reliable_fragment_bridge_seconds: finiteNumber.positive(),
    }).strict().optional(),
    inter_rally_fragment_filter: z.object({
      side_on_views_only: z.boolean(),
      minimum_candidate_seconds: finiteNumber.positive(),
      maximum_candidate_seconds: finiteNumber.positive(),
      maximum_expanded_table_ratio: finiteNumber.min(0).max(1),
      minimum_visible_run_count: z.number().int().positive(),
      minimum_one_way_range_ratio: finiteNumber.positive(),
      maximum_sparse_visibility_ratio: finiteNumber.min(0).max(1),
      minimum_contiguous_flight_seconds: finiteNumber.positive(),
      minimum_coherent_reversal_ratio: finiteNumber.positive(),
      minimum_coherent_flight_displacement_ratio: finiteNumber.positive(),
      expanded_table_length_margin_cm: finiteNumber.nonnegative(),
      expanded_table_width_margin_cm: finiteNumber.nonnegative(),
      motion_refinement: z.object({
        version: z.union([z.literal(2), z.literal(3)]),
        minimum_motion_run_seconds: finiteNumber.positive(),
        minimum_horizontal_range_ratio: finiteNumber.positive(),
        minimum_speed_ratio_per_second: finiteNumber.positive(),
        reversal_range_ratio: finiteNumber.positive(),
        gap_minimum_motion_range_ratio: finiteNumber.positive(),
        gap_minimum_motion_support_ratio: finiteNumber.min(0).max(1),
        short_gap_seconds: finiteNumber.positive(),
        long_gap_seconds: finiteNumber.positive(),
        stationary_run_seconds: finiteNumber.positive(),
        boundary_context_seconds: finiteNumber.nonnegative(),
      }).strict().optional(),
      long_candidate_segmentation: z.object({
        minimum_candidate_seconds: finiteNumber.positive(),
        minimum_motion_run_seconds: finiteNumber.positive(),
        minimum_motion_run_horizontal_range_ratio: finiteNumber.positive(),
        short_gap_seconds: finiteNumber.positive(),
        long_gap_seconds: finiteNumber.positive(),
        minimum_visible_gap_ratio: finiteNumber.min(0).max(1),
        minimum_stationary_run_seconds: finiteNumber.positive(),
        boundary_context_seconds: finiteNumber.nonnegative(),
        leading_pass_minimum_motion_seconds: finiteNumber.positive(),
        leading_pass_minimum_run_count: z.number().int().positive(),
        leading_pass_maximum_expanded_table_ratio: finiteNumber.min(0).max(1),
        internal_transfer_minimum_motion_seconds: finiteNumber.positive(),
        internal_transfer_minimum_strict_table_ratio: finiteNumber.min(0).max(1),
      }).strict().optional(),
    }).strict().optional(),
  }).strict(),
}).strict();

export const analysisResultSchema = z.union([
  legacyAnalysisResultV1Schema,
  bounceAnalysisResultV2Schema,
  continuousVisibilityAnalysisResultV2Schema,
]);

export const calibrationResultSchema = z.object({
  calibration: calibrationSchema,
  table_analysis: tableAnalysisSchema,
}).strict();

const workerBase = z.object({
  task_id: z.string().uuid(),
});

export const workerEventSchema = z.discriminatedUnion('type', [
  workerBase.extend({
    type: z.literal('progress'),
    stage: z.enum(['probe', 'table_sampling', 'table_model', 'table_inference', 'load_model', 'analysis', 'candidate_analysis', 'interval_union', 'refinement_analysis', 'postprocess']),
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent: finiteNumber.min(0).max(100),
  }).strict(),
  workerBase.extend({
    type: z.literal('result'),
    data: z.union([analysisResultSchema, calibrationResultSchema]),
  }).strict(),
  workerBase.extend({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean(),
    log_path: z.string().min(1).optional(),
  }).strict(),
]);

const customExportSegmentTimingSchema = z.object({
  start_time_seconds: finiteNumber.nonnegative(),
  end_time_seconds: finiteNumber.positive(),
});

export const customExportSegmentSchema = z.discriminatedUnion('source', [
  customExportSegmentTimingSchema.extend({
    clip_id: z.string().min(1),
    source: z.literal('detected'),
    rally_id: z.string().min(1),
    display_index: z.number().int().positive(),
  }).strict(),
  customExportSegmentTimingSchema.extend({
    clip_id: z.string().min(1),
    source: z.literal('manual'),
    display_index: z.number().int().positive(),
  }).strict(),
]);

export const legacyCustomExportSegmentSchema = customExportSegmentTimingSchema.extend({
  rally_id: z.string().min(1),
}).strict();

export const customExportSegmentInputSchema = z.union([
  customExportSegmentSchema,
  legacyCustomExportSegmentSchema,
]);

const allCutSelectionSchema = z.object({
    mode: z.literal('all'),
    pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
    post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  }).strict();

const legacyHighlightCutSelectionSchema = z.object({
    mode: z.literal('highlight'),
    highlight_threshold: z.union(HIGHLIGHT_VALUES.map((value) => z.literal(value))),
    pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
    post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  }).strict();

const highlightCutSelectionSchema = z.object({
    mode: z.literal('highlight'),
    criterion: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('bounce_count'),
        threshold: z.union(HIGHLIGHT_VALUES.map((value) => z.literal(value))),
      }).strict(),
      z.object({
        kind: z.literal('duration_tier'),
        tier: z.enum(DURATION_HIGHLIGHT_TIER_VALUES),
      }).strict(),
    ]),
    pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
    post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  }).strict();

const customCutSelectionSchema = z.object({
    mode: z.literal('custom'),
    segments: z.array(customExportSegmentInputSchema).min(1),
  }).strict();

export const cutSelectionSchema = z.union([
  allCutSelectionSchema,
  legacyHighlightCutSelectionSchema,
  highlightCutSelectionSchema,
  customCutSelectionSchema,
]);

export const appSettingsSchema = z.object({
  language: z.enum(['zh-CN', 'en']),
  calibration_method: z.enum(['manual', 'automatic']),
  pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
  post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  analysis_mode: z.enum(BLURBALL_ANALYSIS_MODE_VALUES).default(BLURBALL_ANALYSIS_MODE_DEFAULT),
  rally_recognition_method: z.enum(RALLY_RECOGNITION_METHOD_VALUES).default(RALLY_RECOGNITION_METHOD_DEFAULT),
  normalize_variable_frame_rate: z.boolean().default(false),
}).strict();

export const historySourceSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().positive(),
  modified_time_ms: finiteNumber.nonnegative(),
}).strict();

export const historyRecordSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().uuid(),
  analyzed_at: z.string().min(1),
  source: historySourceSchema,
  calibration: calibrationSchema,
  analysis: analysisResultSchema,
  visible_in_history: z.boolean().default(true),
  completion_kind: z.enum(['analysis', 'export']).default('analysis'),
  output_path: z.string().min(1).nullable().default(null),
}).strict();

export const historySummarySchema = z.object({
  schema_version: z.literal(1),
  id: z.string().uuid(),
  analyzed_at: z.string().min(1),
  video_name: z.string().min(1),
  rally_count: z.number().int().nonnegative(),
  duration_seconds: finiteNumber.positive(),
  cover_url: z.string().min(1).nullable(),
  source_status: z.enum(['available', 'missing', 'changed']),
  completion_kind: z.enum(['analysis', 'export']).default('analysis'),
  output_path: z.string().min(1).nullable().default(null),
}).strict();

export const exportRequestSchema = z.object({
  analysis_id: z.string().uuid(),
  selection: cutSelectionSchema,
  destination: z.enum(['prompt', 'source']),
  mode_label: z.string().min(1).optional(),
  outputs: z.object({
    combined_video: z.boolean(),
    rally_videos: z.boolean(),
    premiere_xml: z.boolean(),
  }).strict().optional(),
}).strict().superRefine((request, context) => {
  const outputs = request.outputs;
  if (!outputs) return;
  if (!outputs.combined_video && !outputs.rally_videos && !outputs.premiere_xml) {
    context.addIssue({ code: 'custom', message: 'At least one export output is required', path: ['outputs'] });
  }
  if (outputs.combined_video && (outputs.rally_videos || outputs.premiere_xml)) {
    context.addIssue({ code: 'custom', message: 'Combined video cannot be requested with custom artifacts', path: ['outputs'] });
  }
  if (request.selection.mode !== 'custom' && (!outputs.combined_video || outputs.rally_videos || outputs.premiere_xml)) {
    context.addIssue({ code: 'custom', message: 'Custom artifacts require custom selection', path: ['outputs'] });
  }
});

export const updateStateSchema = z.object({
  status: z.enum(['idle', 'unsupported', 'checking', 'available', 'downloaded', 'up-to-date', 'error']),
  version: z.string().min(1).nullable(),
  message: z.string().nullable(),
}).strict();

export const componentStatusSchema = z.object({
  analysis: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    path: z.string().nullable(),
    acceleration: z.enum(['cuda', 'cpu', 'unavailable']),
    detail: z.string().nullable(),
  }).strict(),
  media: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    path: z.string().nullable(),
    active_encoder: z.enum(['libopenh264', 'libx264', 'unavailable']),
    x264_available: z.boolean(),
    detail: z.string().nullable(),
  }).strict(),
}).strict();

export const managedComponentOfferSchema = z.object({
  id: z.enum(['analysis', 'media']),
  version: z.string().min(1),
  download_size_bytes: z.number().int().positive(),
  license_url: z.string().url(),
  available_for_download: z.boolean(),
}).strict();

export const componentSetupInfoSchema = z.object({
  analysis_offer: managedComponentOfferSchema.nullable(),
  media_offer: managedComponentOfferSchema.nullable(),
  x264_manual_offer: z.object({
    id: z.literal('media-x264'),
    version: z.string().min(1),
    filename: z.string().endsWith('.zip'),
    download_size_bytes: z.number().int().positive(),
    license_url: z.string().url(),
  }).strict(),
}).strict();

export const platformCompatibilitySchema = z.object({
  status: z.enum(['supported', 'unsupported']),
  reason: z.enum([
    'supported',
    'unsupported_platform',
    'unsupported_architecture',
    'unsupported_windows_build',
    'windows_server',
    'probe_failed',
  ]),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  build_number: z.number().int().positive().nullable(),
  installation_type: z.enum(['Client', 'Server', 'Unknown']),
}).strict();

export type Calibration = z.infer<typeof calibrationSchema>;
export type CalibrationChoice = z.infer<typeof calibrationChoiceSchema>;
export type TableAnalysis = z.infer<typeof tableAnalysisSchema>;
export type BallModelProfile = typeof BALL_MODEL_PROFILE_VALUES[number];
export type AnalysisRequestV1 = z.infer<typeof analysisRequestV1Schema>;
export type AnalysisRequestV2 = z.infer<typeof analysisRequestV2Schema>;
export type AnalysisRequestV3 = z.infer<typeof analysisRequestV3Schema>;
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export type BlurBallAnalysisConfig = z.infer<typeof blurballAnalysisConfigSchema>;
export type BlurBallAnalysisMode = typeof BLURBALL_ANALYSIS_MODE_VALUES[number];
export type RallyRecognitionConfig = z.infer<typeof rallyRecognitionConfigSchema>;
export type RallyRecognitionMethod = typeof RALLY_RECOGNITION_METHOD_VALUES[number];
export type DurationHighlightTier = typeof DURATION_HIGHLIGHT_TIER_VALUES[number];
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export type Rally = z.infer<typeof rallySchema>;
export type BounceRally = z.infer<typeof bounceRallySchema>;
export type ContinuousVisibilityRally = z.infer<typeof continuousVisibilityRallySchema>;
export type AnalysisResultV1 = z.infer<typeof analysisResultSchema>;
export type AnalysisResult = AnalysisResultV1;
export type LegacyAnalysisResultV1 = z.infer<typeof legacyAnalysisResultV1Schema>;
export type BounceAnalysisResultV2 = z.infer<typeof bounceAnalysisResultV2Schema>;
export type ContinuousVisibilityAnalysisResultV2 = z.infer<typeof continuousVisibilityAnalysisResultV2Schema>;
export type BounceAnalysisResult = LegacyAnalysisResultV1 | BounceAnalysisResultV2;

export function rallyRecognitionMethod(result: AnalysisResultV1): RallyRecognitionMethod {
  return result.schema_version === 2 ? result.rally_recognition.method : RALLY_RECOGNITION_METHOD_DEFAULT;
}

export function hasBounceCounts(result: AnalysisResultV1): result is BounceAnalysisResult {
  return rallyRecognitionMethod(result) === 'bounce_events';
}
export type CalibrationResultV1 = z.infer<typeof calibrationResultSchema>;
export type WorkerEventV1 = z.infer<typeof workerEventSchema>;
export type CutSelectionV1 = z.infer<typeof cutSelectionSchema>;
export type CustomExportSegment = z.infer<typeof customExportSegmentSchema>;
export type LegacyCustomExportSegment = z.infer<typeof legacyCustomExportSegmentSchema>;
export type CustomExportSegmentInput = z.infer<typeof customExportSegmentInputSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type HistorySource = z.infer<typeof historySourceSchema>;
export type HistoryRecordV1 = z.infer<typeof historyRecordSchema>;
export type HistorySummaryV1 = z.infer<typeof historySummarySchema>;
export type ComponentStatus = z.infer<typeof componentStatusSchema>;
export type ManagedComponentOffer = z.infer<typeof managedComponentOfferSchema>;
export type ComponentSetupInfo = z.infer<typeof componentSetupInfoSchema>;
export type PlatformCompatibility = z.infer<typeof platformCompatibilitySchema>;
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type UpdateState = z.infer<typeof updateStateSchema>;

export type CutGroup = {
  rallyIds: string[];
  rawStart: number;
  rawEnd: number;
  start: number;
  end: number;
};

export type TaskProgress = {
  taskId: string;
  kind: 'analysis' | 'calibration' | 'export' | 'setup';
  stage: string;
  percent: number;
  current?: number;
  total?: number;
};

export type ExportTimingInfo = {
  targetSeconds: number;
  actualSeconds: number;
  driftSeconds: number;
  allowedDriftSeconds: number;
  segmentCount: number;
};

export type ExportWarning = {
  code: string;
  message: string;
};

export type CombinedVideoExportResult = {
  kind?: 'combined-video';
  taskId: string;
  analysisId: string;
  outputPath: string;
  outputName: string;
  mediaUrl: string;
  timing: ExportTimingInfo;
  warning?: ExportWarning;
};

export type CustomArtifactFailure = {
  clipId?: string;
  rallyId?: string;
  rallyIndex?: number;
  code: string;
  message: string;
};

export type CustomArtifactExportResult = {
  kind: 'custom-artifacts';
  taskId: string;
  analysisId: string;
  outputDirectory: string;
  partialSuccess: boolean;
  rallyVideos: Array<{
    clipId: string;
    rallyId?: string;
    rallyIndex: number;
    outputPath: string;
  }>;
  failedRallies: CustomArtifactFailure[];
  premiereXml: {
    outputPath: string;
    quantizedForVfr: boolean;
  } | null;
  xmlFailure: CustomArtifactFailure | null;
};

export type ExportResult = CombinedVideoExportResult | CustomArtifactExportResult;
