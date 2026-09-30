import type { Rally } from '../shared/contracts';

export const SMALL_MIN_PLAY_SECONDS = 2;
export const SMALL_SERVE_LEAD_SECONDS = 1.5;
export const SMALL_POST_ROLL_SECONDS = 0.5;

/** Count decoded play only, excluding serve, padding and time outside the rally. */
export function smallPlayDuration(rally: Rally): number {
  if (!('phases' in rally)) return 0;
  return rally.phases.reduce((total, phase) => total + (phase.label === 'play'
    ? Math.max(0, Math.min(phase.end_sec, rally.end_time_seconds)
      - Math.max(phase.start_sec, rally.start_time_seconds)) : 0), 0);
}

export function keepsSmallRally(rally: Rally): boolean {
  return smallPlayDuration(rally) + 1e-9 >= SMALL_MIN_PLAY_SECONDS;
}
