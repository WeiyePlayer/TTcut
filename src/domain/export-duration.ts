import type { VideoMetadata } from '../shared/contracts';

const MINIMUM_DURATION_TOLERANCE_SECONDS = 0.1;
const MISSING_AUDIO_SAMPLE_RATE_QUANTUM_SECONDS = 0.05;
const TIMING_EPSILON_SECONDS = 0.001;

export type ExportTimingAssessment = {
  targetSeconds: number;
  actualSeconds: number;
  driftSeconds: number;
  absoluteDriftSeconds: number;
  allowedDriftSeconds: number;
  quantumSeconds: number;
  segmentCount: number;
  withinTolerance: boolean;
};

export type FastConcatTimingAssessment = {
  encodedSegments: ExportTimingAssessment;
  requestedClips: ExportTimingAssessment;
};

function positive(value: number | null | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

function timeBaseSeconds(value: string | null | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!positive(numerator) || !positive(denominator)) return 0;
  return numerator / denominator;
}

export function exportMediaQuantumSeconds(source: VideoMetadata): number {
  const rates = [source.fps, source.nominal_fps].filter(positive);
  const effectiveFps = Math.min(...rates);
  const videoFrameQuantum = 1 / effectiveFps;
  const audioFrameQuantum = source.audio_codec === null
    ? 0
    : positive(source.audio_sample_rate)
      ? 1024 / source.audio_sample_rate
      : MISSING_AUDIO_SAMPLE_RATE_QUANTUM_SECONDS;
  return Math.max(
    videoFrameQuantum,
    audioFrameQuantum,
    timeBaseSeconds(source.video_time_base),
    timeBaseSeconds(source.audio_time_base),
  );
}

export function assessExportDuration(
  actualSeconds: number,
  targetSeconds: number,
  segmentCount: number,
  source: VideoMetadata,
): ExportTimingAssessment {
  const normalizedSegmentCount = Math.max(1, Math.trunc(segmentCount));
  const quantumSeconds = exportMediaQuantumSeconds(source);
  const allowedDriftSeconds = Math.max(
    MINIMUM_DURATION_TOLERANCE_SECONDS,
    (2 * normalizedSegmentCount + 1) * quantumSeconds + TIMING_EPSILON_SECONDS,
  );
  const driftSeconds = actualSeconds - targetSeconds;
  const absoluteDriftSeconds = Math.abs(driftSeconds);
  return {
    targetSeconds,
    actualSeconds,
    driftSeconds,
    absoluteDriftSeconds,
    allowedDriftSeconds,
    quantumSeconds,
    segmentCount: normalizedSegmentCount,
    withinTolerance: absoluteDriftSeconds <= allowedDriftSeconds,
  };
}

export function assessFastConcatDuration(
  actualSeconds: number,
  encodedSegmentDurations: readonly number[],
  requestedSeconds: number,
  source: VideoMetadata,
): FastConcatTimingAssessment {
  return {
    encodedSegments: assessExportDuration(
      actualSeconds,
      encodedSegmentDurations.reduce((total, duration) => total + duration, 0),
      1,
      source,
    ),
    requestedClips: assessExportDuration(
      actualSeconds,
      requestedSeconds,
      encodedSegmentDurations.length,
      source,
    ),
  };
}
