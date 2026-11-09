import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('names outputs after the source inside an explicit output directory and increments collisions there', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttcut-batch-output-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'readonly', '杜比视界.mp4');
    const fallback = path.join(root, 'Movies', 'TTcut');
    await mkdir(fallback, { recursive: true });
    await writeFile(path.join(fallback, '杜比视界_TTcut_自定义.mp4'), 'existing');
    await expect(uniqueOutput(source, '自定义', fallback)).resolves.toBe(path.join(fallback, '杜比视界_TTcut_自定义_2.mp4'));
  });

  it('exports a MOV source to an MP4 path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttcut-batch-output-'));
    temporaryDirectories.push(root);
    const source = path.join(root, '竖屏比赛.MOV');
    await writeFile(source, 'source');
    await expect(uniqueOutput(source, '所有回合')).resolves.toBe(path.join(root, '竖屏比赛_TTcut_所有回合.mp4'));
  });
});
