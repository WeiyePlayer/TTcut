import { z } from 'zod';

export const DEVICE_VALUES = ['auto', 'cuda', 'cpu'] as const;
export const PRE_ROLL_VALUES = [1.5, 2.5, 5] as const;
export const POST_ROLL_VALUES = [0.5, 1, 2, 4] as const;
export const HIGHLIGHT_VALUES = [3, 5, 7] as const;

const finiteNumber = z.number().finite();
const point = z.tuple([finiteNumber, finiteNumber]);

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

export const analysisRequestSchema = z.object({
  schema_version: z.literal(1),
  task_id: z.string().uuid(),
  video_path: z.string().min(1),
  device: z.enum(DEVICE_VALUES),
  calibration: calibrationSchema,
}).strict();

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
  container: z.literal('mp4'),
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
}).strict();

const workerBase = z.object({
  task_id: z.string().uuid(),
});

export const workerEventSchema = z.discriminatedUnion('type', [
  workerBase.extend({
    type: z.literal('progress'),
    stage: z.enum(['probe', 'load_model', 'analysis', 'postprocess']),
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent: finiteNumber.min(0).max(100),
  }).strict(),
  workerBase.extend({
    type: z.literal('result'),
    data: analysisResultSchema,
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
    selected_rally_ids: z.array(z.string()).min(1),
    pre_roll_seconds: z.union(PRE_ROLL_VALUES.map((value) => z.literal(value))),
    post_roll_seconds: z.union(POST_ROLL_VALUES.map((value) => z.literal(value))),
  }).strict(),
]);

export const appSettingsSchema = z.object({
  language: z.enum(['zh-CN', 'en']),
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
}).strict();

export const historySummarySchema = z.object({
  schema_version: z.literal(1),
  id: z.string().uuid(),
  analyzed_at: z.string().min(1),
  video_name: z.string().min(1),
  rally_count: z.number().int().positive(),
  duration_seconds: finiteNumber.positive(),
  cover_url: z.string().min(1).nullable(),
  source_status: z.enum(['available', 'missing', 'changed']),
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
}).strict();

export type Calibration = z.infer<typeof calibrationSchema>;
export type AnalysisRequestV1 = z.infer<typeof analysisRequestSchema>;
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export type Rally = z.infer<typeof rallySchema>;
export type AnalysisResultV1 = z.infer<typeof analysisResultSchema>;
export type WorkerEventV1 = z.infer<typeof workerEventSchema>;
export type CutSelectionV1 = z.infer<typeof cutSelectionSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type HistorySource = z.infer<typeof historySourceSchema>;
export type HistoryRecordV1 = z.infer<typeof historyRecordSchema>;
export type HistorySummaryV1 = z.infer<typeof historySummarySchema>;
export type ComponentStatus = z.infer<typeof componentStatusSchema>;
export type ManagedComponentOffer = z.infer<typeof managedComponentOfferSchema>;
export type ComponentSetupInfo = z.infer<typeof componentSetupInfoSchema>;

export type CutGroup = {
  rallyIds: string[];
  rawStart: number;
  rawEnd: number;
  start: number;
  end: number;
};

export type TaskProgress = {
  taskId: string;
  kind: 'analysis' | 'export' | 'setup';
  stage: string;
  percent: number;
  current?: number;
  total?: number;
};

export type ExportResult = {
  taskId: string;
  outputPath: string;
  outputName: string;
  mediaUrl: string;
};
