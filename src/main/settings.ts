import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { appSettingsSchema, type AppSettings } from '../shared/contracts';

const defaults: AppSettings = {
  language: 'zh-CN',
  calibration_method: 'automatic',
  pre_roll_seconds: 2.5,
  post_roll_seconds: 1,
  analysis_mode: 'full',
  rally_recognition_method: 'bounce_events',
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const target = settingsPath();
  const temp = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>;
    const settings = appSettingsSchema.parse({
      language: raw.language === 'en' || raw.language === 'zh-CN' ? raw.language : defaults.language,
      calibration_method: raw.calibration_method === 'automatic' || raw.calibration_method === 'manual'
        ? raw.calibration_method
        : defaults.calibration_method,
      pre_roll_seconds: [1.5, 2.5, 5].includes(Number(raw.pre_roll_seconds))
        ? raw.pre_roll_seconds
        : defaults.pre_roll_seconds,
      post_roll_seconds: [0.5, 1, 2, 4].includes(Number(raw.post_roll_seconds))
        ? raw.post_roll_seconds
        : defaults.post_roll_seconds,
      analysis_mode: raw.analysis_mode === 'two_stage' || raw.analysis_mode === 'full'
        ? raw.analysis_mode
        : defaults.analysis_mode,
      rally_recognition_method: raw.rally_recognition_method === 'continuous_visibility'
        || raw.rally_recognition_method === 'bounce_events'
        ? raw.rally_recognition_method
        : defaults.rally_recognition_method,
    });
    if (Object.hasOwn(raw, 'ball_model_profile')) await writeSettings(settings).catch(() => undefined);
    return settings;
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(value: unknown): Promise<AppSettings> {
  const settings = appSettingsSchema.parse(value);
  await writeSettings(settings);
  return settings;
}

