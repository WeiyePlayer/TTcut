import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
}));

import { inspectComponentPaths, resolveComponents, validateAnalysisRuntime } from '../src/main/components';

const python = process.env.TTCUT_ANALYSIS_RUNTIME_INTEGRATION;

describe.skipIf(!python)('real analysis runtime validation', () => {
  it('accepts the bundled ONNX runtime after a real import probe', async () => {
    if (!python) throw new Error('TTCUT_ANALYSIS_RUNTIME_INTEGRATION is required.');
    await expect(validateAnalysisRuntime(python)).resolves.toMatchObject({
      pythonVersion: '3.12.13',
      onnxRuntimeVersion: '1.24.3',
      acceleration: expect.stringMatching(/^(directml|cpu)$/),
      variant: 'bundled',
    });
  }, 60_000);

  it('passes the real model, analysis and media component checks', async () => {
    const paths = await resolveComponents();
    await expect(inspectComponentPaths({ ...paths, python: python! })).resolves.toMatchObject({
      analysis: { available: true, detail: null }, media: { available: true, detail: null },
    });
  }, 120_000);
});
