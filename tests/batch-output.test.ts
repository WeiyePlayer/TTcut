import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { uniqueOutput } from '../src/main/export';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('batch output naming', () => {
  it('uses the source directory and increments collisions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttcut-batch-output-'));
    temporaryDirectories.push(root);
    const source = path.join(root, '比赛.mp4');
    const first = path.join(root, '比赛_TTcut_精彩回合_5板.mp4');
    await writeFile(source, 'source');
    await writeFile(first, 'existing');
    await expect(uniqueOutput(source, '精彩回合_5板')).resolves.toBe(path.join(root, '比赛_TTcut_精彩回合_5板_2.mp4'));
  });
});
