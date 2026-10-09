import type { ScoreboardStyle, VideoMetadata } from '../shared/contracts';

export const SCOREBOARD_WIDTH_FRACTION = 0.28;
export const SCOREBOARD_ASPECT_RATIO = 5.2;
export const SCOREBOARD_RED_BLUE_WIDTH_FRACTION = 0.21;
export const SCOREBOARD_RED_BLUE_ASPECT_RATIO = 1.46;
export const SCOREBOARD_RED_BLUE_CARD_FRACTION = 0.425;
export const SCOREBOARD_RED_BLUE_HEADER_FRACTION = 0.205;
export const SCOREBOARD_RED_BLUE_DIVIDER_FRACTION = 0.012;
export const SCOREBOARD_RED_BLUE_CONTROL_HEIGHT = 1.2;
export const SCOREBOARD_NAME_FRACTION = 0.76;
export const SCOREBOARD_COLUMN_FRACTION = 0.12;
export const SCOREBOARD_CONTROL_GAP = 0.02;
export const SCOREBOARD_PREVIEW_WIDTH_FRACTION = SCOREBOARD_WIDTH_FRACTION * (1 + SCOREBOARD_CONTROL_GAP + SCOREBOARD_COLUMN_FRACTION);
export const SCOREBOARD_MIN_SCALE = 0.5;
export const SCOREBOARD_MAX_SCALE = 3;

export function scoreboardGamesColor(style: ScoreboardStyle = 'classic'): string {
  if (style === 'classic-orange') return '#f59e0b';
  if (style === 'classic-green') return '#22c55e';
  return '#3a83f7';
}

export function scoreboardAspectRatio(style: ScoreboardStyle = 'classic'): number {
  return style === 'red-blue' ? SCOREBOARD_RED_BLUE_ASPECT_RATIO : SCOREBOARD_ASPECT_RATIO;
}

export function scoreboardWidthFraction(style: ScoreboardStyle = 'classic'): number {
  return style === 'red-blue' ? SCOREBOARD_RED_BLUE_WIDTH_FRACTION : SCOREBOARD_WIDTH_FRACTION;
}

export function scoreboardPreviewWidthFraction(style: ScoreboardStyle = 'classic'): number {
  return style === 'red-blue' ? scoreboardWidthFraction(style) : SCOREBOARD_PREVIEW_WIDTH_FRACTION;
}

export function scoreboardPreviewHeightFraction(videoAspect: number, style: ScoreboardStyle = 'classic'): number {
  return scoreboardHeightFraction(videoAspect, style) * (style === 'red-blue' ? SCOREBOARD_RED_BLUE_CONTROL_HEIGHT : 1);
}

export function scoreboardDimensions(videoWidth: number, videoHeight: number, scale = 1, style: ScoreboardStyle = 'classic'): { width: number; height: number } {
  const width = Math.max(1, Math.round(videoWidth * scoreboardWidthFraction(style) * scale));
  return { width, height: Math.min(videoHeight, Math.max(1, Math.round(width / scoreboardAspectRatio(style)))) };
}

export function scoreboardDisplayDimensions(video: Pick<VideoMetadata, 'width' | 'height' | 'rotation' | 'native_video'>): { width: number; height: number } {
  const { width: videoWidth, height: videoHeight } = video;
  // Native MediaProbe already applies display rotation to its dimensions.
  const rotation = video.native_video ? 0 : video.rotation ?? 0;
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 270
    ? { width: videoHeight, height: videoWidth }
    : { width: videoWidth, height: videoHeight };
}

export function scoreboardHeightFraction(videoAspect: number, style: ScoreboardStyle = 'classic'): number {
  return scoreboardWidthFraction(style) * videoAspect / scoreboardAspectRatio(style);
}

export function scoreboardName(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}
