import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'resources', 'components.json'), 'utf8'));
const runtimePart = catalog.analysis_runtime.assets.find((asset) => asset.variant === 'cpu')?.parts[0];
if (!runtimePart) throw new Error('The production catalog has no CPU runtime part.');

function probe(label, url, expectedSize) {
  const result = spawnSync('curl.exe', [
    '--fail', '--location', '--max-redirs', '5', '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '20', '--retry', '2', '--retry-all-errors', '--range', '0-1023',
    '--dump-header', '-', '--output', 'NUL', '--silent', '--show-error', '--url', url,
  ], { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  if (result.status !== 0) throw new Error(`${label} curl verification failed: ${result.stderr || result.stdout}`);
  const statuses = result.stdout.match(/^HTTP\/\S+\s+(\d+)/gim) ?? [];
  const ranges = result.stdout.match(/^content-range:\s*([^\r\n]+)/gim) ?? [];
  const status = statuses.at(-1)?.match(/\d+$/)?.[0];
  const contentRange = ranges.at(-1)?.replace(/^content-range:\s*/i, '').trim();
  if (status !== '206' || contentRange !== `bytes 0-1023/${expectedSize}`) {
    throw new Error(`${label} Range verification failed: status=${status}, range=${contentRange}`);
  }
  console.log(`${label}: HTTP 206, ${contentRange}`);
}

probe('analysis-runtime', runtimePart.url, runtimePart.size_bytes);
probe('media-runtime', catalog.ffmpeg.url, catalog.ffmpeg.size_bytes);
console.log('Windows component download transport verification passed.');
