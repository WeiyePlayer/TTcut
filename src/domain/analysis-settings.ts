import type { AnalysisBackend, AppSettings } from '../shared/contracts';

/** Export timing follows the result backend, independently of the next-analysis preference. */
export function analysisRollSettings(settings: AppSettings, backend: AnalysisBackend) {
  return backend === 'mobilenet_small'
    ? { pre_roll_seconds: settings.small_pre_roll_seconds ?? 0, post_roll_seconds: 0 as const }
    : { pre_roll_seconds: settings.pre_roll_seconds, post_roll_seconds: settings.post_roll_seconds };
}
