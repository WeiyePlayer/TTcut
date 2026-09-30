import {
  DURATION_HIGHLIGHT_SECONDS,
  hasBounceCounts,
  rallyRecognitionMethod,
  usesDurationHighlights,
  type AnalysisResultV1,
  type CutGroup,
  type CutSelectionV1,
  type Rally,
  type RallyRecognitionMethod,
} from '../shared/contracts';
import { keepsSmallRally, SMALL_POST_ROLL_SECONDS, SMALL_SERVE_LEAD_SECONDS } from './small-rally-policy';

const EPSILON = 1e-9;
export const FINAL_RALLY_TAIL_SECONDS = 1;

export function finalRallyTailSeconds(method: RallyRecognitionMethod): number {
  if (method === 'mobilenet_small') return SMALL_POST_ROLL_SECONDS;
  return method === 'bounce_events' ? FINAL_RALLY_TAIL_SECONDS : 0;
}

export function rallyClipEnd(rallyEnd: number, postRollSeconds: number, videoDuration: number, method: RallyRecognitionMethod): number {
  return Math.min(videoDuration, rallyEnd + finalRallyTailSeconds(method)
    + (method === 'mobilenet_small' ? 0 : postRollSeconds));
}

export function rallyLeadInStart(rally: Rally, preRollSeconds: number, method: RallyRecognitionMethod): number {
  if (method === 'mobilenet_small' && 'phases' in rally) {
    if (rally.default_clip_start_time_seconds !== undefined) return Math.max(0, rally.default_clip_start_time_seconds - preRollSeconds);
    // Short or missing serves get 1.5 seconds before the recognized rally.
    // Longer serves keep their final 1.5 seconds before play.
    const firstPlay = rally.phases.find((phase) => phase.label === 'play');
    const serve = rally.phases.find((phase) => phase.label === 'serve'
      && (!firstPlay || phase.end_sec <= firstPlay.start_sec));
    const start = serve && serve.end_sec - serve.start_sec >= SMALL_SERVE_LEAD_SECONDS
      ? serve.end_sec - SMALL_SERVE_LEAD_SECONDS : rally.start_time_seconds - SMALL_SERVE_LEAD_SECONDS;
    return Math.max(0, start - preRollSeconds);
  }
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
  const eligible = rallyRecognitionMethod(result) === 'mobilenet_small' ? result.rallies.filter(keepsSmallRally) : result.rallies;
  const unique = new Map(eligible.map((rally) => [rally.id, rally]));
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
    if (criterion.kind === 'duration_tier' && !usesDurationHighlights(method)) {
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
  excludedFragments: readonly { start_time_seconds: number; end_time_seconds: number }[] = [],
): CutGroup[] {
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) return [];
  if (!Number.isFinite(preRollSeconds) || preRollSeconds < 0) return [];
  if (!Number.isFinite(postRollSeconds) || postRollSeconds < 0) return [];

  const seen = new Set<string>();
  const ordered = rallies
    .filter((rally) => {
      if (recognitionMethod === 'mobilenet_small' && !keepsSmallRally(rally)) return false;
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
    if (recognitionMethod !== 'mobilenet_small' && current && !excludedBetween(current.rawEnd, rally.start_time_seconds)
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
    let end = rallyClipEnd(group.rawEnd, postRollSeconds, videoDuration, recognitionMethod);
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
    'excluded_fragments' in result && result.rally_recognition.version >= 4 ? result.excluded_fragments : [],
  );
}

