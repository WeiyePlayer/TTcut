import type { AnalysisResultV1, CutGroup, CutSelectionV1, Rally } from '../shared/contracts';

const EPSILON = 1e-9;
export const FINAL_RALLY_TAIL_SECONDS = 1;

export class SelectionError extends Error {
  constructor(public readonly code: 'NO_RALLIES' | 'NO_HIGHLIGHTS' | 'NO_CUSTOM_SELECTION') {
    super(code);
  }
}

export function selectRallies(result: AnalysisResultV1, selection: CutSelectionV1): Rally[] {
  const unique = new Map(result.rallies.map((rally) => [rally.id, rally]));
  const rallies = [...unique.values()].sort(
    (a, b) => a.start_time_seconds - b.start_time_seconds || a.index - b.index,
  );

  if (selection.mode === 'all') {
    if (rallies.length === 0) throw new SelectionError('NO_RALLIES');
    return rallies;
  }

  if (selection.mode === 'highlight') {
    const filtered = rallies.filter((rally) => rally.bounce_count > selection.highlight_threshold);
    if (filtered.length === 0) throw new SelectionError('NO_HIGHLIGHTS');
    return filtered;
  }

  const selectedIds = new Set(selection.selected_rally_ids);
  const filtered = rallies.filter((rally) => selectedIds.has(rally.id));
  if (filtered.length === 0) throw new SelectionError('NO_CUSTOM_SELECTION');
  return filtered;
}

export function buildCutGroups(
  rallies: readonly Rally[],
  preRollSeconds: number,
  postRollSeconds: number,
  videoDuration: number,
): CutGroup[] {
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) return [];
  if (!Number.isFinite(preRollSeconds) || preRollSeconds < 0) return [];
  if (!Number.isFinite(postRollSeconds) || postRollSeconds < 0) return [];

  const seen = new Set<string>();
  const ordered = rallies
    .filter((rally) => {
      if (seen.has(rally.id)) return false;
      seen.add(rally.id);
      return Number.isFinite(rally.start_time_seconds)
        && Number.isFinite(rally.end_time_seconds)
        && rally.start_time_seconds >= 0
        && rally.end_time_seconds > rally.start_time_seconds;
    })
    .sort((a, b) => a.start_time_seconds - b.start_time_seconds || a.index - b.index);

  const raw: Array<Omit<CutGroup, 'start' | 'end'>> = [];
  for (const rally of ordered) {
    const current = raw.at(-1);
    if (current && rally.start_time_seconds - current.rawEnd < 5 - EPSILON) {
      current.rawEnd = Math.max(current.rawEnd, rally.end_time_seconds);
      current.rallyIds.push(rally.id);
    } else {
      raw.push({
        rallyIds: [rally.id],
        rawStart: rally.start_time_seconds,
        rawEnd: rally.end_time_seconds,
      });
    }
  }

  const expanded: CutGroup[] = [];
  for (const group of raw) {
    const start = Math.max(0, group.rawStart - preRollSeconds);
    // Add the fixed tail once, after the final rally in this cut group. The
    // configured after-rally option remains unchanged and is applied in full.
    const end = Math.min(videoDuration, group.rawEnd + FINAL_RALLY_TAIL_SECONDS + postRollSeconds);
    if (end <= start) continue;
    const previous = expanded.at(-1);
    if (previous && start <= previous.end + EPSILON) {
      previous.rawEnd = Math.max(previous.rawEnd, group.rawEnd);
      previous.end = Math.max(previous.end, end);
      previous.rallyIds.push(...group.rallyIds);
    } else {
      expanded.push({ ...group, start, end });
    }
  }
  return expanded;
}

export function createCutGroups(result: AnalysisResultV1, selection: CutSelectionV1): CutGroup[] {
  const rallies = selectRallies(result, selection);
  return buildCutGroups(
    rallies,
    selection.pre_roll_seconds,
    selection.post_roll_seconds,
    result.video.duration_seconds,
  );
}

