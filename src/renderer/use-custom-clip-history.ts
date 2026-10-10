import { useCallback, useReducer } from 'react';
import { customClipHistoryReducer, emptyCustomClipHistory, type CustomClipDraft, type CustomClipHistoryAction } from '../domain/custom-clip-history';

export function useCustomClipHistory(initialDraft: CustomClipDraft = null) {
  const [state, dispatch] = useReducer(customClipHistoryReducer, { ...emptyCustomClipHistory, present: initialDraft });
  const load = useCallback((clips: CustomClipDraft) => dispatch({ type: 'load', clips }), []);
  const edit = useCallback((update: Extract<CustomClipHistoryAction, { type: 'edit' }>['update']) => dispatch({ type: 'edit', update }), []);
  const begin = useCallback(() => dispatch({ type: 'begin' }), []);
  const commit = useCallback(() => dispatch({ type: 'commit' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  return { clips: state.present, load, edit, begin, commit, undo, redo,
    canUndo: state.past.length > 0 || Boolean(state.transaction && state.present !== state.transaction.before),
    canRedo: state.future.length > 0 && !state.transaction };
}
