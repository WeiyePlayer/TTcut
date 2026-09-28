export const SCOREBOARD_WIDTH_FRACTION = 0.28;
export const SCOREBOARD_ASPECT_RATIO = 5.2;
export const SCOREBOARD_NAME_FRACTION = 0.76;
export const SCOREBOARD_COLUMN_FRACTION = 0.12;
export const SCOREBOARD_CONTROL_GAP = 0.02;
export const SCOREBOARD_PREVIEW_WIDTH_FRACTION = SCOREBOARD_WIDTH_FRACTION * (1 + SCOREBOARD_CONTROL_GAP + SCOREBOARD_COLUMN_FRACTION);
export const SCOREBOARD_MIN_SCALE = 0.5;
export const SCOREBOARD_MAX_SCALE = 3;

export function scoreboardDimensions(videoWidth: number, videoHeight: number, scale = 1): { width: number; height: number } {
  const width = Math.max(1, Math.round(videoWidth * SCOREBOARD_WIDTH_FRACTION * scale));
  return { width, height: Math.min(videoHeight, Math.max(1, Math.round(width / SCOREBOARD_ASPECT_RATIO))) };
}

export function scoreboardDisplayDimensions(videoWidth: number, videoHeight: number, rotation: number): { width: number; height: number } {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 270
    ? { width: videoHeight, height: videoWidth }
    : { width: videoWidth, height: videoHeight };
}

export function scoreboardHeightFraction(videoAspect: number): number {
  return SCOREBOARD_WIDTH_FRACTION * videoAspect / SCOREBOARD_ASPECT_RATIO;
}

export function scoreboardName(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}
