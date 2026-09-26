import type { ComponentStatus } from '../shared/contracts';
import { inspectComponents } from './components';
import { logLine } from './logger';

let backgroundCheck: Promise<void> | undefined;

export async function inspectInstalledComponents(): Promise<ComponentStatus> {
  const status = await inspectComponents();
  await logLine('app', status.analysis.available && status.media.available ? 'INFO' : 'WARN',
    `Component check result: ${JSON.stringify(status)}`).catch(() => undefined);
  return status;
}

export async function startupComponentStatus(): Promise<ComponentStatus> {
  return inspectInstalledComponents();
}

export function silentlyInspectComponents(onError: (error: unknown) => void): void {
  if (backgroundCheck) return;
  backgroundCheck = inspectInstalledComponents().then((status) => {
    for (const component of [status.analysis, status.media]) {
      if (component.detail) onError(new Error(component.detail));
    }
  }).catch(onError).finally(() => { backgroundCheck = undefined; });
}
