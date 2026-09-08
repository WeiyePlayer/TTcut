export const SEGMENT_ENCODING_PROGRESS_END = 90;
export const IN_FLIGHT_EXPORT_PROGRESS_END = 99;
export const STREAM_COPY_ATTEMPT_PROGRESS_END = 10;

export type FfmpegProgressRange = {
  startPercent: number;
  endPercent: number;
};

export function mapFfmpegProgress(
  processedSeconds: number,
  durationSeconds: number,
  range: FfmpegProgressRange = { startPercent: 0, endPercent: IN_FLIGHT_EXPORT_PROGRESS_END },
): number {
  const fraction = Number.isFinite(processedSeconds) && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(0, Math.min(1, processedSeconds / durationSeconds))
    : 0;
  const mapped = range.startPercent + fraction * (range.endPercent - range.startPercent);
  return Math.max(0, Math.min(IN_FLIGHT_EXPORT_PROGRESS_END, mapped));
}
