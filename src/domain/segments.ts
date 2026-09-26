import {
  DURATION_HIGHLIGHT_SECONDS,
  hasBounceCounts,
  rallyRecognitionMethod,
  type AnalysisResultV1,
  type CutGroup,
  type CutSelectionV1,
  type Rally,
  type RallyRecognitionMethod,
} from '../shared/contracts';

const EPSILON = 1e-9;
export const FINAL_RALLY_TAIL_SECONDS = 1;
export type ExcludedRange = { start_time_seconds: number; end_time_seconds: number };

/** Legacy histories keep their original grouping rules. Only new native decisions opt in. */
export function exportExclusions(result: AnalysisResultV1): readonly ExcludedRange[] {
  if (!('rally_recognition' in result) || !('excluded_fragments' in result)) return [];
  const recognition = result.rally_recognition;
  const usesSourceTime = recognition.method === 'continuous_visibility'
    ? 'timebase' in recognition && Boolean(recognition.timebase)
    : 'version' in recognition && recognition.version >= 4;
  return usesSourceTime ? result.excluded_fragments ?? [] : [];
}

export function clampRollToExclusions(start: number, end: number, rawStart: number, rawEnd: number, excluded: readonly ExcludedRange[]): [number, number] {
  for (const fragment of excluded) {
    if (fragment.end_time_seconds <= rawStart) start = Math.max(start, fragment.end_time_seconds);
    if (fragment.start_time_seconds > rawEnd) end = Math.min(end, fragment.start_time_seconds);
  }
  return [start, end];
}

export function finalRallyTailSeconds(method: RallyRecognitionMethod): number {
  return method === 'bounce_events' ? FINAL_RALLY_TAIL_SECONDS : 0;
}

export function rallyLeadInStart(rally: Rally, preRollSeconds: number, method: RallyRecognitionMethod): number {
  const boundary = method === 'continuous_visibility' && 'lead_in_start_time_seconds' in rally
    ? rally.lead_in_start_time_seconds ?? 0 : 0;
  return Math.max(0, rally.start_time_seconds - preRollSeconds, Math.min(rally.start_time_seconds, boundary));
}

export class SelectionError extends Error {
  constructor(public readonly code: 'NO_RALLIES' | 'NO_HIGHLIGHTS' | 'NO_CUSTOM_SELECTION' | 'INVALID_HIGHLIGHT_CRITERION') {
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
    const criterion = 'criterion' in selection
      ? selection.criterion
      : { kind: 'bounce_count' as const, threshold: selection.highlight_threshold };
    const method = rallyRecognitionMethod(result);
    if (criterion.kind === 'bounce_count' && !hasBounceCounts(result)) {
      throw new SelectionError('INVALID_HIGHLIGHT_CRITERION');
    }
    if (criterion.kind === 'duration_tier' && method !== 'continuous_visibility') {
      throw new SelectionError('INVALID_HIGHLIGHT_CRITERION');
    }
    const filtered = criterion.kind === 'bounce_count'
      ? (hasBounceCounts(result)
        ? rallies.filter((rally) => 'bounce_count' in rally && rally.bounce_count > criterion.threshold)
        : [])
      : rallies.filter((rally) => (
        rally.end_time_seconds - rally.start_time_seconds > DURATION_HIGHLIGHT_SECONDS[criterion.tier]
      ));
    if (filtered.length === 0) throw new SelectionError('NO_HIGHLIGHTS');
    return filtered;
  }

  throw new SelectionError('NO_CUSTOM_SELECTION');
}

export function buildCutGroups(
  rallies: readonly Rally[],
  preRollSeconds: number,
  postRollSeconds: number,
  videoDuration: number,
  recognitionMethod: RallyRecognitionMethod = 'bounce_events',
  excludedFragments: readonly ExcludedRange[] = [],
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
  const excludedBetween = (start: number, end: number) => excludedFragments.some(
    (fragment) => fragment.start_time_seconds < end && fragment.end_time_seconds > start,
  );
  for (const rally of ordered) {
    const current = raw.at(-1);
    if (current && !excludedBetween(current.rawEnd, rally.start_time_seconds)
      && rally.start_time_seconds - current.rawEnd < (recognitionMethod === 'hybrid_motion_bounce' ? 3 : 5 - EPSILON)) {
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
    const firstRally = ordered.find((rally) => rally.id === group.rallyIds[0])!;
    let start = rallyLeadInStart(firstRally, preRollSeconds, recognitionMethod);
    // Only bounce recognition needs the fixed tail; always apply the configured roll.
    let end = Math.min(videoDuration, group.rawEnd + finalRallyTailSeconds(recognitionMethod) + postRollSeconds);
    for (const fragment of excludedFragments) {
      if (fragment.end_time_seconds <= group.rawStart) start = Math.max(start, fragment.end_time_seconds);
      if (fragment.start_time_seconds >= group.rawEnd) end = Math.min(end, fragment.start_time_seconds);
    }
    if (end <= start) continue;
    const previous = expanded.at(-1);
    if (previous && start <= previous.end + EPSILON && !excludedBetween(previous.rawEnd, group.rawStart)) {
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
  if (selection.mode === 'custom') throw new SelectionError('NO_CUSTOM_SELECTION');
  const rallies = selectRallies(result, selection);
  return buildCutGroups(
    rallies,
    selection.pre_roll_seconds,
    selection.post_roll_seconds,
    result.video.duration_seconds,
    rallyRecognitionMethod(result),
    exportExclusions(result),
  );
}
