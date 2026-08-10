import type { BallModelProfile } from '../shared/contracts';

export type AnalysisDevice = 'auto' | 'cuda' | 'cpu';

export function requestedAnalysisDevice(
  _profile: BallModelProfile,
  requested: AnalysisDevice,
): AnalysisDevice {
  return requested;
}
