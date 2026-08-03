import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { appSettingsSchema, type AppSettings } from '../shared/contracts';

const defaults: AppSettings = {
  language: 'zh-CN',
  calibration_method: 'automatic',
  ball_model_profile: 'tracknet_v1',
  pre_roll_seconds: 2.5,
  post_roll_seconds: 2,
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>;
    return appSettingsSchema.parse({
      language: raw.language === 'en' || raw.language === 'zh-CN' ? raw.language : defaults.language,
      calibration_method: raw.calibration_method === 'automatic' || raw.calibration_method === 'manual'
        ? raw.calibration_method
        : defaults.calibration_method,
      ball_model_profile: raw.ball_model_profile === 'uplifting_dual_v1'
        ? raw.ball_model_profile
        : defaults.ball_model_profile,
      pre_roll_seconds: [1.5, 2.5, 5].includes(Number(raw.pre_roll_seconds))
        ? raw.pre_roll_seconds
        : defaults.pre_roll_seconds,
      post_roll_seconds: [0.5, 1, 2, 4].includes(Number(raw.post_roll_seconds))
        ? raw.post_roll_seconds
        : defaults.post_roll_seconds,
    });
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(value: unknown): Promise<AppSettings> {
  const settings = appSettingsSchema.parse(value);
  const target = settingsPath();
  const temp = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temp, target);
  return settings;
}

