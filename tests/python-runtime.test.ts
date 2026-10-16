// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pythonRuntimeLaunch } from '../src/main/python-runtime';

describe('Python launch environment', () => {
  it('isolates bundled imports without changing the parent environment or media settings', () => {
    const environment = {
      PYTHONPATH: 'external', PythonHome: 'external-home', PYTHONUSERBASE: 'external-user', PYTHONINSPECT: '1',
      PATH: 'system-tools', TTCUT_TABLE_ANALYZE_WEIGHTS: 'table.onnx', OPENCV_FFMPEG_READ_ATTEMPTS: '65536',
    };
    const launch = pythonRuntimeLaunch('python.exe', { code: 'print(1)' }, environment);
    expect(launch.env).toEqual({
      PATH: 'system-tools', TTCUT_TABLE_ANALYZE_WEIGHTS: 'table.onnx', OPENCV_FFMPEG_READ_ATTEMPTS: '65536',
    });
    expect(environment.PythonHome).toBe('external-home');
  });

  it('keeps the explicitly selected external development runtime', () => {
    const launch = pythonRuntimeLaunch('dev-python', { module: 'ttcut_worker.worker', worker: 'dev-worker' }, {
      PYTHONHOME: 'dev-runtime', PYTHONUSERBASE: 'dev-packages',
    }, 'external');
    expect(launch).toEqual({
      args: ['-m', 'ttcut_worker.worker'],
      env: { PYTHONHOME: 'dev-runtime', PYTHONUSERBASE: 'dev-packages', PYTHONPATH: 'dev-worker', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
  });
});

// A shell-selected virtualenv disables user-site imports, so it cannot reproduce
// the shared-user-package regression. Use the same base Python as Windows staging.
const windowsPython = process.platform === 'win32' && !process.env.TTCUT_ISOLATION_TEST_PYTHON
  ? spawnSync('py', ['-3.12', '-I', '-S', '-X', 'utf8', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', timeout: 5_000 }).stdout?.trim()
  : null;
const interpreter = process.env.TTCUT_ISOLATION_TEST_PYTHON ?? (process.platform === 'win32' ? windowsPython || 'python' : 'python3');
const metadata = spawnSync(interpreter, ['-I', '-S', '-X', 'utf8', '-c',
  'import json,sys,sysconfig,os;print(json.dumps({"stdlib":sysconfig.get_path("stdlib"),"extensions":[p for p in sys.path if os.path.basename(p) in ("DLLs","lib-dynload")]}))',
], { encoding: 'utf8', timeout: 5_000 });

describe.skipIf(metadata.status !== 0)('real Python imports under external dependency pollution', () => {
  let root: string;
  let python: string;
  let packages: string;
  let external: string;
  let worker: string;
  let environment: NodeJS.ProcessEnv;
  const probe = 'import json,sys,numpy,cv2,onnxruntime;print(json.dumps({"versions":[numpy.__version__,cv2.__version__,onnxruntime.__version__],"files":[numpy.__file__,cv2.__file__,onnxruntime.__file__],"isolated":sys.flags.isolated,"no_site":sys.flags.no_site,"utf8":sys.flags.utf8_mode}))';

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ttcut-python-'));
    const runtime = path.join(root, 'bundle 乒乓', 'python');
    python = path.join(runtime, 'python.exe');
    packages = path.join(runtime, 'Lib', 'site-packages');
    external = path.join(root, 'external');
    worker = path.join(root, 'worker 乒乓');
    const info = JSON.parse(metadata.stdout) as { stdlib: string; extensions: string[] };
    await cp(info.stdlib, path.join(runtime, 'Lib'), {
      recursive: true,
      filter: (file) => !path.relative(info.stdlib, file).split(path.sep).some((part) =>
        ['site-packages', '__pycache__', 'test', 'tests', 'lib-dynload'].includes(part)) && !file.endsWith('.pyc'),
    });
    if (info.extensions[0]) await cp(info.extensions[0], path.join(runtime, 'DLLs'), { recursive: true });
    await mkdir(packages, { recursive: true });
    await mkdir(external, { recursive: true });
    for (const [name, version, oldVersion] of [['numpy', '2.5.1', '1.26.4'], ['cv2', '4.13.0', '4.10.0'], ['onnxruntime', '1.24.3', '1.24.3']]) {
      await writeFile(path.join(packages, `${name}.py`), `__version__=${JSON.stringify(version)}\n`);
      await writeFile(path.join(external, `${name}.py`), `__version__=${JSON.stringify(oldVersion)}\n`);
    }
    // These hooks would defeat -I alone by modifying the bundled site's search path.
    await writeFile(path.join(packages, 'pollution.pth'), `import sys;sys.path.insert(0,${JSON.stringify(external)})\n`);
    await writeFile(path.join(packages, 'sitecustomize.py'), 'raise RuntimeError("Untrusted site hook ran")\n');
    await mkdir(path.join(worker, 'ttcut_worker'), { recursive: true });
    await writeFile(path.join(worker, 'ttcut_worker', '__init__.py'), '');
    await writeFile(path.join(worker, 'ttcut_worker', 'shared.py'), 'SOURCE="bundled-worker"\n');
    for (const module of ['worker', 'calibration_worker']) {
      await writeFile(path.join(worker, 'ttcut_worker', `${module}.py`), [
        'import json,sys,numpy,cv2',
        'from .shared import SOURCE',
        'request=json.loads(sys.stdin.readline())',
        'print(json.dumps({"source":SOURCE,"request":request,"numpy":numpy.__version__,"opencv":cv2.__version__},ensure_ascii=False))',
      ].join('\n'));
    }
    const userBase = path.join(root, 'user');
    const userSite = spawnSync(interpreter, ['-s', '-c', 'import site;print(site.getusersitepackages())'], {
      encoding: 'utf8', env: { ...process.env, PYTHONUSERBASE: userBase }, timeout: 5_000,
    });
    expect(userSite.status, userSite.stderr).toBe(0);
    await cp(external, userSite.stdout.trim(), { recursive: true });
    environment = { ...process.env, PYTHONPATH: external, PYTHONUSERBASE: userBase };
  }, 30_000);

  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('reproduces the wrong versions through both PYTHONPATH and shared user packages', () => {
    const code = 'import numpy,cv2;print(numpy.__version__,cv2.__version__)';
    const byPath = spawnSync(interpreter, ['-c', code], { encoding: 'utf8', env: environment, timeout: 5_000 });
    expect(byPath.status, byPath.stderr).toBe(0);
    expect(byPath.stdout.trim()).toBe('1.26.4 4.10.0');
    const userOnly = { ...environment };
    delete userOnly.PYTHONPATH;
    const byUserSite = spawnSync(interpreter, ['-c', code], { encoding: 'utf8', env: userOnly, timeout: 5_000 });
    expect(byUserSite.status, byUserSite.stderr).toBe(0);
    expect(byUserSite.stdout.trim()).toBe('1.26.4 4.10.0');
  });

  it('loads the software dependencies despite conflicting user packages, paths and hooks', () => {
    const launch = pythonRuntimeLaunch(python, { code: probe }, { ...environment, PYTHONHOME: 'missing-python-home' });
    // The host interpreter exercises a fixture with the same layout as the Windows bundle.
    const result = spawnSync(interpreter, launch.args, { encoding: 'utf8', env: launch.env, cwd: external, timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      versions: ['2.5.1', '4.13.0', '1.24.3'],
      files: ['numpy', 'cv2', 'onnxruntime'].map((name) => path.join(packages, `${name}.py`)),
      isolated: 1, no_site: 1, utf8: 1,
    });
  });

  it.each(['worker', 'calibration_worker'])('starts the trusted %s with relative imports and UTF-8 request data', (module) => {
    const launch = pythonRuntimeLaunch(python, { module: `ttcut_worker.${module}`, worker }, environment);
    const result = spawnSync(interpreter, launch.args, {
      encoding: 'utf8', env: launch.env, cwd: external, input: JSON.stringify({ video: '中文球馆🏓.mp4' }) + '\n', timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      source: 'bundled-worker', request: { video: '中文球馆🏓.mp4' }, numpy: '2.5.1', opencv: '4.13.0',
    });
  });

  it('fails when a bundled dependency is missing instead of using a user-installed copy', async () => {
    const file = path.join(packages, 'numpy.py');
    await rename(file, `${file}.hidden`);
    try {
      const launch = pythonRuntimeLaunch(python, { code: probe }, environment);
      const result = spawnSync(interpreter, launch.args, { encoding: 'utf8', env: launch.env, timeout: 5_000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("No module named 'numpy'");
    } finally { await rename(`${file}.hidden`, file); }
  });
});
