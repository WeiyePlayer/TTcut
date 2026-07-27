import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => path.join(process.cwd(), '.baseline', 'test-user-data'),
  },
}));

import { migrateComponents, runInstallerMigrationRequest } from '../src/main/installer-migration';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'ttcut-installer-migration-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('installer component migration', () => {
  it('copies and verifies files without deleting the source', async () => {
    const root = await temporaryRoot();
    const source = path.join(root, 'legacy-components');
    const target = path.join(root, 'new-components');
    await writeFile(path.join(root, 'placeholder'), '', 'utf8');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(source, '.manifests'), { recursive: true }));
    await writeFile(path.join(source, '.manifests', 'component.json'), '{"schema_version":1}', 'utf8');

    await expect(migrateComponents(source, target)).resolves.toMatchObject({
      status: 'ok',
      files: 1,
      bytes: 20,
    });
    await expect(readFile(path.join(source, '.manifests', 'component.json'), 'utf8')).resolves.toBe('{"schema_version":1}');
    await expect(readFile(path.join(target, '.manifests', 'component.json'), 'utf8')).resolves.toBe('{"schema_version":1}');
  });

  it('writes a machine-readable error report and preserves the source', async () => {
    const root = await temporaryRoot();
    const request = path.join(root, 'request.json');
    const report = path.join(root, 'report.json');
    await writeFile(request, JSON.stringify({
      schema_version: 1,
      source: path.join(root, 'missing'),
      target: path.join(root, 'target'),
      report,
    }), 'utf8');
    await expect(runInstallerMigrationRequest(request)).resolves.toBe(1);
    await expect(readFile(report, 'utf8')).resolves.toContain('INSTALLER_MIGRATION_SOURCE_MISSING');
  });

  it('accepts an NSIS UTF-16LE request without a byte-order mark', async () => {
    const root = await temporaryRoot();
    const source = path.join(root, 'legacy-components');
    const target = path.join(root, 'new-components');
    const request = path.join(root, 'request.json');
    const report = path.join(root, 'report.json');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'keep.txt'), 'keep', 'utf8');
    await writeFile(request, Buffer.from(JSON.stringify({
      schema_version: 1,
      source,
      target,
      report,
    }), 'utf16le'));

    await expect(runInstallerMigrationRequest(request)).resolves.toBe(0);
    await expect(readFile(report, 'utf8')).resolves.toContain('"status": "ok"');
    await expect(readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('rejects overlapping or non-empty targets without changing the source', async () => {
    const root = await temporaryRoot();
    const source = path.join(root, 'legacy-components');
    const nestedTarget = path.join(source, 'nested-target');
    const nonEmptyTarget = path.join(root, 'occupied-target');
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(nonEmptyTarget, { recursive: true }),
    ]));
    await writeFile(path.join(source, 'keep.txt'), 'keep', 'utf8');
    await writeFile(path.join(nonEmptyTarget, 'keep.txt'), 'occupied', 'utf8');

    await expect(migrateComponents(source, nestedTarget)).rejects.toThrow('INSTALLER_MIGRATION_PATH_OVERLAP');
    await expect(migrateComponents(source, nonEmptyTarget)).rejects.toThrow('INSTALLER_MIGRATION_TARGET_NOT_EMPTY');
    await expect(readFile(path.join(source, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });
});
