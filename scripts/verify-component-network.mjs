import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'resources', 'components.json'), 'utf8'));

async function probe(label, url, expectedSize) {
  if (!url.startsWith('https://')) throw new Error(`${label} does not use HTTPS.`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Range: 'bytes=0-1023',
          'User-Agent': 'TTcut-release-verifier/1.0.0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      const contentRange = response.headers.get('content-range');
      const body = new Uint8Array(await response.arrayBuffer());
      if (!response.url.startsWith('https://')) throw new Error(`redirected to a non-HTTPS URL: ${response.url}`);
      if (response.status !== 206 || contentRange !== `bytes 0-1023/${expectedSize}` || body.byteLength !== 1024) {
        throw new Error(`Range verification failed: status=${response.status}, range=${contentRange}, bytes=${body.byteLength}`);
      }
      console.log(`${label}: HTTP 206, ${contentRange}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`${label} HTTPS Range verification failed after 3 attempts: ${String(lastError)}`);
}

const probes = [
  ['tracknet-weight', catalog.tracknet_weight.url, catalog.tracknet_weight.size_bytes],
  ...catalog.analysis_runtime.assets.flatMap((asset) => asset.parts.map((part) => [
    `analysis-${asset.variant}-${part.asset}`,
    part.url,
    part.size_bytes,
  ])),
  ['media-runtime', catalog.ffmpeg.url, catalog.ffmpeg.size_bytes],
];

for (const [label, url, expectedSize] of probes) await probe(label, url, expectedSize);
console.log('Windows component download transport verification passed.');
