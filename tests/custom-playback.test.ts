import { describe, expect, it } from 'vitest';
import { resolveCustomPlayback } from '../src/domain/custom-playback';
import type { CustomRallyClip } from '../src/domain/custom-clips';

const clip = (clipId: string, start: number, end: number, selected = true): CustomRallyClip => ({
  clipId, start, end, selected, defaultStart: start, defaultEnd: end,
  source: 'manual', sourceRallyId: null, rallyIndex: 1, bounceCount: 0,
});
const clips = [clip('a', 1, 2), clip('b', 4, 5), clip('hidden', 7, 8, false), clip('c', 9, 10)];

describe('custom playback decisions', () => {
  it.each([0, 2, 7.5, 11])('leaves source playback unchanged at %s', (time) => {
    expect(resolveCustomPlayback(clips, 'source', time, 'advance')).toMatchObject({ action: 'continue', time });
  });
  it('uses only current selected intervals, in time order, with half-open boundaries', () => {
    const reversed = [...clips].reverse();
    expect(resolveCustomPlayback(reversed, 'rallies', 0, 'play')).toMatchObject({ action: 'seek', time: 1 });
    expect(resolveCustomPlayback(reversed, 'rallies', 1.99, 'advance').action).toBe('continue');
    expect(resolveCustomPlayback(reversed, 'rallies', 2, 'advance')).toMatchObject({ action: 'seek', time: 4 });
    expect(resolveCustomPlayback(reversed, 'rallies', 5, 'advance')).toMatchObject({ action: 'seek', time: 9 });
  });
  it('does not seek between adjacent clips', () => {
    expect(resolveCustomPlayback([clip('a', 1, 2), clip('b', 2, 3)], 'rallies', 2, 'advance').action).toBe('continue');
  });
  it('stops at the last end, replays only on an explicit play, and preserves a later mode-switch position', () => {
    expect(resolveCustomPlayback(clips, 'rallies', 10.1, 'advance')).toMatchObject({ action: 'pause', time: 10 });
    expect(resolveCustomPlayback(clips, 'rallies', 10, 'play')).toMatchObject({ action: 'seek', time: 1 });
    expect(resolveCustomPlayback(clips, 'rallies', 11, 'reconcile')).toMatchObject({ action: 'pause', time: 11 });
  });
  it('falls back to source playback on an empty track, including during a temporary preview', () => {
    expect(resolveCustomPlayback(clips.map((item) => ({ ...item, selected: false })), 'rallies', 8, 'advance', 'hidden'))
      .toEqual({ action: 'continue', time: 8, temporaryClipId: null });
  });
  it('plays a temporary unselected interval then continues with the next selected interval', () => {
    expect(resolveCustomPlayback(clips, 'rallies', 7.5, 'advance', 'hidden')).toEqual({ action: 'continue', time: 7.5, temporaryClipId: 'hidden' });
    expect(resolveCustomPlayback(clips, 'rallies', 8, 'advance', 'hidden')).toEqual({ action: 'seek', time: 9, temporaryClipId: null });
    expect(clips[2]!.selected).toBe(false);
  });
  it('continues inside an overlapping selected interval without replaying its start', () => {
    const overlapping = [clip('selected', 5, 9), clip('preview', 4, 7, false)];
    expect(resolveCustomPlayback(overlapping, 'rallies', 6, 'advance', 'preview').temporaryClipId).toBe('preview');
    expect(resolveCustomPlayback(overlapping, 'rallies', 7, 'advance', 'preview')).toEqual({ action: 'continue', time: 7, temporaryClipId: null });
  });
  it('stops at a temporary preview end when there is no later selected interval', () => {
    expect(resolveCustomPlayback(clips.slice(0, 3), 'rallies', 8.1, 'advance', 'hidden')).toMatchObject({ action: 'pause', time: 8 });
  });
  it('uses edits and removal immediately instead of a captured queue', () => {
    expect(resolveCustomPlayback([clip('a', 1, 1.5), clip('b', 4, 6)], 'rallies', 1.6, 'reconcile')).toMatchObject({ action: 'seek', time: 4 });
    expect(resolveCustomPlayback(clips.filter((item) => item.clipId !== 'hidden'), 'rallies', 7.5, 'advance', 'hidden')).toMatchObject({ action: 'seek', time: 9, temporaryClipId: null });
  });
});
