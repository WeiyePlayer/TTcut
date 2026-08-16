import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  result: null as null | { stdout: string; stderr: string; code: number },
  error: null as unknown,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
}));

vi.mock('../src/main/processes', () => ({
  ProcessExecutionError: class ProcessExecutionError extends Error {
    constructor(
      message: string,
      details: { stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null },
    ) {
      super(message);
      this.name = 'ProcessExecutionError';
      Object.assign(this, details);
    }
  },
  runProcess: vi.fn(async () => {
    if (processMock.error) throw processMock.error;
    return processMock.result ?? {
      stdout: JSON.stringify(processMock.value),
      stderr: '',
      code: 0,
    };
  }),
}));

import {
  AnalysisRuntimeValidationError,
  formatAnalysisRuntimeDiagnostics,
  validateAnalysisRuntime,
} from '../src/main/components';
import { ProcessExecutionError } from '../src/main/processes';

describe('analysis runtime validation', () => {
  beforeEach(() => {
    processMock.result = null;
    processMock.error = null;
    processMock.value = {
      python_executable: 'D:\\TTcut\\runtime\\python.exe',
      python: '3.12.13',
      torch: '2.12.1+cu126',
      torch_cuda: '12.6',
      opencv: '4.13.0',
      numpy: '2.5.1',
      acceleration: 'cuda',
      cuda_available: true,
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
    const error = await validateAnalysisRuntime('python.exe', 'cu126').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnalysisRuntimeValidationError);
    expect(error).toMatchObject({
      message: 'CUDA_RUNTIME_SELF_TEST_FAILED',
      diagnostics: {
        pythonExecutable: 'D:\\TTcut\\runtime\\python.exe',
        torchVersion: '2.12.1+cu126',
        torchCudaVersion: '12.6',
        cudaAvailable: true,
        gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU',
        gpuCapability: [8, 9],
        cudaArchList: ['sm_89'],
        stderr: '',
        exitCode: 0,
      },
    });
    const formatted = formatAnalysisRuntimeDiagnostics(error);
    for (const field of [
      'python.exe path=',
      'torch.__version__=',
      'torch.version.cuda=',
      'torch.cuda.is_available()=',
      'GPU name=',
      'GPU capability=',
      'torch.cuda.get_arch_list()=',
      'stdout=',
      'stderr=',
      'exit code=',
    ]) expect(formatted).toContain(field);
  });

  it('preserves partial diagnostics and raw streams when importing torch exits nonzero', async () => {
    const stdout = JSON.stringify({
      python_executable: 'D:\\TTcut\\runtime\\python.exe',
      torch: null,
      torch_cuda: null,
      cuda_available: null,
      device_name: null,
      device_capability: null,
      cuda_arch_list: null,
    });
    processMock.error = new ProcessExecutionError(
      'torch DLL initialization failed',
      {
        stdout,
        stderr: 'OSError: Error loading c10.dll',
        exitCode: 1,
        signal: null,
      },
    );

    const error = await validateAnalysisRuntime('D:\\TTcut\\runtime\\python.exe', 'cu126')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: 'CUDA_RUNTIME_SELF_TEST_FAILED',
      diagnostics: {
        pythonExecutable: 'D:\\TTcut\\runtime\\python.exe',
        torchVersion: null,
        torchCudaVersion: null,
        cudaAvailable: null,
        gpuName: null,
        gpuCapability: null,
        cudaArchList: null,
        stdout,
        stderr: 'OSError: Error loading c10.dll',
        exitCode: 1,
      },
    });
    const formatted = formatAnalysisRuntimeDiagnostics(error);
    expect(formatted).toContain('torch.__version__=null');
    expect(formatted).toContain('stderr="OSError: Error loading c10.dll"');
    expect(formatted).toContain('exit code=1');
  });
});
