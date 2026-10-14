import path from 'node:path';

type PythonProgram = { code: string } | { module: string; worker: string };

/** Production imports must come from the selected runtime, never the user's Python installation. */
export function pythonRuntimeLaunch(
  python: string,
  program: PythonProgram,
  environment: NodeJS.ProcessEnv,
  variant: 'bundled' | 'external' | null = 'bundled',
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (variant === 'external') {
    return {
      args: 'code' in program ? ['-c', program.code] : ['-m', program.module],
      env: {
        ...environment,
        ...('worker' in program ? { PYTHONPATH: program.worker } : {}),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    };
  }

  const root = path.dirname(path.resolve(python));
  const bootstrap = [
    'import os,sys',
    `_ttcut_root=${JSON.stringify(root)}`,
    // -S also prevents .pth and sitecustomize hooks inside site-packages from adding external paths.
    'sys.path[:]=[os.path.join(_ttcut_root,"python%d%d.zip" % sys.version_info[:2]),_ttcut_root,os.path.join(_ttcut_root,"DLLs"),os.path.join(_ttcut_root,"Lib"),os.path.join(_ttcut_root,"Lib","site-packages")]',
    ...('code' in program ? [program.code] : [
      `sys.path.append(${JSON.stringify(path.resolve(program.worker))})`,
      'import runpy',
      `runpy.run_module(${JSON.stringify(program.module)},run_name="__main__",alter_sys=True)`,
    ]),
  ].join('\n');

  return {
    args: ['-I', '-S', '-X', 'utf8', '-c', bootstrap],
    // Windows environment variable names are case insensitive. Do not modify the parent environment.
    env: Object.fromEntries(Object.entries(environment).filter(([name]) => !/^PYTHON/i.test(name))),
  };
}
