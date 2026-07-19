import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

let logDirectory = '';

export function getLogDirectory(): string {
  if (!logDirectory) logDirectory = path.join(app.getPath('userData'), 'logs');
  return logDirectory;
}

export function getLogPath(taskId = 'app'): string {
  return path.join(getLogDirectory(), `${taskId}.log`);
}

export async function logLine(taskId: string, level: string, message: string): Promise<void> {
  await mkdir(getLogDirectory(), { recursive: true });
  const sanitized = message.replace(/[\r\n]+/g, ' ').slice(0, 20_000);
  await appendFile(getLogPath(taskId), `${new Date().toISOString()} | ${level} | ${sanitized}\n`, 'utf8');
}

