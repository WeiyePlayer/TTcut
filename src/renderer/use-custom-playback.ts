import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CustomRallyClip } from '../domain/custom-clips';
import { chooseLoopTarget, loopPlaybackDecision, resolveCustomPlayback, validPlaybackClip, type CustomPlaybackMode, type PlaybackReason } from '../domain/custom-playback';
import type { TimelineSeekIntent } from './CustomTimeline';
import type { PreviewController } from './preview-controller';

export function useCustomPlayback({ videoRef, preview, clips, mode, duration, onModeChange, onTime, onLocate }: {
  videoRef: RefObject<HTMLVideoElement | null>;
  preview: PreviewController;
  clips: readonly CustomRallyClip[];
  mode: CustomPlaybackMode;
  duration: number;
  onModeChange(mode: CustomPlaybackMode): void;
  onTime(time: number): void;
  onLocate(time: number, reason: 'continuous' | 'commit'): void;
}) {
  const temporaryClipId = useRef<string | null>(null);
  const loopTargetRef = useRef<string | null>(null);
  const [loopClipId, setLoopClipId] = useState<string | null>(null);
  const scrubbing = useRef(false);
  const current = useRef({ clips, mode, duration, preview, onTime, onLocate });
  current.current = { clips, mode, duration, preview, onTime, onLocate };

  const setLoopTarget = useCallback((clipId: string | null) => {
    if (loopTargetRef.current === clipId) return;
    loopTargetRef.current = clipId;
    setLoopClipId(clipId);
  }, []);

  const navigate = useCallback((time: number, playing: boolean, reason: PlaybackReason, explicit: boolean) => {
    const state = current.current;
    const boundedTime = Math.max(0, Math.min(state.duration, time));
    const decision = playing
      ? state.mode === 'loop'
        ? loopPlaybackDecision(state.clips, boundedTime, loopTargetRef.current)
        : resolveCustomPlayback(state.clips, state.mode, boundedTime, reason, temporaryClipId.current)
      : { action: 'continue' as const, time: boundedTime };
    if ('temporaryClipId' in decision) temporaryClipId.current = decision.temporaryClipId;
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
    if (!player && !state.preview.native) return;
    const intent = state.preview.getPlaybackIntent();
    // Frame callbacks enforce boundaries without re-rendering the entire editor
    // at the source frame rate. Media timeupdate and jumps publish the playhead.
    // A preview seek may return a nearby keyframe. While dragging, only the
    // pointer owns the playhead; decoding must not pull it away from the mouse.
    if (publishTime && !scrubbing.current) state.onTime(intent.time);
    // Both queued transport and native seeks own their target until ready.
    // Read currentTime here rather than using an older frame callback's timestamp.
    if (scrubbing.current || intent.pending || player?.seeking || intent.seeking) return;
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
      state.preview.seekTo(boundedTime, playing, false);
      state.onTime(boundedTime);
    } else {
      if (state.mode === 'loop') {
        const selected = state.clips.some((clip) => clip.selected && validPlaybackClip(clip));
        const containing = state.clips.find((clip) => validPlaybackClip(clip) && time >= clip.start && time < clip.end);
        setLoopTarget(selected ? chooseLoopTarget(state.clips, time) : loopTargetRef.current ? containing?.clipId ?? null : null);
      }
      navigate(time, playing, 'reconcile', true);
    }
  }, [navigate, setLoopTarget]);

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
    if (state.mode === 'loop') setLoopTarget(clip.clipId);
    temporaryClipId.current = state.mode === 'rallies' && !clip.selected ? clip.clipId : null;
    navigate(clip.start, true, 'play', true);
  }, [navigate, setLoopTarget]);

  const remapSplitTarget = useCallback((clipId: string, rightClipId: string, boundary: number) => {
    const state = current.current;
    const target = state.clips.find((clip) => clip.clipId === clipId);
    const time = state.preview.getPlaybackIntent().time;
    if (state.mode === 'loop' && loopTargetRef.current === clipId && target && time >= boundary && time < target.end) {
      setLoopTarget(rightClipId);
    }
  }, [setLoopTarget]);

  const switchMode = useCallback(() => {
    const state = current.current;
    const next = state.mode === 'source' ? 'rallies' : state.mode === 'rallies' ? 'loop' : 'source';
    state.mode = next;
    temporaryClipId.current = null;
    setLoopTarget(next === 'loop' ? chooseLoopTarget(state.clips, state.preview.getPlaybackIntent().time) : null);
    onModeChange(next);
    const intent = state.preview.getPlaybackIntent();
    if (!scrubbing.current) navigate(intent.time, intent.playing, 'reconcile', false);
  }, [navigate, onModeChange, setLoopTarget]);

  const ended = useCallback(() => {
    const state = current.current;
    const intent = state.preview.getPlaybackIntent();
    if (state.mode !== 'loop' || scrubbing.current || intent.pending || intent.seeking) return;
    const target = state.clips.find((clip) => clip.clipId === loopTargetRef.current && validPlaybackClip(clip));
    if (!target) return;
    state.preview.seekTo(target.start, true);
    state.onTime(target.start);
    state.onLocate(target.start, 'commit');
  }, []);

  const previousMode = useRef(mode);
  const previousClips = useRef(clips);
  useLayoutEffect(() => {
    const intent = current.current.preview.getPlaybackIntent();
    if (mode === 'loop') {
      if (previousMode.current !== 'loop') setLoopTarget(chooseLoopTarget(clips, intent.time));
      else if (!clips.some((clip) => clip.clipId === loopTargetRef.current && validPlaybackClip(clip))) {
        setLoopTarget(chooseLoopTarget(clips.filter((clip) => clip.selected), intent.time));
      } else {
        // Redo restores split drafts without calling the pointer split handler.
        // Follow the child at the playhead when the surviving left ID shrinks.
        const before = previousClips.current.find((clip) => clip.clipId === loopTargetRef.current);
        const after = clips.find((clip) => clip.clipId === loopTargetRef.current);
        if (before && after?.isSplit && intent.time >= before.start && intent.time < before.end
          && (intent.time < after.start || intent.time >= after.end)) {
          const child = clips.find((clip) => clip.isSplit && clip.source === before.source
            && clip.sourceRallyId === before.sourceRallyId && clip.start >= before.start && clip.end <= before.end
            && intent.time >= clip.start && intent.time < clip.end);
          if (child) setLoopTarget(child.clipId);
        }
      }
    } else setLoopTarget(null);
    if (previousMode.current !== mode || !clips.some((clip) => clip.selected)
      || !clips.some((clip) => clip.clipId === temporaryClipId.current && !clip.selected)) {
      temporaryClipId.current = null;
    }
    previousMode.current = mode;
    previousClips.current = clips;
    if (scrubbing.current) return;
    navigate(intent.time, intent.playing, 'reconcile', false);
  }, [clips, mode, navigate, setLoopTarget]);

  return { tick, seek, cancelScrub, togglePlayback, playClip, remapSplitTarget, switchMode, ended, loopClipId };
}
