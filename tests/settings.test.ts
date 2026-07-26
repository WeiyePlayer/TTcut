import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}));

import { loadSettings, saveSettings } from '../src/main/settings';

describe('settings migration', () => {
  beforeEach(async () => {
    state.userData = await mkdtemp(path.join(tmpdir(), 'ttcut-settings-'));
  });

  afterEach(async () => {
    await rm(state.userData, { recursive: true, force: true });
  });

  it('defaults old settings to automatic calibration and compatible export while preserving language and timing', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'en', pre_roll_seconds: 5, post_roll_seconds: 0.5,
    }), 'utf8');
    await expect(loadSettings()).resolves.toEqual({
      language: 'en', calibration_method: 'automatic', export_strategy: 'compatible',
      pre_roll_seconds: 5, post_roll_seconds: 0.5,
    });
  });

  it('saves the selected calibration and export strategy atomically', async () => {
    const settings = {
      language: 'zh-CN' as const, calibration_method: 'automatic' as const,
      export_strategy: 'fast_segmented' as const,
      pre_roll_seconds: 2.5 as const, post_roll_seconds: 2 as const,
    };
    await expect(saveSettings(settings)).resolves.toEqual(settings);
    expect(JSON.parse(await readFile(path.join(state.userData, 'settings.json'), 'utf8'))).toEqual(settings);
  });
});
