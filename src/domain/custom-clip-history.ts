import type { CustomRallyClip } from './custom-clips';

export type CustomClipDraft = CustomRallyClip[] | null;
export type CustomClipHistory = {
  present: CustomClipDraft;
  past: CustomClipDraft[];
  future: CustomClipDraft[];
  transaction: { before: CustomClipDraft } | null;
};
export type CustomClipHistoryAction =
  | { type: 'load'; clips: CustomClipDraft }
  | { type: 'edit'; update: CustomClipDraft | ((clips: CustomClipDraft) => CustomClipDraft) }
  | { type: 'begin' | 'commit' | 'undo' | 'redo' };

export const emptyCustomClipHistory: CustomClipHistory = {
  present: null, past: [], future: [], transaction: null,
};

function sameDraft(left: CustomClipDraft, right: CustomClipDraft): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function commit(state: CustomClipHistory): CustomClipHistory {
  if (!state.transaction) return state;
  const before = state.transaction.before;
  return sameDraft(before, state.present)
    ? { ...state, transaction: null }
    : { ...state, past: [...state.past, before].slice(-100), future: [], transaction: null };
}

/** All edits use immutable drafts; a pointer gesture contributes one history entry. */
export function customClipHistoryReducer(state: CustomClipHistory, action: CustomClipHistoryAction): CustomClipHistory {
  if (action.type === 'load') return { ...emptyCustomClipHistory, present: action.clips };
  if (action.type === 'begin') return state.transaction ? state : { ...state, transaction: { before: state.present } };
  if (action.type === 'commit') return commit(state);
  if (action.type === 'edit') {
    const present = typeof action.update === 'function' ? action.update(state.present) : action.update;
    if (sameDraft(state.present, present)) return state;
    if (state.transaction) return { ...state, present };
    return { present, past: [...state.past, state.present].slice(-100), future: [], transaction: null };
  }
  const ready = commit(state);
  if (action.type === 'undo') {
    if (!ready.past.length) return ready;
    return { present: ready.past.at(-1)!, past: ready.past.slice(0, -1),
      future: [ready.present, ...ready.future].slice(0, 100), transaction: null };
  }
  if (!ready.future.length) return ready;
  return { present: ready.future[0]!, past: [...ready.past, ready.present].slice(-100),
    future: ready.future.slice(1), transaction: null };
}
