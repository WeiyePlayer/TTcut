import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomRallyClip } from '../src/domain/custom-clips';
import type { CustomPlaybackMode } from '../src/domain/custom-playback';
import { useCustomPlayback } from '../src/renderer/use-custom-playback';

const clips: CustomRallyClip[] = [
  ['a', 1, 2, true], ['b', 4, 5, true], ['hidden', 7, 8, false], ['c', 9, 10, true],
].map(([clipId, start, end, selected]) => ({
  clipId: String(clipId), start: Number(start), end: Number(end), selected: Boolean(selected),
  defaultStart: Number(start), defaultEnd: Number(end), source: 'manual', sourceRallyId: null, rallyIndex: 1, bounceCount: 0,
}));
afterEach(cleanup);

function setup(initialMode: CustomPlaybackMode = 'rallies') {
  const player = { currentTime: 0, paused: true, ended: false, seeking: false };
  const videoRef = { current: player as HTMLVideoElement };
  let queued: { time: number; playing: boolean } | null = null;
  let loading = false;
  const seekTo = vi.fn((time: number, playing = false) => {
    if (loading) queued = { time, playing };
    else { queued = null; player.currentTime = time; player.paused = !playing; }
  });
  const onLocate = vi.fn();
  const onTime = vi.fn();
  const preview = {
    source: 'source', url: 'source', status: 'ready' as const, seekTo, togglePlayback: vi.fn(),
    getPlaybackIntent: () => ({ time: queued?.time ?? player.currentTime, playing: queued?.playing ?? !player.paused, pending: queued !== null }),
  };
  const hook = renderHook(({ draft }) => {
    const [mode, onModeChange] = useState(initialMode);
    return useCustomPlayback({ videoRef, preview, clips: draft, mode, duration: 12, onModeChange, onTime, onLocate });
  }, { initialProps: { draft: clips } });
  const tick = (time: number) => act(() => { player.currentTime = time; hook.result.current.tick(); });
  return {
    ...hook, player, seekTo, onLocate, onTime, tick,
    loading(value: boolean) { loading = value; },
    getIntent: preview.getPlaybackIntent,
    ready() { loading = false; if (queued) seekTo(queued.time, queued.playing); },
  };
}

describe('custom playback transport', () => {
  it('uses frame callbacks for boundaries without publishing every source frame', () => {
    const h = setup(); h.player.paused = false; h.player.currentTime = 1.5;
    act(() => h.result.current.tick(false));
    expect(h.onTime).not.toHaveBeenCalled();
    h.player.currentTime = 2.01;
    act(() => h.result.current.tick(false));
    expect(h.onTime).toHaveBeenCalledExactlyOnceWith(4);
  });
  it('skips gaps during playback, stops at the last end, and starts again only on play', () => {
    const h = setup();
    act(() => h.result.current.togglePlayback());
    expect(h.player).toMatchObject({ currentTime: 1, paused: false });
    h.tick(2.01);
    expect(h.seekTo).toHaveBeenLastCalledWith(4, true);
    h.tick(5);
    expect(h.seekTo).toHaveBeenLastCalledWith(9, true);
    h.tick(10.01);
    expect(h.player).toMatchObject({ currentTime: 10, paused: true });
    h.tick(10);
    expect(h.player.paused).toBe(true);
    act(() => h.result.current.togglePlayback());
    expect(h.seekTo).toHaveBeenLastCalledWith(1, true);
  });
  it('switches live in both directions and leaves paused positions unchanged', () => {
    const h = setup('source');
    h.player.currentTime = 3; h.player.paused = false;
    act(() => h.result.current.switchMode());
    expect(h.player.currentTime).toBe(4);
    act(() => h.result.current.switchMode());
    h.seekTo.mockClear();
    h.tick(5.5);
    expect(h.seekTo).not.toHaveBeenCalled();
    h.player.paused = true;
    act(() => h.result.current.switchMode());
    expect(h.player.currentTime).toBe(5.5);
    expect(h.seekTo).not.toHaveBeenCalled();
    act(() => h.result.current.togglePlayback());
    expect(h.player.currentTime).toBe(9);
  });
  it('pauses in place when enabled beyond the last clip', () => {
    const h = setup('source');
    h.player.currentTime = 11; h.player.paused = false;
    act(() => h.result.current.switchMode());
    expect(h.player).toMatchObject({ currentTime: 11, paused: true });
  });
  it.each([true, false])('allows free scrubbing and respects playback on release (playing=%s)', (playing) => {
    const h = setup(); h.player.paused = !playing;
    act(() => h.result.current.seek(3, 'preview'));
    h.tick(3.1);
    expect(h.player.currentTime).toBe(3.1);
    act(() => h.result.current.seek(3, 'commit'));
    expect(h.player.currentTime).toBe(playing ? 4 : 3);
    expect(h.player.paused).toBe(!playing);
  });
  it('restores boundary handling after a cancelled scrub', () => {
    const h = setup(); h.player.paused = false;
    act(() => h.result.current.seek(3, 'preview'));
    act(() => h.result.current.cancelScrub());
    expect(h.seekTo).toHaveBeenLastCalledWith(4, true);
  });
  it('plays an unselected clip temporarily, including pause/resume, then returns to selected clips', () => {
    const h = setup();
    act(() => h.result.current.playClip(clips[2]!));
    expect(h.player.currentTime).toBe(7);
    h.tick(7.5);
    act(() => h.result.current.togglePlayback());
    act(() => h.result.current.togglePlayback());
    expect(h.seekTo).toHaveBeenLastCalledWith(7.5, true);
    h.tick(8);
    expect(h.seekTo).toHaveBeenLastCalledWith(9, true);
    expect(clips[2]!.selected).toBe(false);
  });
  it('clears temporary preview on an explicit seek or mode change', () => {
    const h = setup();
    act(() => h.result.current.playClip(clips[2]!));
    act(() => h.result.current.seek(7.2, 'commit'));
    expect(h.player.currentTime).toBe(9);
    act(() => h.result.current.playClip(clips[2]!));
    act(() => h.result.current.switchMode());
    act(() => h.result.current.switchMode());
    expect(h.player.currentTime).toBe(9);
  });
  it('uses changed boundaries, deletion and empty-track fallback during playback', () => {
    const h = setup();
    act(() => h.result.current.playClip(clips[0]!)); h.tick(1.8);
    h.rerender({ draft: clips.map((clip) => clip.clipId === 'a' ? { ...clip, end: 1.5 } : clip) });
    expect(h.player.currentTime).toBe(4);
    h.rerender({ draft: clips.filter((clip) => clip.clipId !== 'b') });
    expect(h.player.currentTime).toBe(9);
    h.rerender({ draft: clips.map((clip) => ({ ...clip, selected: false })) });
    h.seekTo.mockClear(); h.tick(10.5);
    expect(h.seekTo).not.toHaveBeenCalled();
    h.rerender({ draft: clips });
    expect(h.player).toMatchObject({ currentTime: 10.5, paused: true });
  });
  it('does not reposition a paused player on draft edits', () => {
    const h = setup(); h.player.currentTime = 3;
    h.rerender({ draft: clips.slice(1) });
    expect(h.seekTo).not.toHaveBeenCalled();
    expect(h.player.currentTime).toBe(3);
  });
  it('does not issue competing jumps during native seeks or queued loads', () => {
    const h = setup(); h.player.paused = false; h.player.seeking = true;
    h.tick(2.1);
    expect(h.seekTo).not.toHaveBeenCalled();
    h.player.seeking = false; h.loading(true); h.tick(2.1);
    expect(h.seekTo).toHaveBeenCalledExactlyOnceWith(4, true);
    h.tick(2.2); h.tick(2.3);
    expect(h.seekTo).toHaveBeenCalledTimes(1);
    act(() => h.ready()); h.tick(4.1);
    expect(h.onLocate).toHaveBeenLastCalledWith(4.1, 'continuous');
  });
  it('preserves the latest mode, target and pause while media is loading', () => {
    const h = setup('source'); h.loading(true);
    act(() => h.result.current.seek(3, 'commit'));
    act(() => h.result.current.togglePlayback());
    act(() => h.result.current.switchMode());
    expect(h.getIntent()).toMatchObject({ time: 4, playing: true });
    act(() => h.result.current.playClip(clips[2]!));
    act(() => h.result.current.togglePlayback());
    act(() => h.result.current.switchMode());
    expect(h.getIntent()).toMatchObject({ time: 7, playing: false });
    act(() => h.ready());
    expect(h.player).toMatchObject({ currentTime: 7, paused: true });
  });
});
