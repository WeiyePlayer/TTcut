const targets = [
  { name: 'numpy', version: '2.5.1', source: 'pypi', file: /^numpy-2\.5\.1-cp312-cp312-win_amd64\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'opencv-python', version: '4.13.0.92', source: 'pypi', file: /^opencv_python-4\.13\.0\.92-cp37-abi3-win_amd64\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'filelock', version: '3.30.3', source: 'pypi', file: /^filelock-3\.30\.3-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'fsspec', version: '2026.6.0', source: 'pypi', file: /^fsspec-2026\.6\.0-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'Jinja2', version: '3.1.6', source: 'pypi', file: /^jinja2-3\.1\.6-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'MarkupSafe', version: '3.0.3', source: 'pypi', file: /^markupsafe-3\.0\.3-cp312-cp312-win_amd64\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'mpmath', version: '1.3.0', source: 'pypi', file: /^mpmath-1\.3\.0-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'networkx', version: '3.6.1', source: 'pypi', file: /^networkx-3\.6\.1-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'setuptools', version: '81.0.0', source: 'pypi', file: /^setuptools-81\.0\.0-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'sympy', version: '1.14.0', source: 'pypi', file: /^sympy-1\.14\.0-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'typing-extensions', version: '4.16.0', source: 'pypi', file: /^typing_extensions-4\.16\.0-py3-none-any\.whl$/, variants: ['cpu', 'cu126'] },
  { name: 'torch', version: '2.12.1+cpu', source: 'https://download.pytorch.org/whl/cpu/torch/', file: /^torch-2\.12\.1\+cpu-cp312-cp312-win_amd64\.whl$/, variants: ['cpu'] },
  { name: 'torch', version: '2.12.1+cu126', source: 'https://download.pytorch.org/whl/cu126/torch/', file: /^torch-2\.12\.1\+cu126-cp312-cp312-win_amd64\.whl$/, variants: ['cu126'] },
];

async function fetchOk(url, options = {}) {
  const response = await fetch(url, { redirect: 'follow', ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response;
}

async function fromPyPi(target) {
  const response = await fetchOk(`https://pypi.org/pypi/${encodeURIComponent(target.name)}/${encodeURIComponent(target.version)}/json`);
  const data = await response.json();
  const file = data.urls.find((candidate) => target.file.test(candidate.filename));
  if (!file) throw new Error(`PyPI wheel not found for ${target.name} ${target.version}.`);
  return {
    name: target.name,
    version: target.version,
    variants: target.variants,
    filename: file.filename,
    url: file.url,
    size_bytes: file.size,
    sha256: file.digests.sha256,
  };
}

async function fromSimpleIndex(target) {
  const response = await fetchOk(target.source);
  const html = await response.text();
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1]);
  for (const href of hrefs) {
    const url = new URL(href, target.source);
    const filename = decodeURIComponent(pathnameName(url.pathname));
    if (!target.file.test(filename)) continue;
    const sha256 = new URLSearchParams(url.hash.slice(1)).get('sha256');
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Missing SHA-256 fragment for ${filename}.`);
    const cleanUrl = new URL(url);
    cleanUrl.hash = '';
    const head = await fetchOk(cleanUrl, { method: 'HEAD' });
    const size = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Missing Content-Length for ${filename}.`);
    return { name: target.name, version: target.version, variants: target.variants, filename, url: cleanUrl.toString(), size_bytes: size, sha256 };
  }
  throw new Error(`Wheel not found in ${target.source}: ${target.version}`);
}

function pathnameName(pathname) {
  const parts = pathname.split('/');
  return parts[parts.length - 1] ?? '';
}

const wheels = [];
for (const target of targets) wheels.push(target.source === 'pypi' ? await fromPyPi(target) : await fromSimpleIndex(target));
console.log(JSON.stringify({
  schema_version: 1,
  platform: 'win_amd64',
  python_tag: 'cp312',
  resolved_at: new Date().toISOString(),
  wheels,
}, null, 2));
