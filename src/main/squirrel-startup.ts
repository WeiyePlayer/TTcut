import { spawn } from 'node:child_process';
import { app } from 'electron';
import { squirrelEventPlan } from './squirrel-event-plan';

/**
 * Handles the short-lived process Squirrel launches during install/update/uninstall.
 * Returning true means normal application startup must be skipped.
 */
export function handleSquirrelStartup(): boolean {
  const plan = squirrelEventPlan(process.platform, process.argv[1], process.execPath);
  if (!plan) return false;

  if (plan.kind === 'quit') {
    app.quit();
    return true;
  }

  const child = spawn(plan.updateExecutable, plan.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', () => app.quit());
  child.unref();

  // Squirrel requires this helper instance to exit promptly even if Update.exe stalls.
  setTimeout(() => app.quit(), 1_000);
  return true;
}
