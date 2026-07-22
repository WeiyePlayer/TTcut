export const EXPORT_DURATION_TOLERANCE_SECONDS = 2;

export function isExportDurationWithinTolerance(actual: number, wanted: number): boolean {
  return Math.abs(actual - wanted) <= EXPORT_DURATION_TOLERANCE_SECONDS;
}
