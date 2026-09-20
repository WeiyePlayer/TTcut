import type { ComponentStatus } from '../shared/contracts';
import { inspectComponents } from './components';

let backgroundCheck: Promise<void> | undefined;

export async function inspectInstalledComponents(): Promise<ComponentStatus> {
  return inspectComponents();
}

export async function startupComponentStatus(): Promise<ComponentStatus> {
  return inspectComponents();
}

export function silentlyInspectComponents(onError: (error: unknown) => void): void {
  if (backgroundCheck) return;
  backgroundCheck = inspectComponents().then((status) => {
    for (const component of [status.analysis, status.media]) {
      if (component.detail) onError(new Error(component.detail));
    }
  }).catch(onError).finally(() => { backgroundCheck = undefined; });
}
