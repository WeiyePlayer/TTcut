import type { BallModelProfile } from '../shared/contracts';

export type AnalysisDevice = 'auto' | 'cuda' | 'cpu';

export function requestedAnalysisDevice(
  profile: BallModelProfile,
  requested: AnalysisDevice,
): AnalysisDevice {
  return profile === 'uplifting_dual_v1' ? 'cuda' : requested;
}
