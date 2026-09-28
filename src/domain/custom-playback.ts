import type { CustomRallyClip } from './custom-clips';

export type CustomPlaybackMode = 'source' | 'rallies' | 'loop';
export type PlaybackReason = 'advance' | 'play' | 'reconcile';
export type CustomPlaybackDecision = {
  action: 'continue' | 'seek' | 'pause';
  time: number;
  temporaryClipId: string | null;
};

/** Resolve transport against the current draft; never modify selection or clip boundaries. */
export function resolveCustomPlayback(
  clips: readonly CustomRallyClip[],
  mode: CustomPlaybackMode,
  time: number,
  reason: PlaybackReason,
  temporaryClipId: string | null = null,
): CustomPlaybackDecision {
  if (mode !== 'rallies' || !Number.isFinite(time)) return { action: 'continue', time, temporaryClipId: null };
  const valid = clips.filter((clip) => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start);
  const selected = valid.filter((clip) => clip.selected).sort((left, right) => left.start - right.start);
  if (selected.length === 0) {
    return { action: 'continue', time, temporaryClipId: null };
  }
  const temporary = valid.find((clip) => clip.clipId === temporaryClipId && !clip.selected);
  if (temporary && time >= temporary.start && time < temporary.end) {
    return { action: 'continue', time, temporaryClipId: temporary.clipId };
  }
  if (selected.some((clip) => time >= clip.start && time < clip.end)) {
    return { action: 'continue', time, temporaryClipId: null };
  }
  const next = selected.find((clip) => clip.start > time);
  if (next) return { action: 'seek', time: next.start, temporaryClipId: null };
  if (reason === 'play') return { action: 'seek', time: selected[0]!.start, temporaryClipId: null };
  return {
    action: 'pause',
    time: reason === 'advance' ? temporary?.end ?? selected.at(-1)!.end : time,
    temporaryClipId: null,
  };
}

export function validPlaybackClip(clip: CustomRallyClip): boolean {
  return Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start;
}

/** Pick an explicit loop target without changing the draft's export selection. */
export function chooseLoopTarget(clips: readonly CustomRallyClip[], time: number): string | null {
  if (!Number.isFinite(time)) return null;
  const valid = clips.filter(validPlaybackClip);
  const selected = valid.filter((clip) => clip.selected).sort((left, right) => left.start - right.start);
  if (selected.length === 0) return null;
  const containing = valid.filter((clip) => time >= clip.start && time < clip.end);
  if (containing.length > 0) return (containing.find((clip) => clip.selected) ?? containing[0]!).clipId;
  return (selected.find((clip) => clip.start > time) ?? selected[0]!).clipId;
}

export function loopPlaybackDecision(
  clips: readonly CustomRallyClip[], time: number, loopClipId: string | null,
): { action: 'continue' | 'seek'; time: number } {
  const target = clips.find((clip) => clip.clipId === loopClipId && validPlaybackClip(clip));
  if (!target || !Number.isFinite(time) || (time >= target.start && time < target.end)) {
    return { action: 'continue', time };
  }
  return { action: 'seek', time: target.start };
}
