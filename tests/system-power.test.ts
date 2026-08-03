import { describe, expect, it, vi } from 'vitest';
import { requestSystemShutdown } from '../src/main/system-power';

describe('system shutdown', () => {
  it('waits for active work before invoking the Windows shutdown command', async () => {
    let busyChecks = 0;
    const run = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await requestSystemShutdown({
      platform: 'win32',
      isBusy: () => busyChecks++ < 2,
      wait,
      run,
    });

    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(50);
    expect(run).toHaveBeenCalledWith('shutdown.exe', ['/s', '/t', '0']);
  });

  it('rejects unsupported platforms without invoking a command', async () => {
    const run = vi.fn();
    await expect(requestSystemShutdown({ platform: 'linux', run }))
      .rejects.toThrow('SYSTEM_SHUTDOWN_UNSUPPORTED');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not shut down while active work remains past the wait limit', async () => {
    const run = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(requestSystemShutdown({
      platform: 'win32',
      isBusy: () => true,
      wait,
      run,
    })).rejects.toThrow('TASK_BUSY');
    expect(wait).toHaveBeenCalledTimes(200);
    expect(run).not.toHaveBeenCalled();
  });
});
