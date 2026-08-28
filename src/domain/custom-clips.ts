import type {
  AnalysisResultV1,
  CustomExportSegment,
  CustomExportSegmentInput,
  CutGroup,
  Rally,
} from '../shared/contracts';
import { FINAL_RALLY_TAIL_SECONDS } from './segments';

const EPSILON = 1e-6;
const PRECISION = 1_000_000;

export type CustomClipSource = 'detected' | 'manual';

export type CustomRallyClip = {
  clipId: string;
  source: CustomClipSource;
  sourceRallyId: string | null;
  rallyIndex: number;
  bounceCount: number | null;
  defaultStart: number;
  defaultEnd: number;
  start: number;
  end: number;
  selected: boolean;
};

export type { CustomExportSegment } from '../shared/contracts';

export type ValidatedCustomExportSegment = CutGroup & {
  clipId: string;
  source: CustomClipSource;
  sourceRallyId: string | null;
  rallyIndex: number;
};

export class InvalidCustomSegmentsError extends Error {
  readonly exportCode = 'INVALID_CUSTOM_SEGMENTS';

  constructor() {
    super('INVALID_CUSTOM_SEGMENTS');
  }
}

function seconds(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

function orderedRallies(rallies: readonly Rally[]): Rally[] {
  return [...rallies].sort((left, right) => (
    left.start_time_seconds - right.start_time_seconds || left.index - right.index
  ));
}

function compareClips(left: CustomRallyClip, right: CustomRallyClip): number {
  return left.start - right.start || left.end - right.end || left.clipId.localeCompare(right.clipId);
}

export function frameDuration(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
}

export function reindexCustomClips(clips: readonly CustomRallyClip[]): CustomRallyClip[] {
  return [...clips].sort(compareClips).map((clip, index) => ({ ...clip, rallyIndex: index + 1 }));
}

export function calculateManualBounceCount(
  start: number,
  end: number,
  bounceTimesSeconds: readonly number[] | undefined,
): number | null {
  if (!bounceTimesSeconds) return null;
  return bounceTimesSeconds.filter((time) => Number.isFinite(time) && time >= start && time < end).length;
}

function normalizeSelected(
  clips: CustomRallyClip[],
  minimumDuration: number,
  lowerBound = 0,
  upperBound = Number.POSITIVE_INFINITY,
): CustomRallyClip[] {
  const selected = clips.filter((clip) => clip.selected);
  for (let index = 0; index < selected.length - 1; index += 1) {
    const left = selected[index]!;
    const right = selected[index + 1]!;
    if (left.end <= right.start + EPSILON) continue;
    const minimumBoundary = Math.max(lowerBound, left.start + minimumDuration);
    const maximumBoundary = Math.min(upperBound, right.end - minimumDuration);
    const midpoint = (left.end + right.start) / 2;
    const boundary = seconds(Math.max(minimumBoundary, Math.min(maximumBoundary, midpoint)));
    left.end = boundary;
    right.start = boundary;
  }
  return clips;
}

export function createCustomClipDraft(
  rallies: readonly Rally[],
  preRollSeconds: number,
  postRollSeconds: number,
  videoDuration: number,
  fps: number,
): CustomRallyClip[] {
  const minimumDuration = frameDuration(fps);
  const clips = orderedRallies(rallies).map((rally) => {
    const defaultStart = seconds(Math.max(0, rally.start_time_seconds - preRollSeconds));
    const defaultEnd = seconds(Math.min(
      videoDuration,
      rally.end_time_seconds + FINAL_RALLY_TAIL_SECONDS + postRollSeconds,
    ));
    const end = Math.max(defaultEnd, seconds(Math.min(videoDuration, defaultStart + minimumDuration)));
    return {
      clipId: rally.id,
      source: 'detected' as const,
      sourceRallyId: rally.id,
      rallyIndex: rally.index,
      bounceCount: 'bounce_count' in rally ? rally.bounce_count : null,
      defaultStart,
      defaultEnd: end,
      start: defaultStart,
      end,
      selected: true,
    };
  });
  return normalizeSelected(reindexCustomClips(clips), minimumDuration, 0, videoDuration);
}

function overlapsRange(clips: readonly CustomRallyClip[], start: number, end: number): boolean {
  return clips.some((clip) => start < clip.end - EPSILON && clip.start < end - EPSILON);
}

export function createManualCustomClip(
  clips: readonly CustomRallyClip[],
  clipId: string,
  start: number,
  videoDuration: number,
  bounceTimesSeconds: readonly number[] | undefined,
): CustomRallyClip[] | null {
  const end = seconds(start + 1);
  if (!clipId || !Number.isFinite(start) || start < 0 || end > videoDuration + EPSILON || overlapsRange(clips, start, end)) {
    return null;
  }
  const next = [
    ...clips.map((clip) => ({ ...clip })),
    {
      clipId,
      source: 'manual' as const,
      sourceRallyId: null,
      rallyIndex: 0,
      bounceCount: calculateManualBounceCount(start, end, bounceTimesSeconds),
      defaultStart: start,
      defaultEnd: end,
      start,
      end,
      selected: true,
    },
  ];
  return reindexCustomClips(next);
}

function selectedNeighbors(clips: readonly CustomRallyClip[], index: number) {
  return {
    previous: clips.slice(0, index).reverse().find((item) => item.selected),
    following: clips.slice(index + 1).find((item) => item.selected),
  };
}

function allNeighbors(clips: readonly CustomRallyClip[], clipId: string) {
  const ordered = [...clips].sort(compareClips);
  const index = ordered.findIndex((clip) => clip.clipId === clipId);
  return { previous: index > 0 ? ordered[index - 1] : undefined, following: ordered[index + 1] };
}

export function resizeCustomClip(
  clips: readonly CustomRallyClip[],
  clipId: string,
  edge: 'start' | 'end',
  requestedTime: number,
  videoDuration: number,
  fps: number,
  bounceTimesSeconds?: readonly number[],
): CustomRallyClip[] {
  const next = clips.map((clip) => ({ ...clip }));
  const index = next.findIndex((clip) => clip.clipId === clipId);
  const clip = next[index];
  if (!clip || !clip.selected || !Number.isFinite(requestedTime)) return next;
  const minimumDuration = frameDuration(fps);
  const { previous, following } = clip.source === 'manual'
    ? allNeighbors(next, clip.clipId)
    : selectedNeighbors(next, index);
  if (edge === 'start') {
    const minimum = previous?.end ?? 0;
    clip.start = seconds(Math.max(minimum, Math.min(clip.end - minimumDuration, requestedTime)));
  } else {
    const maximum = following?.start ?? videoDuration;
    clip.end = seconds(Math.min(maximum, Math.max(clip.start + minimumDuration, requestedTime)));
  }
  if (clip.source === 'manual') clip.bounceCount = calculateManualBounceCount(clip.start, clip.end, bounceTimesSeconds);
  return next;
}

function overlaps(left: CustomRallyClip, right: CustomRallyClip): boolean {
  return left.start < right.end - EPSILON && right.start < left.end - EPSILON;
}

export function setCustomClipSelected(
  clips: readonly CustomRallyClip[],
  clipId: string,
  selected: boolean,
  videoDuration: number,
  fps: number,
): CustomRallyClip[] {
  const next = clips.map((clip) => ({ ...clip }));
  const index = next.findIndex((clip) => clip.clipId === clipId);
  const target = next[index];
  if (!target || target.selected === selected) return next;
  target.selected = selected;
  if (!selected) return next;

  const conflicts = next.some((clip, clipIndex) => clipIndex !== index && clip.selected && overlaps(target, clip));
  if (!conflicts) return next;

  const directConflicts = next
    .map((clip, clipIndex) => ({ clip, clipIndex }))
    .filter(({ clip, clipIndex }) => clipIndex !== index && clip.selected && overlaps(target, clip))
    .map(({ clipIndex }) => clipIndex);
  let first = Math.min(index, ...directConflicts);
  let last = Math.max(index, ...directConflicts);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let clipIndex = 0; clipIndex < next.length; clipIndex += 1) {
      const candidate = next[clipIndex]!;
      if (!candidate.selected || (clipIndex >= first && clipIndex <= last)) continue;
      const regionStart = Math.min(...next.slice(first, last + 1).map((item) => item.defaultStart));
      const regionEnd = Math.max(...next.slice(first, last + 1).map((item) => item.defaultEnd));
      if (candidate.defaultStart < regionEnd - EPSILON && regionStart < candidate.defaultEnd - EPSILON) {
        first = Math.min(first, clipIndex);
        last = Math.max(last, clipIndex);
        expanded = true;
      }
    }
  }

  const previous = next.slice(0, first).reverse().find((clip) => clip.selected);
  const following = next.slice(last + 1).find((clip) => clip.selected);
  const region = next.slice(first, last + 1).filter((candidate) => candidate.selected).map((candidate) => ({
    ...candidate,
    start: Math.max(previous?.end ?? 0, candidate.defaultStart),
    end: Math.min(following?.start ?? videoDuration, candidate.defaultEnd),
  }));
  normalizeSelected(region, frameDuration(fps), previous?.end ?? 0, following?.start ?? videoDuration);
  const rebuilt = new Map(region.map((candidate) => [candidate.clipId, candidate]));
  return next.map((candidate) => rebuilt.get(candidate.clipId) ?? candidate);
}

export function deleteCustomClip(clips: readonly CustomRallyClip[], clipId: string): CustomRallyClip[] {
  return reindexCustomClips(clips.filter((clip) => clip.clipId !== clipId));
}

export function customExportSegments(clips: readonly CustomRallyClip[]): CustomExportSegment[] {
  return clips.filter((clip) => clip.selected).map((clip) => {
    const timing = {
      clip_id: clip.clipId,
      display_index: clip.rallyIndex,
      start_time_seconds: clip.start,
      end_time_seconds: clip.end,
    };
    if (clip.source === 'manual') return { ...timing, source: 'manual' as const };
    if (!clip.sourceRallyId) throw new InvalidCustomSegmentsError();
    return { ...timing, source: 'detected' as const, rally_id: clip.sourceRallyId };
  });
}

type NormalizedCustomExportSegment = {
  clipId: string;
  source: CustomClipSource;
  sourceRallyId: string | null;
  rallyIndex: number;
  start: number;
  end: number;
};

function normalizeCustomExportSegment(
  result: AnalysisResultV1,
  segment: CustomExportSegmentInput,
): NormalizedCustomExportSegment {
  const rallies = new Map(result.rallies.map((rally) => [rally.id, rally]));
  if (!('source' in segment)) {
    const rally = rallies.get(segment.rally_id);
    if (!rally) throw new InvalidCustomSegmentsError();
    return {
      clipId: segment.rally_id,
      source: 'detected',
      sourceRallyId: segment.rally_id,
      rallyIndex: rally.index,
      start: segment.start_time_seconds,
      end: segment.end_time_seconds,
    };
  }
  if (segment.source === 'manual') {
    return {
      clipId: segment.clip_id,
      source: 'manual',
      sourceRallyId: null,
      rallyIndex: segment.display_index,
      start: segment.start_time_seconds,
      end: segment.end_time_seconds,
    };
  }
  if (!rallies.has(segment.rally_id)) throw new InvalidCustomSegmentsError();
  return {
    clipId: segment.clip_id,
    source: 'detected',
    sourceRallyId: segment.rally_id,
    rallyIndex: segment.display_index,
    start: segment.start_time_seconds,
    end: segment.end_time_seconds,
  };
}

export function validateCustomExportSegments(
  result: AnalysisResultV1,
  segments: readonly CustomExportSegmentInput[],
): ValidatedCustomExportSegment[] {
  if (!segments.length) throw new InvalidCustomSegmentsError();
  const seenClipIds = new Set<string>();
  const seenRallyIds = new Set<string>();
  const minimumDuration = frameDuration(result.video.fps);
  const groups: ValidatedCustomExportSegment[] = [];
  let previousStart = -1;
  let previousEnd = -1;
  let previousIndex = 0;

  for (const rawSegment of segments) {
    const segment = normalizeCustomExportSegment(result, rawSegment);
    if (seenClipIds.has(segment.clipId)
      || (segment.sourceRallyId !== null && seenRallyIds.has(segment.sourceRallyId))
      || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end > result.video.duration_seconds
      || segment.end - segment.start + EPSILON < minimumDuration
      || segment.start < previousStart || segment.start < previousEnd
      || segment.rallyIndex <= previousIndex) {
      throw new InvalidCustomSegmentsError();
    }
    seenClipIds.add(segment.clipId);
    if (segment.sourceRallyId !== null) seenRallyIds.add(segment.sourceRallyId);
    groups.push({
      clipId: segment.clipId,
      source: segment.source,
      sourceRallyId: segment.sourceRallyId,
      rallyIndex: segment.rallyIndex,
      rallyIds: [segment.clipId],
      rawStart: segment.start,
      rawEnd: segment.end,
      start: segment.start,
      end: segment.end,
    });
    previousStart = segment.start;
    previousEnd = segment.end;
    previousIndex = segment.rallyIndex;
  }
  return groups;
}

export function validateAndBuildCustomCutGroups(
  result: AnalysisResultV1,
  segments: readonly CustomExportSegmentInput[],
): CutGroup[] {
  const groups: CutGroup[] = [];
  for (const segment of validateCustomExportSegments(result, segments)) {
    const previous = groups.at(-1);
    if (previous && segment.start === previous.end) {
      previous.end = segment.end;
      previous.rawEnd = segment.end;
      previous.rallyIds.push(segment.clipId);
    } else {
      groups.push({
        rallyIds: [segment.clipId],
        rawStart: segment.start,
        rawEnd: segment.end,
        start: segment.start,
        end: segment.end,
      });
    }
  }
  return groups;
}
