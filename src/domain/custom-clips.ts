import type { AnalysisResultV1, CutGroup, Rally } from '../shared/contracts';
import { FINAL_RALLY_TAIL_SECONDS } from './segments';

const EPSILON = 1e-6;
const PRECISION = 1_000_000;

export type CustomRallyClip = {
  rallyId: string;
  rallyIndex: number;
  bounceCount: number;
  defaultStart: number;
  defaultEnd: number;
  start: number;
  end: number;
  selected: boolean;
};

export type CustomExportSegment = {
  rally_id: string;
  start_time_seconds: number;
  end_time_seconds: number;
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

export function frameDuration(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
}

function orderedRallies(rallies: readonly Rally[]): Rally[] {
  return [...rallies].sort((left, right) => (
    left.start_time_seconds - right.start_time_seconds || left.index - right.index
  ));
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
      rallyId: rally.id,
      rallyIndex: rally.index,
      bounceCount: rally.bounce_count,
      defaultStart,
      defaultEnd: end,
      start: defaultStart,
      end,
      selected: true,
    };
  });
  return normalizeSelected(clips, minimumDuration, 0, videoDuration);
}

export function resizeCustomClip(
  clips: readonly CustomRallyClip[],
  rallyId: string,
  edge: 'start' | 'end',
  requestedTime: number,
  videoDuration: number,
  fps: number,
): CustomRallyClip[] {
  const next = clips.map((clip) => ({ ...clip }));
  const index = next.findIndex((clip) => clip.rallyId === rallyId);
  const clip = next[index];
  if (!clip || !clip.selected || !Number.isFinite(requestedTime)) return next;
  const minimumDuration = frameDuration(fps);
  const previous = next.slice(0, index).reverse().find((item) => item.selected);
  const following = next.slice(index + 1).find((item) => item.selected);
  if (edge === 'start') {
    const minimum = previous?.end ?? 0;
    clip.start = seconds(Math.max(minimum, Math.min(clip.end - minimumDuration, requestedTime)));
  } else {
    const maximum = following?.start ?? videoDuration;
    clip.end = seconds(Math.min(maximum, Math.max(clip.start + minimumDuration, requestedTime)));
  }
  return next;
}

function overlaps(left: CustomRallyClip, right: CustomRallyClip): boolean {
  return left.start < right.end - EPSILON && right.start < left.end - EPSILON;
}

export function setCustomClipSelected(
  clips: readonly CustomRallyClip[],
  rallyId: string,
  selected: boolean,
  videoDuration: number,
  fps: number,
): CustomRallyClip[] {
  const next = clips.map((clip) => ({ ...clip }));
  const index = next.findIndex((clip) => clip.rallyId === rallyId);
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
      const clip = next[clipIndex]!;
      if (!clip.selected || (clipIndex >= first && clipIndex <= last)) continue;
      const regionStart = Math.min(...next.slice(first, last + 1).map((item) => item.defaultStart));
      const regionEnd = Math.max(...next.slice(first, last + 1).map((item) => item.defaultEnd));
      if (clip.defaultStart < regionEnd - EPSILON && regionStart < clip.defaultEnd - EPSILON) {
        first = Math.min(first, clipIndex);
        last = Math.max(last, clipIndex);
        expanded = true;
      }
    }
  }

  const previous = next.slice(0, first).reverse().find((clip) => clip.selected);
  const following = next.slice(last + 1).find((clip) => clip.selected);
  const region = next.slice(first, last + 1).filter((clip) => clip.selected).map((clip) => ({
    ...clip,
    start: Math.max(previous?.end ?? 0, clip.defaultStart),
    end: Math.min(following?.start ?? videoDuration, clip.defaultEnd),
  }));
  normalizeSelected(region, frameDuration(fps), previous?.end ?? 0, following?.start ?? videoDuration);
  const rebuilt = new Map(region.map((clip) => [clip.rallyId, clip]));
  return next.map((clip) => rebuilt.get(clip.rallyId) ?? clip);
}

export function customExportSegments(clips: readonly CustomRallyClip[]): CustomExportSegment[] {
  return clips.filter((clip) => clip.selected).map((clip) => ({
    rally_id: clip.rallyId,
    start_time_seconds: clip.start,
    end_time_seconds: clip.end,
  }));
}

export function validateAndBuildCustomCutGroups(
  result: AnalysisResultV1,
  segments: readonly CustomExportSegment[],
): CutGroup[] {
  if (!segments.length) throw new InvalidCustomSegmentsError();
  const rallies = new Map(result.rallies.map((rally) => [rally.id, rally]));
  const seen = new Set<string>();
  const minimumDuration = frameDuration(result.video.fps);
  const groups: CutGroup[] = [];
  let previousStart = -1;
  let previousEnd = -1;

  for (const segment of segments) {
    const rally = rallies.get(segment.rally_id);
    const start = segment.start_time_seconds;
    const end = segment.end_time_seconds;
    if (!rally || seen.has(segment.rally_id)
      || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end > result.video.duration_seconds
      || end - start + EPSILON < minimumDuration
      || start < previousStart
      || start < previousEnd) {
      throw new InvalidCustomSegmentsError();
    }
    seen.add(segment.rally_id);
    const previous = groups.at(-1);
    if (previous && start === previous.end) {
      previous.end = end;
      previous.rawEnd = end;
      previous.rallyIds.push(segment.rally_id);
    } else {
      groups.push({ rallyIds: [segment.rally_id], rawStart: start, rawEnd: end, start, end });
    }
    previousStart = start;
    previousEnd = end;
  }
  return groups;
}
