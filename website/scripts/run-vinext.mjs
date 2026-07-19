import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];

if (!['dev', 'build', 'start'].includes(command)) {
  throw new Error(`Unsupported vinext command: ${command ?? '<missing>'}`);
}

const child = spawn(process.execPath, [
  path.join(root, 'node_modules', 'vinext', 'dist', 'cli.js'),
  command,
], {
  cwd: root,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: path.join(root, '.wrangler', 'wrangler.log'),
  },
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`vinext exited with signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
