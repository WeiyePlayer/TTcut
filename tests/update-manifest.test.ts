import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SIGNER_THUMBPRINT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('signed update release manifest', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('writes canonical metadata for the exact installer selected for publication', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-manifest-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'TTcut-1.1.2-x64-Setup.exe');
    const manifestPath = path.join(directory, 'update-manifest.json');
    await writeFile(installerPath, 'signed installer fixture');

    await execFileAsync(process.execPath, [
      path.resolve('scripts/generate-update-manifest.mjs'),
      '--installer', installerPath,
      '--output', manifestPath,
      '--version', '1.1.2',
      '--channel', 'latest',
      '--signer-subject', 'CN=weiye',
      '--signer-thumbprint', SIGNER_THUMBPRINT,
    ], { cwd: path.resolve('.') });

    const manifestSource = await readFile(manifestPath, 'utf8');
    expect(manifestSource.endsWith('\n')).toBe(true);
    expect(JSON.parse(manifestSource)).toEqual({
      schema_version: 1,
      app_id: 'com.weiye.ttcut',
      version: '1.1.2',
      channel: 'latest',
      artifact: {
        file_name: 'TTcut-1.1.2-x64-Setup.exe',
        size: 24,
        sha512: 'q/EXy5sFcd2r42DxA4pvLYFFVSgLJplFCX1uEI71oaAnJkafVWfZrkTDipvXc4nRAwmci20JOd/c9r2QcKJ0GQ==',
        authenticode: {
          subject: 'CN=weiye',
          thumbprint: SIGNER_THUMBPRINT,
        },
      },
    });
  });
});
