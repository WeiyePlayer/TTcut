import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  error: null as unknown,
}));

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } }));
vi.mock('../src/main/processes', () => ({
  ProcessExecutionError: class ProcessExecutionError extends Error {
    stdout: string; stderr: string; exitCode: number | null;
    constructor(message: string, details: { stdout: string; stderr: string; exitCode: number | null }) {
      super(message); this.stdout = details.stdout; this.stderr = details.stderr; this.exitCode = details.exitCode;
    }
  },
  runProcess: vi.fn(async () => {
    if (processMock.error) throw processMock.error;
    return { stdout: JSON.stringify(processMock.value), stderr: '', code: 0 };
  }),
}));

import { AnalysisRuntimeValidationError, formatAnalysisRuntimeDiagnostics, validateAnalysisRuntime } from '../src/main/components';
import { ProcessExecutionError } from '../src/main/processes';

describe('bundled ONNX runtime validation', () => {
  beforeEach(() => {
    processMock.error = null;
    processMock.value = {
      python_executable: 'D:\\TTcut\\windows\\python\\python.exe',
      python: '3.12.13', numpy: '2.5.1', opencv: '4.13.0', onnxruntime: '1.24.3',
      providers: ['DmlExecutionProvider', 'CPUExecutionProvider'],
    };
  });

  it('accepts the pinned runtime and reports DirectML availability', async () => {
    await expect(validateAnalysisRuntime('python.exe')).resolves.toEqual({
      version: 'Python 3.12.13 / ONNX Runtime 1.24.3',
      pythonVersion: '3.12.13', onnxRuntimeVersion: '1.24.3', acceleration: 'directml', variant: 'bundled',
    });
  });

  it('accepts CPU-only availability but rejects a runtime without CPU', async () => {
    processMock.value.providers = ['CPUExecutionProvider'];
    await expect(validateAnalysisRuntime('python.exe')).resolves.toMatchObject({ acceleration: 'cpu' });
    processMock.value.providers = ['DmlExecutionProvider'];
    await expect(validateAnalysisRuntime('python.exe')).rejects.toMatchObject({
      message: 'ANALYSIS_RUNTIME_VERSION_MISMATCH',
      diagnostics: { providers: ['DmlExecutionProvider'] },
    });
  });

  it('preserves raw streams when importing ONNX Runtime fails', async () => {
    processMock.error = new ProcessExecutionError('DLL initialization failed', {
      stdout: '', stderr: 'OSError: Error loading onnxruntime.dll', exitCode: 1, signal: null,
    });
    const error = await validateAnalysisRuntime('D:\\TTcut\\windows\\python\\python.exe').catch((value) => value);
    expect(error).toBeInstanceOf(AnalysisRuntimeValidationError);
    expect(error).toMatchObject({
      message: 'ANALYSIS_RUNTIME_SELF_TEST_FAILED',
      diagnostics: { pythonExecutable: 'D:\\TTcut\\windows\\python\\python.exe', onnxRuntimeVersion: null, providers: [], exitCode: 1 },
    });
    expect(formatAnalysisRuntimeDiagnostics(error)).toContain('stderr="OSError: Error loading onnxruntime.dll"');
  });
});
