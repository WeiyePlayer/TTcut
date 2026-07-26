import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { appSettingsSchema, type AppSettings } from '../shared/contracts';

const defaults: AppSettings = {
  language: 'zh-CN',
  pre_roll_seconds: 2.5,
  post_roll_seconds: 2,
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as unknown;
    return appSettingsSchema.parse(raw);
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

