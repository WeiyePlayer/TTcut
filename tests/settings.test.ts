import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}));

import { loadSettings, saveSettings } from '../src/main/settings';
import { appSettingsSchema } from '../src/shared/contracts';

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
      language: 'en', calibration_method: 'automatic',
      pre_roll_seconds: 5, post_roll_seconds: 0.5,
      analysis_mode: 'full',
      rally_recognition_method: 'continuous_visibility',
      normalize_variable_frame_rate: false,
    });
  });

  it('defaults missing timing values to medium before-rally and short after-rally padding', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'zh-CN', calibration_method: 'automatic',
    }), 'utf8');
    await expect(loadSettings()).resolves.toMatchObject({
      pre_roll_seconds: 2.5,
      post_roll_seconds: 1,
      normalize_variable_frame_rate: false,
    });
  });

  it('saves settings without an export strategy atomically', async () => {
    const settings = {
      language: 'zh-CN' as const, calibration_method: 'automatic' as const,
      pre_roll_seconds: 2.5 as const, post_roll_seconds: 2 as const,
      analysis_mode: 'full' as const,
      rally_recognition_method: 'bounce_events' as const,
      normalize_variable_frame_rate: true,
    };
    await expect(saveSettings(settings)).resolves.toEqual(settings);
    expect(JSON.parse(await readFile(path.join(state.userData, 'settings.json'), 'utf8'))).toEqual(settings);
  });

  it('drops persisted model selection while preserving the remaining settings', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'zh-CN', calibration_method: 'automatic', ball_model_profile: 'blurball_v1',
      pre_roll_seconds: 2.5, post_roll_seconds: 2,
    }), 'utf8');
    await expect(loadSettings()).resolves.toEqual({
      language: 'zh-CN', calibration_method: 'automatic', pre_roll_seconds: 2.5, post_roll_seconds: 2,
      analysis_mode: 'full',
      rally_recognition_method: 'continuous_visibility',
      normalize_variable_frame_rate: false,
    });
    expect(JSON.parse(await readFile(path.join(state.userData, 'settings.json'), 'utf8'))).not.toHaveProperty('ball_model_profile');
  });

  it('persists only the selected analysis mode', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'zh-CN', calibration_method: 'automatic', pre_roll_seconds: 2.5, post_roll_seconds: 2,
      analysis_mode: 'two_stage', blurball_confidence_threshold: 0.4,
    }), 'utf8');
    await expect(loadSettings()).resolves.toMatchObject({ analysis_mode: 'two_stage' });
    const settings = await loadSettings();
    await saveSettings(settings);
    const persisted = JSON.parse(await readFile(path.join(state.userData, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted.analysis_mode).toBe('two_stage');
    expect(persisted.normalize_variable_frame_rate).toBe(false);
    expect(persisted).not.toHaveProperty('blurball_confidence_threshold');
  });

  it('defaults missing or invalid rally recognition methods to continuous motion', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      language: 'zh-CN', calibration_method: 'automatic', pre_roll_seconds: 2.5, post_roll_seconds: 1,
      analysis_mode: 'two_stage', rally_recognition_method: 'unknown',
    }), 'utf8');
    await expect(loadSettings()).resolves.toMatchObject({
      rally_recognition_method: 'continuous_visibility', analysis_mode: 'two_stage',
    });
  });

  it('uses continuous motion on first launch and when parsing settings without a method', async () => {
    const settings = await loadSettings();
    expect(settings.rally_recognition_method).toBe('continuous_visibility');
    const { rally_recognition_method: _method, ...withoutMethod } = settings;
    expect(appSettingsSchema.parse(withoutMethod).rally_recognition_method).toBe('continuous_visibility');
  });

  it('preserves an existing bounce-events selection', async () => {
    await writeFile(path.join(state.userData, 'settings.json'), JSON.stringify({
      rally_recognition_method: 'bounce_events',
    }), 'utf8');
    expect((await loadSettings()).rally_recognition_method).toBe('bounce_events');
  });
});
