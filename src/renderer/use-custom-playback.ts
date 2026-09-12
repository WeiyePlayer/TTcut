import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { CustomRallyClip } from '../domain/custom-clips';
import { resolveCustomPlayback, type CustomPlaybackMode, type PlaybackReason } from '../domain/custom-playback';
import type { TimelineSeekIntent } from './CustomTimeline';
import type { useCompatiblePreview } from './use-compatible-preview';

export function useCustomPlayback({ videoRef, preview, clips, mode, duration, onModeChange, onTime, onLocate }: {
  videoRef: RefObject<HTMLVideoElement | null>;
  preview: ReturnType<typeof useCompatiblePreview>;
  clips: readonly CustomRallyClip[];
  mode: CustomPlaybackMode;
  duration: number;
  onModeChange(mode: CustomPlaybackMode): void;
  onTime(time: number): void;
  onLocate(time: number, reason: 'continuous' | 'commit'): void;
}) {
  const temporaryClipId = useRef<string | null>(null);
  const scrubbing = useRef(false);
  const current = useRef({ clips, mode, duration, preview, onTime, onLocate });
  current.current = { clips, mode, duration, preview, onTime, onLocate };

  const navigate = useCallback((time: number, playing: boolean, reason: PlaybackReason, explicit: boolean) => {
    const state = current.current;
    const boundedTime = Math.max(0, Math.min(state.duration, time));
    const decision = playing
      ? resolveCustomPlayback(state.clips, state.mode, boundedTime, reason, temporaryClipId.current)
      : { action: 'continue' as const, time: boundedTime, temporaryClipId: temporaryClipId.current };
    temporaryClipId.current = decision.temporaryClipId;
    if (explicit || decision.action !== 'continue') {
      state.preview.seekTo(decision.time, playing && decision.action !== 'pause');
      state.onTime(decision.time);
      state.onLocate(decision.time, 'commit');
    }
    return decision.action !== 'continue';
  }, []);

  const tick = useCallback((publishTime = true) => {
    const state = current.current;
    const player = videoRef.current;
    if (!player) return;
    const intent = state.preview.getPlaybackIntent();
    // Frame callbacks enforce boundaries without re-rendering the entire editor
    // at the source frame rate. Media timeupdate and jumps publish the playhead.
    if (publishTime) state.onTime(intent.time);
    // Both queued transport and native seeks own their target until ready.
    // Read currentTime here rather than using an older frame callback's timestamp.
    if (scrubbing.current || intent.pending || player.seeking) return;
    if (intent.playing && navigate(intent.time, true, 'advance', false)) return;
    state.onLocate(intent.time, 'continuous');
  }, [navigate, videoRef]);

  const seek = useCallback((time: number, intent: TimelineSeekIntent) => {
    const state = current.current;
    temporaryClipId.current = null;
    scrubbing.current = intent === 'preview';
    const playing = state.preview.getPlaybackIntent().playing;
    if (scrubbing.current) {
      const boundedTime = Math.max(0, Math.min(state.duration, time));
      state.preview.seekTo(boundedTime, playing);
      state.onTime(boundedTime);
    } else navigate(time, playing, 'reconcile', true);
  }, [navigate]);

  const cancelScrub = useCallback(() => {
    scrubbing.current = false;
    const intent = current.current.preview.getPlaybackIntent();
    navigate(intent.time, intent.playing, 'reconcile', false);
  }, [navigate]);

  const togglePlayback = useCallback(() => {
    const intent = current.current.preview.getPlaybackIntent();
    navigate(intent.time, !intent.playing, 'play', true);
  }, [navigate]);

  const playClip = useCallback((clip: CustomRallyClip) => {
    const state = current.current;
    scrubbing.current = false;
    temporaryClipId.current = state.mode === 'rallies' && !clip.selected ? clip.clipId : null;
    navigate(clip.start, true, 'play', true);
  }, [navigate]);

  const switchMode = useCallback(() => {
    const state = current.current;
    const next = state.mode === 'source' ? 'rallies' : 'source';
    state.mode = next;
    temporaryClipId.current = null;
    onModeChange(next);
    const intent = state.preview.getPlaybackIntent();
    if (!scrubbing.current) navigate(intent.time, intent.playing, 'reconcile', false);
  }, [navigate, onModeChange]);

  const previousMode = useRef(mode);
  useLayoutEffect(() => {
    if (previousMode.current !== mode || !clips.some((clip) => clip.selected)
      || !clips.some((clip) => clip.clipId === temporaryClipId.current && !clip.selected)) {
      temporaryClipId.current = null;
    }
    previousMode.current = mode;
    if (scrubbing.current) return;
    const intent = current.current.preview.getPlaybackIntent();
    navigate(intent.time, intent.playing, 'reconcile', false);
  }, [clips, mode, navigate]);

  return { tick, seek, cancelScrub, togglePlayback, playClip, switchMode };
}
