import type { CustomRallyClip } from './custom-clips';

export type CustomPlaybackMode = 'source' | 'rallies';
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
  if (mode === 'source' || !Number.isFinite(time)) return { action: 'continue', time, temporaryClipId: null };
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
