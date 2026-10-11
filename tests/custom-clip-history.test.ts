import { describe, expect, it } from 'vitest';
import { customClipHistoryReducer as reduce, emptyCustomClipHistory } from '../src/domain/custom-clip-history';
import { splitCustomClip, type CustomRallyClip } from '../src/domain/custom-clips';

const original: CustomRallyClip[] = [{ clipId: 'a', source: 'detected', sourceRallyId: 'a', rallyIndex: 1,
  start: 1, end: 5, defaultStart: 1, defaultEnd: 5, selected: true, bounceCount: 4,
  score: { left: 2, right: 1 }, winner: 'left' }];

describe('custom clip edit history', () => {
  it('undoes and redoes a split with stable IDs, counts, and annotations', () => {
    let state = reduce(emptyCustomClipHistory, { type: 'load', clips: original });
    const split = splitCustomClip(original, 'a', 3, 'right', 30, [2, 4])!;
    state = reduce(state, { type: 'edit', update: split });
    state = reduce(state, { type: 'undo' });
    expect(state.present).toEqual(original);
    state = reduce(state, { type: 'redo' });
    expect(state.present).toEqual(split);
  });
  it('groups live resize updates into a single undo step and ignores no-op gestures', () => {
    let state = reduce(emptyCustomClipHistory, { type: 'load', clips: original });
    state = reduce(state, { type: 'begin' });
    for (const end of [4.9, 4.8, 4.7]) state = reduce(state, { type: 'edit', update: current => current!.map(clip => ({ ...clip, end })) });
    expect(state.past).toHaveLength(0);
    state = reduce(state, { type: 'commit' });
    expect(state.past).toHaveLength(1);
    expect(reduce(state, { type: 'undo' }).present).toEqual(original);
    state = reduce(state, { type: 'begin' });
    state = reduce(state, { type: 'edit', update: current => current!.map(clip => ({ ...clip })) });
    state = reduce(state, { type: 'commit' });
    expect(state.past).toHaveLength(1);
  });
  it('invalidates redo after a new edit and clears all history on reload/reset', () => {
    let state = reduce(emptyCustomClipHistory, { type: 'load', clips: original });
    state = reduce(state, { type: 'edit', update: [] });
    state = reduce(state, { type: 'undo' });
    state = reduce(state, { type: 'edit', update: current => current!.map(clip => ({ ...clip, selected: false })) });
    expect(state.future).toEqual([]);
    expect(reduce(state, { type: 'load', clips: original })).toEqual({ ...emptyCustomClipHistory, present: original });
    expect(reduce(state, { type: 'load', clips: null })).toEqual(emptyCustomClipHistory);
  });
  it('keeps the last 100 edits and treats equivalent draft updates as no-ops', () => {
    let state = reduce(emptyCustomClipHistory, { type: 'load', clips: original });
    expect(reduce(state, { type: 'edit', update: structuredClone(original) })).toBe(state);
    for (let count = 1; count <= 110; count++) state = reduce(state, { type: 'edit', update: current => current!.map(clip => ({ ...clip, bounceCount: count })) });
    expect(state.past).toHaveLength(100);
    for (let count = 0; count < 100; count++) state = reduce(state, { type: 'undo' });
    expect(state.present?.[0]?.bounceCount).toBe(10);
    expect(state.future).toHaveLength(100);
  });
});
