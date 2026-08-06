import { z } from 'zod';

export const DEVICE_VALUES = ['auto', 'cuda', 'cpu'] as const;
export const PRE_ROLL_VALUES = [1.5, 2.5, 5] as const;
export const POST_ROLL_VALUES = [0.5, 1, 2, 4] as const;
export const HIGHLIGHT_VALUES = [3, 5, 7] as const;
export const BALL_MODEL_PROFILES = ['tracknet_v1', 'uplifting_dual_v1'] as const;

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
}).strict();

export const analysisRequestV2Schema = z.object({
  schema_version: z.literal(2),
  task_id: z.string().uuid(),
  video_path: z.string().min(1),
  device: z.enum(DEVICE_VALUES),
  ball_model_profile: z.enum(BALL_MODEL_PROFILES),
  video_metadata: analysisVideoMetadataSchema,
  calibration_choice: calibrationChoiceSchema,
}).strict();

export const analysisRequestSchema = z.union([analysisRequestV1Schema, analysisRequestV2Schema]);

export const videoMetadataSchema = z.object({
  path: z.string().min(1),
  duration_seconds: finiteNumber.nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: finiteNumber.positive(),
  nominal_fps: finiteNumber.positive().nullable().optional(),
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

export const rallySchema = z.object({
  id: z.string().regex(/^rally_\d{3,}$/),
  index: z.number().int().positive(),
  bounce_count: z.number().int().positive(),
  start_time_seconds: finiteNumber.nonnegative(),
  end_time_seconds: finiteNumber.positive(),
}).strict().refine(
  (rally) => rally.end_time_seconds > rally.start_time_seconds,
  { message: 'Rally end time must be after start time' },
);

export const analysisResultSchema = z.object({
  schema_version: z.literal(1),
  video: videoMetadataSchema,
  rallies: z.array(rallySchema),
  calibration: calibrationSchema.optional(),
  table_analysis: tableAnalysisSchema.optional(),
  model_provenance: z.object({
    profile: z.enum(BALL_MODEL_PROFILES),
    component_version: z.string().min(1).nullable(),
    roi: z.object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict(),
    main_input: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
    aux_input: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().nullable(),
  }).strict().optional(),
}).strict();

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
    stage: z.enum(['probe', 'table_sampling', 'table_model', 'table_inference', 'load_model', 'analysis', 'postprocess']),
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

export const cutSelectionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('all'),
    pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
    post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  }).strict(),
  z.object({
    mode: z.literal('highlight'),
    highlight_threshold: z.union(HIGHLIGHT_VALUES.map((value) => z.literal(value))),
    pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
    post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  }).strict(),
  z.object({
    mode: z.literal('custom'),
    segments: z.array(z.object({
      rally_id: z.string().min(1),
      start_time_seconds: finiteNumber.nonnegative(),
      end_time_seconds: finiteNumber.positive(),
    }).strict()).min(1),
  }).strict(),
]);

export const appSettingsSchema = z.object({
  language: z.enum(['zh-CN', 'en']),
  calibration_method: z.enum(['manual', 'automatic']),
  ball_model_profile: z.enum(BALL_MODEL_PROFILES),
  pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
  post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
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
}).strict();

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
  dual_ball_models: z.object({
    available: z.boolean(),
    version: z.string().nullable(),
    path: z.string().nullable(),
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
  dual_ball_models_offer: z.object({
    id: z.literal('dual_ball_models'),
    version: z.string().min(1),
    download_size_bytes: z.number().int().positive(),
    available_for_download: z.boolean(),
  }).strict().nullable(),
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
export type BallModelProfile = typeof BALL_MODEL_PROFILES[number];
export type AnalysisRequestV1 = z.infer<typeof analysisRequestV1Schema>;
export type AnalysisRequestV2 = z.infer<typeof analysisRequestV2Schema>;
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export type Rally = z.infer<typeof rallySchema>;
export type AnalysisResultV1 = z.infer<typeof analysisResultSchema>;
export type CalibrationResultV1 = z.infer<typeof calibrationResultSchema>;
export type WorkerEventV1 = z.infer<typeof workerEventSchema>;
export type CutSelectionV1 = z.infer<typeof cutSelectionSchema>;
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

export type ExportResult = {
  taskId: string;
  analysisId: string;
  outputPath: string;
  outputName: string;
  mediaUrl: string;
  timing: ExportTimingInfo;
  warning?: ExportWarning;
};
