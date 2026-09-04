import { z } from 'zod';
const number = z.number().finite();
const positive = number.positive();
export const nativePointSchema = z.object({ x: number, y: number }).strict();
export const nativeCalibrationSchema = z.object({ width: positive.int(), height: positive.int(), points: z.array(nativePointSchema).length(4) }).strict();
export const nativeVideoSchema = z.object({
  path: z.string().min(1), width: positive.int(), height: positive.int(), duration: positive,
  fps: positive, nominalFPS: positive, frameRate: z.string().regex(/^\d+\/\d+$/), frameCount: positive.int().optional(),
  variableFrameRate: z.boolean(), videoCodec: z.string(), profile: z.string(), pixelFormat: z.string(),
  bitDepth: positive.int(), chroma: z.string(), videoTimeBase: z.string(), videoStart: number, videoDuration: positive.optional(),
  audioCodec: z.string().optional(), audioChannels: number.int().nonnegative(), audioSampleRate: positive.int(),
  audioTimeBase: z.string(), audioStart: number, audioDuration: positive.optional(), audioBitrate: number.int().nonnegative(),
  bitrate: number.int().nonnegative(), sar: z.string(), rotation: number.int(),
  colorRange: z.string().optional(), colorPrimaries: z.string().optional(), colorTransfer: z.string().optional(), colorSpace: z.string().optional(),
  hdr: z.enum(['sdr', 'hdr10', 'hlg', 'dolbyVision', 'hdr10Plus']), masteringDisplay: z.string().optional(), maxCLL: z.string().optional(),
  keyframes: z.array(number), audioBoundaries: z.array(number),
}).strict();
export const nativeTableSampleSchema = z.object({
  label: z.enum(['first', '25_percent', '50_percent', '75_percent', 'last']), time: number.nonnegative(), frameIndex: number.int().nonnegative(),
  points: z.array(z.object({ index: number.int().min(0).max(12), position: nativePointSchema, activation: number, valid: z.boolean() }).strict()).length(13),
}).strict();
export const nativeRoiSchema = z.object({ x: number.int().nonnegative(), y: number.int().nonnegative(), width: positive.int(), height: positive.int(), modelWidth: positive.int(), modelHeight: positive.int() }).strict();
export const nativeEventSchema = z.object({
  schemaVersion: z.literal(1), taskID: z.string().uuid(), type: z.enum(['progress', 'result', 'error']),
  stage: z.string().optional(), current: number.nonnegative().optional(), total: number.nonnegative().optional(),
  calibration: nativeCalibrationSchema.optional(), tableSamples: z.array(nativeTableSampleSchema).length(5).optional(), roi: nativeRoiSchema.optional(),
  rallies: z.array(z.object({ id: z.string(), index: positive.int(), start: number.nonnegative(), end: positive, bounceCount: positive.int(), startFrame: number.int(), endFrame: number.int() }).strict()).optional(),
  bounceTimes: z.array(number.nonnegative()).optional(),
  video: nativeVideoSchema.optional(), outputPath: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export type NativeVideo = z.infer<typeof nativeVideoSchema>;
export type NativeEvent = z.infer<typeof nativeEventSchema>;
