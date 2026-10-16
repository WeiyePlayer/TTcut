import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  it('loads bundled dependencies and probes the model despite a polluted Python environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-runtime-pollution-'));
    try {
      await mkdir(path.join(root, 'packages'));
      for (const name of ['numpy', 'cv2', 'onnxruntime']) {
        await writeFile(path.join(root, 'packages', `${name}.py`), 'raise RuntimeError("External Python dependency loaded")\n');
      }
      vi.stubEnv('PYTHONPATH', path.join(root, 'packages'));
      vi.stubEnv('PYTHONHOME', path.join(root, 'missing-home'));
      vi.stubEnv('PYTHONUSERBASE', root);
      const result = await validateAnalysisRuntime(python!);
      expect(result.acceleration).toMatch(/^(directml|cpu)$/);
      expect(Object.values(result.modulePaths)).toHaveLength(3);
      const site = path.resolve(path.dirname(python!), 'Lib', 'site-packages').toLowerCase() + path.sep;
      expect(Object.values(result.modulePaths).every((file) => path.resolve(file).toLowerCase().startsWith(site))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);

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
