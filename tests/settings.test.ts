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

  it('defaults old settings to automatic calibration and drops the legacy export strategy', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'en', export_strategy: 'compatible', pre_roll_seconds: 5, post_roll_seconds: 0.5,
    }), 'utf8');
    await expect(loadSettings()).resolves.toEqual({
      language: 'en', calibration_method: 'automatic', ball_model_profile: 'tracknet_v1',
      pre_roll_seconds: 5, post_roll_seconds: 0.5,
    });
  });

  it('saves settings without an export strategy atomically', async () => {
    const settings = {
      language: 'zh-CN' as const, calibration_method: 'automatic' as const,
      ball_model_profile: 'uplifting_dual_v1' as const,
      pre_roll_seconds: 2.5 as const, post_roll_seconds: 2 as const,
    };
    await expect(saveSettings(settings)).resolves.toEqual(settings);
    expect(JSON.parse(await readFile(path.join(state.userData, 'settings.json'), 'utf8'))).toEqual(settings);
  });

  it('preserves a persisted BlurBall profile', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'zh-CN', calibration_method: 'automatic', ball_model_profile: 'blurball_v1',
      pre_roll_seconds: 2.5, post_roll_seconds: 2,
    }), 'utf8');
    await expect(loadSettings()).resolves.toMatchObject({ ball_model_profile: 'blurball_v1' });
  });
});
