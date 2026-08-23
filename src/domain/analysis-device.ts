export type AnalysisDevice = 'auto' | 'cuda' | 'cpu';

export function requestedAnalysisDevice(requested: AnalysisDevice): AnalysisDevice {
  return requested;
}
