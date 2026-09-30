import type { AnalysisResultV1 } from '../shared/contracts';
import { rallyLeadInStart } from './segments';
import { keepsSmallRally } from './small-rally-policy';

/** Persist the editing boundary separately from the source decoder's recognition evidence. */
export function updateSmallHistoryBoundaries(analysis: AnalysisResultV1): AnalysisResultV1 {
  if (analysis.schema_version !== 4) return analysis;
  let changed = false;
  const eligible = analysis.rallies.filter(keepsSmallRally);
  changed = eligible.length !== analysis.rallies.length;
  const rallies = eligible.map((rally, index) => {
    const { default_clip_start_time_seconds: previous, ...source } = rally;
    const start = rallyLeadInStart(source, 0, 'mobilenet_small');
    const id = `rally_${String(index + 1).padStart(3, '0')}`;
    if (previous === start && rally.index === index + 1 && rally.id === id) return rally;
    changed = true;
    return { ...rally, id, index: index + 1, default_clip_start_time_seconds: start };
  });
  return changed ? { ...analysis, rallies } : analysis;
}
