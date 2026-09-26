// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ root: '', run: vi.fn(), log: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => mock.root } }));
vi.mock('../src/main/logger', () => ({ logLine: mock.log }));
vi.mock('../src/main/processes', async (original) => ({
  ...await original<typeof import('../src/main/processes')>(), runProcess: mock.run,
}));
import { inspectComponentPaths, type ComponentPaths } from '../src/main/components';
import { ProcessExecutionError } from '../src/main/processes';

let paths: ComponentPaths;
beforeEach(async () => {
  mock.root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-inspection-'));
  const modelRoot = path.join(mock.root, 'resources', 'models');
  await mkdir(modelRoot, { recursive: true });
  const bytes = Buffer.from('test model');
  const models = ['blurball_best.onnx', 'table_analyze.onnx'].map((filename) => ({
    filename, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  for (const { filename } of models) await writeFile(path.join(modelRoot, filename), bytes);
  await writeFile(path.join(mock.root, 'resources', 'model-manifest.json'), JSON.stringify({ schema_version: 2, opset: 20, models }));
  paths = {
    python: path.join(mock.root, 'python.exe'), runtimeVariant: 'bundled', worker: path.join(mock.root, 'worker'),
    blurballWeights: path.join(modelRoot, 'blurball_best.onnx'), tracknetWeights: null,
    tableAnalyzeWeights: path.join(modelRoot, 'table_analyze.onnx'),
    ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe', mediaEncoder: 'libx264',
  };
  mock.log.mockReset().mockResolvedValue(undefined);
  mock.run.mockReset().mockImplementation(async (executable: string, args: string[]) => ({
    code: 0, stderr: '', stdout: args[0] === '-c' ? JSON.stringify({
      python: '3.12.13', numpy: '2.5.1', opencv: '4.13.0', onnxruntime: '1.24.3', providers: ['CPUExecutionProvider'],
    }) : args[0] === '-version' ? `${executable.replace('.exe', '')} version fixture` : 'libx264',
  }));
});
afterEach(async () => { await rm(mock.root, { recursive: true, force: true }); });

describe('component failure diagnostics', () => {
  it('retains Python import failure streams in app.log without reporting a crash', async () => {
    mock.run.mockRejectedValueOnce(new ProcessExecutionError('python exited', {
      exitCode: 1, signal: null, stdout: 'import probe',
      stderr: 'ImportError: DLL load failed while importing onnxruntime_pybind11_state',
    }));
    const result = await inspectComponentPaths(paths);
    expect(result.analysis).toMatchObject({ available: false, detail: 'ANALYSIS_RUNTIME_SELF_TEST_FAILED' });
    expect(result.media.available).toBe(true);
    expect(mock.log).toHaveBeenCalledWith('app', 'ERROR', expect.stringContaining('Component check failed (analysis runtime)'));
    const text = mock.log.mock.calls[0]![2];
    expect(text).toContain(JSON.stringify(paths.python));
    expect(text).toContain('exit code=1');
    expect(text).toContain('stdout="import probe"');
    expect(text).toContain('DLL load failed');
  });

  it('identifies corrupt models before running Python', async () => {
    await writeFile(paths.blurballWeights, 'corrupt');
    const result = await inspectComponentPaths(paths);
    expect(result.analysis).toMatchObject({ available: false, detail: 'MODEL_HASH_MISMATCH' });
    expect(mock.log).toHaveBeenCalledWith('app', 'ERROR', expect.stringContaining('Component check failed (models)'));
    expect(mock.run.mock.calls.some(([, args]) => args[0] === '-c')).toBe(false);
  });

  it('keeps the original failure when logging is unavailable', async () => {
    mock.log.mockRejectedValue(new Error('EACCES'));
    mock.run.mockRejectedValueOnce(new Error('spawn ENOENT'));
    await expect(inspectComponentPaths(paths)).resolves.toMatchObject({ analysis: { available: false, detail: 'ANALYSIS_RUNTIME_SELF_TEST_FAILED' } });
  });

  it('accepts healthy CPU-only components', async () => {
    await expect(inspectComponentPaths(paths)).resolves.toMatchObject({
      analysis: { available: true, acceleration: 'cpu', detail: null }, media: { available: true, detail: null },
    });
    expect(mock.log).not.toHaveBeenCalled();
  });
});
