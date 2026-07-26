import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
}));

import { validateAnalysisRuntime } from '../src/main/components';

const python = process.env.TTCUT_ANALYSIS_RUNTIME_INTEGRATION;

describe.skipIf(!python)('real analysis runtime validation', () => {
  it('accepts the installed cu126 runtime after a real CUDA smoke test', async () => {
    if (!python) throw new Error('TTCUT_ANALYSIS_RUNTIME_INTEGRATION is required.');
    await expect(validateAnalysisRuntime(python, 'cu126')).resolves.toMatchObject({
      pythonVersion: '3.12.13',
      torchVersion: '2.12.1+cu126',
      acceleration: 'cuda',
      variant: 'cu126',
    });
  }, 60_000);
});
