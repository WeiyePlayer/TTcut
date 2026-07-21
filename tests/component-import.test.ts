import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentCatalog } from '../src/main/component-catalog';
import { validateImportFiles } from '../src/main/component-import';

const temporaryDirectories: string[] = [];

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'ttcut-component-import-'));
  temporaryDirectories.push(value);
  return value;
}

function testCatalog(): ComponentCatalog {
  const cpu = 'cpu-data';
  const cudaOne = 'cuda-one';
  const cudaTwo = 'cuda-two';
  const cudaThree = 'cuda-three';
  const media = 'media-data';
  return {
    schema_version: 1,
    tracknet_weight: {
      filename: 'TrackNet_best.pt', sha256: hash('weight-data'), source: 'test', redistribution: 'redistributable', downloadable: true,
      provider: 'test', release_tag: 'test', url: 'https://example.com/weight', size_bytes: 11, install_directory: 'models',
      rights_evidence: { path: 'rights/test.md', sha256: hash('rights'), rightsholder: 'test', grant: 'test' },
    },
    analysis_runtime: {
      runtime_id: '3.12.13-2.12.1', python_version: '3.12.13', torch_version: '2.12.1', license_url: 'https://example.com/license',
      assets: [
        {
          variant: 'cpu', provider: 'test', asset: 'cpu.zip', archive_root: 'cpu-root', install_directory: 'analysis-runtime/3.12.13-2.12.1/cpu',
          size_bytes: cpu.length, sha256: hash(cpu), parts: [{ asset: 'cpu.zip', url: 'https://example.com/cpu', size_bytes: cpu.length, sha256: hash(cpu) }],
        },
        {
          variant: 'cu126', provider: 'test', asset: 'cu126.zip', archive_root: 'cuda-root', install_directory: 'analysis-runtime/3.12.13-2.12.1/cu126',
          size_bytes: cudaOne.length + cudaTwo.length + cudaThree.length, sha256: hash(`${cudaOne}${cudaTwo}${cudaThree}`), parts: [
            { asset: 'cu126.zip.part001', url: 'https://example.com/cuda-1', size_bytes: cudaOne.length, sha256: hash(cudaOne) },
            { asset: 'cu126.zip.part002', url: 'https://example.com/cuda-2', size_bytes: cudaTwo.length, sha256: hash(cudaTwo) },
            { asset: 'cu126.zip.part003', url: 'https://example.com/cuda-3', size_bytes: cudaThree.length, sha256: hash(cudaThree) },
          ],
        },
      ],
    },
    ffmpeg: {
      provider: 'test', release_tag: 'test', version_line: 'test', variant: 'win64-lgpl-shared-8.1', asset: 'ffmpeg.zip', archive_root: 'ffmpeg-root',
      install_directory: 'ffmpeg-8.1', url: 'https://example.com/ffmpeg', license_url: 'https://example.com/ffmpeg-license', size_bytes: media.length,
      sha256: hash(media), required_build_flags: ['--enable-shared'], required_encoders: ['aac'],
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('manual component import validation', () => {
  it('recognizes the fixed model, CPU runtime, CUDA parts, and media archive', async () => {
    const root = await temporaryDirectory();
    const files = [
      ['TrackNet_best.pt', 'weight-data'], ['cpu.zip', 'cpu-data'], ['cu126.zip.part001', 'cuda-one'], ['cu126.zip.part002', 'cuda-two'],
      ['cu126.zip.part003', 'cuda-three'], ['ffmpeg.zip', 'media-data'],
    ] as const;
    const paths = await Promise.all(files.map(async ([name, content]) => {
      const file = path.join(root, name);
      await writeFile(file, content, 'utf8');
      return file;
    }));

    await expect(validateImportFiles(paths, testCatalog())).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'weight' }),
      expect.objectContaining({ kind: 'runtime-part', variant: 'cpu' }),
      expect.objectContaining({ kind: 'runtime-part', variant: 'cu126' }),
      expect.objectContaining({ kind: 'media' }),
    ]));
  });

  it('rejects unknown, wrong-size, and wrong-hash files', async () => {
    const root = await temporaryDirectory();
    const unknown = path.join(root, 'unknown.zip');
    await writeFile(unknown, 'unknown', 'utf8');
    await expect(validateImportFiles([unknown], testCatalog())).rejects.toThrow('COMPONENT_IMPORT_UNSUPPORTED_FILE');

    const wrongSize = path.join(root, 'cpu.zip');
    await writeFile(wrongSize, 'wrong', 'utf8');
    await expect(validateImportFiles([wrongSize], testCatalog())).rejects.toThrow('COMPONENT_IMPORT_FILE_SIZE_MISMATCH');

    const wrongHash = path.join(root, 'TrackNet_best.pt');
    await writeFile(wrongHash, 'weight-datX', 'utf8');
    await expect(validateImportFiles([wrongHash], testCatalog())).rejects.toThrow('COMPONENT_IMPORT_FILE_HASH_MISMATCH');
  });

  it('requires every CUDA runtime part when any CUDA part is selected', async () => {
    const root = await temporaryDirectory();
    const selected = await Promise.all(([ 
      ['cu126.zip.part001', 'cuda-one'], ['cu126.zip.part002', 'cuda-two'],
    ] as const).map(async ([name, content]) => {
      const file = path.join(root, name);
      await writeFile(file, content, 'utf8');
      return file;
    }));

    await expect(validateImportFiles(selected, testCatalog())).rejects.toThrow('COMPONENT_IMPORT_MISSING_PARTS:cu126.zip.part003');
  });
});
