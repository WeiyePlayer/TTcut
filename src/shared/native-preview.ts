import { z } from 'zod';

export const previewBoundsSchema = z.object({
  x: z.number().finite().min(-20000).max(20000), y: z.number().finite().min(-20000).max(20000),
  width: z.number().finite().min(0).max(16384), height: z.number().finite().min(0).max(16384),
  visible: z.boolean(),
}).strict();
export const previewScoreboardSchema = z.object({
  enabled: z.boolean(), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  scale: z.number().min(0.5).max(3), aspect: z.number().positive().max(100),
  left: z.number().int().min(0).max(999), right: z.number().int().min(0).max(999),
  leftName: z.string().max(100), rightName: z.string().max(100),
}).strict();
export const nativePreviewCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bounds'), bounds: previewBoundsSchema }).strict(),
  z.object({ type: z.literal('seek'), time: z.number().finite().min(0), playing: z.boolean(), exact: z.boolean(), sequence: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('scoreboard'), scoreboard: previewScoreboardSchema }).strict(),
  z.object({ type: z.literal('retry') }).strict(),
]);
export const nativePreviewOpenSchema = z.object({
  sessionId: z.string().uuid(), mediaUrl: z.string().max(2048), bounds: previewBoundsSchema,
}).strict();
export type PreviewBounds = z.infer<typeof previewBoundsSchema>;
export type PreviewScoreboard = z.infer<typeof previewScoreboardSchema>;
export type NativePreviewCommand = z.infer<typeof nativePreviewCommandSchema>;
export type NativePreviewOpen = z.infer<typeof nativePreviewOpenSchema>;
export type NativePreviewEvent = {
  sessionId: string;
} & (
  | { type: 'state'; time: number; duration: number; paused: boolean; seeking: boolean; ended: boolean; ready: boolean; sequence: number; samples: number; decoder: string; mode: 'direct' | 'software' | 'proxy' }
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string }
  | { type: 'pointer'; action: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; width: number; height: number }
  | { type: 'key'; key: string; shift: boolean }
);
