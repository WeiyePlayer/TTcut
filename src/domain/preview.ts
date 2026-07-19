import type { Rally } from '../shared/contracts';

export const RALLY_PREVIEW_PADDING_SECONDS = 1;

export type RallyPreviewRange = {
  start: number;
  end: number;
};

function normalizeSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function rallyPreviewRange(rally: Rally, videoDuration: number): RallyPreviewRange {
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) throw new Error('INVALID_VIDEO_DURATION');
  return {
    start: Math.max(0, normalizeSeconds(rally.start_time_seconds - RALLY_PREVIEW_PADDING_SECONDS)),
    end: Math.min(videoDuration, normalizeSeconds(rally.end_time_seconds + RALLY_PREVIEW_PADDING_SECONDS)),
  };
}
