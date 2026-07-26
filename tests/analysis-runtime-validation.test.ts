import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
}));

vi.mock('../src/main/processes', () => ({
  runProcess: vi.fn(async () => ({
    stdout: JSON.stringify(processMock.value),
    stderr: '',
    code: 0,
  })),
}));

import { validateAnalysisRuntime } from '../src/main/components';

describe('analysis runtime validation', () => {
  beforeEach(() => {
    processMock.value = {
      python: '3.12.13',
      torch: '2.12.1+cu126',
      torch_cuda: '12.6',
      opencv: '4.13.0',
      numpy: '2.5.1',
      acceleration: 'cuda',
      cuda_smoke: true,
      device_name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      device_capability: [8, 9],
      cuda_arch_list: ['sm_50', 'sm_60', 'sm_70', 'sm_80', 'sm_86', 'sm_90'],
      compiled_arch_list: ['sm_50', 'sm_60', 'sm_70', 'sm_80', 'sm_86', 'sm_90'],
    };
  });

  it('accepts cu126 when the CUDA smoke test succeeds even if sm_89 is absent from the arch list', async () => {
    await expect(validateAnalysisRuntime('python.exe', 'cu126')).resolves.toMatchObject({
      acceleration: 'cuda',
      variant: 'cu126',
      torchVersion: '2.12.1+cu126',
    });
  });

  it('still rejects cu126 when the real CUDA smoke test fails', async () => {
    processMock.value = {
      ...processMock.value,
      cuda_smoke: false,
      cuda_smoke_error: 'CUDA kernel launch failed',
      cuda_arch_list: ['sm_89'],
      compiled_arch_list: ['sm_89'],
    };
    await expect(validateAnalysisRuntime('python.exe', 'cu126'))
      .rejects.toThrow('CUDA_RUNTIME_SELF_TEST_FAILED');
  });
});
