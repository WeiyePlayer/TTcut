import { execFile } from 'node:child_process';

type ShutdownDependencies = {
  platform?: NodeJS.Platform;
  isBusy?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  run?: (command: string, args: readonly string[]) => Promise<void>;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runShutdown(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { windowsHide: true }, (error) => {
      if (error) reject(new Error('SYSTEM_SHUTDOWN_FAILED'));
      else resolve();
    });
  });
}

export async function requestSystemShutdown({
  platform = process.platform,
  isBusy = () => false,
  wait: waitFor = wait,
  run = runShutdown,
}: ShutdownDependencies = {}): Promise<void> {
  if (platform !== 'win32') throw new Error('SYSTEM_SHUTDOWN_UNSUPPORTED');

  for (let attempt = 0; attempt < 200 && isBusy(); attempt += 1) {
    await waitFor(50);
  }
  if (isBusy()) throw new Error('TASK_BUSY');

  await run('shutdown.exe', ['/s', '/t', '0']);
}
