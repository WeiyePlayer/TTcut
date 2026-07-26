import { createHash } from 'node:crypto';
import { cp, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [variant, baseArgument] = process.argv.slice(2);
if (!['cpu', 'cu126', 'cu132'].includes(variant) || !baseArgument) {
  throw new Error('Usage: node scripts/build-analysis-runtime.mjs <cpu|cu126|cu132> <python-base-3.12.13-directory>');
}

const runtimeId = '3.12.13-2.12.1';
const archiveRoot = `ttcut-analysis-${runtimeId}-${variant}`;
const buildRoot = path.join(root, '.baseline', 'runtime-build');
const target = path.join(buildRoot, archiveRoot);
const wheelhouse = path.join(buildRoot, 'wheels');
const base = await realpath(path.resolve(baseArgument));
const baseInfo = await stat(base);
if (!baseInfo.isDirectory() || path.basename(base) !== 'python-base-3.12.13') {
  throw new Error('The Python base must be the audited python-base-3.12.13 directory.');
}
if (target === root || target === path.parse(target).root || !target.startsWith(`${buildRoot}${path.sep}`)) {
  throw new Error('Refusing to replace a runtime outside the task-specific build directory.');
}

const lock = JSON.parse(await readFile(path.join(root, 'worker', 'runtime-wheel-lock.json'), 'utf8'));
const wheels = lock.wheels.filter((wheel) => wheel.variants.includes(variant));
if (wheels.length !== 12 || !wheels.some((wheel) => wheel.name === 'torch' && wheel.version === `2.12.1+${variant}`)) {
  throw new Error(`The immutable wheel lock is incomplete for ${variant}.`);
}

async function sha256(file) {
  const handle = await open(file, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function validateWheel(file, wheel) {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile() && info.size === wheel.size_bytes && await sha256(file) === wheel.sha256);
}

async function downloadWheel(wheel) {
  const destination = path.join(wheelhouse, wheel.filename);
  if (await validateWheel(destination, wheel)) {
    console.log(`verified cache: ${wheel.filename}`);
    return destination;
  }

  const partial = `${destination}.part`;
  let offset = (await stat(partial).catch(() => null))?.size ?? 0;
  if (offset > wheel.size_bytes) {
    await rm(partial, { force: true });
    offset = 0;
  }
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  const response = await fetch(wheel.url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} while downloading ${wheel.filename}`);
  if (offset > 0 && response.status !== 206) {
    await rm(partial, { force: true });
    return downloadWheel(wheel);
  }

  const file = await open(partial, offset > 0 ? 'a' : 'w');
  const reader = response.body.getReader();
  let completed = offset;
  let nextReport = completed + 64 * 1024 * 1024;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      completed += value.byteLength;
      if (completed >= nextReport || completed === wheel.size_bytes) {
        console.log(`download ${wheel.filename}: ${completed}/${wheel.size_bytes}`);
        nextReport = completed + 64 * 1024 * 1024;
      }
    }
  } finally {
    await file.close();
  }
  if (completed !== wheel.size_bytes) throw new Error(`Size mismatch for ${wheel.filename}: ${completed}/${wheel.size_bytes}`);
  if (await sha256(partial) !== wheel.sha256) throw new Error(`SHA-256 mismatch for ${wheel.filename}`);
  await rm(destination, { force: true });
  await rename(partial, destination);
  return destination;
}

await mkdir(wheelhouse, { recursive: true });
const wheelFiles = [];
for (const wheel of wheels) wheelFiles.push(await downloadWheel(wheel));

await rm(target, { recursive: true, force: true });
console.log(`copy Python base: ${base} -> ${target}`);
await cp(base, target, { recursive: true, force: false, errorOnExist: true });

const python = path.join(target, 'python.exe');
const install = spawnSync(python, ['-m', 'pip', 'install', '--no-index', '--no-deps', ...wheelFiles], {
  cwd: target,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30 * 60_000,
  maxBuffer: 50 * 1024 * 1024,
});
process.stdout.write(install.stdout ?? '');
process.stderr.write(install.stderr ?? '');
if (install.status !== 0) throw new Error(`Locked wheel installation failed with exit code ${install.status}.`);

const pipCheck = spawnSync(python, ['-m', 'pip', 'check'], { cwd: target, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
process.stdout.write(pipCheck.stdout ?? '');
process.stderr.write(pipCheck.stderr ?? '');
if (pipCheck.status !== 0) throw new Error('pip check rejected the prepared runtime.');

const selfTestCode = `import cv2,json,numpy,ssl,sys,torch
value={"python":sys.version.split()[0],"torch":torch.__version__,"cuda":torch.version.cuda,"opencv":cv2.__version__,"numpy":numpy.__version__,"available":torch.cuda.is_available(),"compiled_arch_list":getattr(torch._C,"_cuda_getArchFlags",lambda:" ")().split(),"openssl":ssl.OPENSSL_VERSION,"cuda_smoke":False}
if torch.cuda.is_available():
 value["device_name"]=torch.cuda.get_device_name(0);value["device_capability"]=list(torch.cuda.get_device_capability(0));value["cuda_arch_list"]=torch.cuda.get_arch_list()
 try:
  x=torch.ones((1,3,4,4),device="cuda");w=torch.ones((1,3,3,3),device="cuda");torch.nn.functional.conv2d(x,w);torch.cuda.synchronize();value["cuda_smoke"]=True
 except Exception as error:value["cuda_smoke_error"]=str(error)
print(json.dumps(value))`;
const selfTest = spawnSync(python, ['-c', selfTestCode], {
  cwd: target,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
});
if (selfTest.status !== 0) throw new Error(`Runtime self-test failed: ${selfTest.stderr || selfTest.stdout}`);
const versions = JSON.parse(selfTest.stdout.trim());
if (versions.python !== '3.12.13' || versions.torch !== `2.12.1+${variant}` || versions.opencv !== '4.13.0' || versions.numpy !== '2.5.1') {
  throw new Error(`Runtime versions differ from the immutable lock: ${selfTest.stdout.trim()}`);
}
if (variant === 'cpu' && (versions.cuda !== null || versions.available !== false)) throw new Error('CPU runtime unexpectedly exposes CUDA.');
if (variant !== 'cpu' && versions.cuda !== (variant === 'cu132' ? '13.2' : '12.6')) throw new Error(`${variant} runtime reports the wrong CUDA version.`);
if (variant !== 'cpu' && versions.available !== true && process.env.TTCUT_ALLOW_UNAVAILABLE_CUDA_SELF_TEST !== '1') throw new Error(`${variant} runtime cannot complete its CUDA self-test on this release machine.`);
if (variant !== 'cpu' && versions.available === true && versions.cuda_smoke !== true) throw new Error(`${variant} runtime CUDA smoke test failed: ${versions.cuda_smoke_error ?? 'unknown error'}`);
if (variant === 'cu132' && !versions.compiled_arch_list?.includes('sm_120')) throw new Error('cu132 runtime does not contain sm_120 kernels.');

const provenance = {
  schema_version: 1,
  runtime_id: runtimeId,
  variant,
  python_source: {
    version: '3.12.13',
    url: 'https://www.python.org/ftp/python/3.12.13/Python-3.12.13.tar.xz',
    sha256: 'c08bc65a81971c1dd5783182826503369466c7e67374d1646519adf05207b684',
    compiler: 'Microsoft Visual Studio 2022 Community 17.14 / MSVC 14.44 (v143)',
  },
  wheels: wheels.map(({ name, version, filename, size_bytes, sha256, url }) => ({ name, version, filename, size_bytes, sha256, url })),
  self_test: versions,
};
await writeFile(path.join(target, 'TTcut-runtime-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ target, self_test: versions }, null, 2));
