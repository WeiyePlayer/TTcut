import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const required = process.env.TTCUT_PUBLIC_RC === '1';
const expectedPublisher = process.env.TTCUT_PUBLISHER_NAME?.trim() || 'weiye';
const signTool = path.join(root, 'node_modules', '@electron', 'windows-sign', 'vendor', 'signtool.exe');
const files = [
  path.join(root, 'out', 'TTcut-win32-x64', 'TTcut.exe'),
  path.join(root, 'out', 'make', 'squirrel.windows', 'x64', `TTcut-${packageVersion}-x64-Setup.exe`),
];

if (!required) {
  console.log('Signature verification is diagnostic only. Set TTCUT_PUBLIC_RC=1 to enforce the public RC gate.');
}
if (!existsSync(signTool)) throw new Error(`Bundled SignTool is missing: ${signTool}`);

let checked = 0;
for (const file of files) {
  if (!existsSync(file)) {
    if (required) throw new Error(`Required signed artifact is missing: ${file}`);
    console.log(`Skipped missing artifact: ${file}`);
    continue;
  }
  const verification = spawnSync(signTool, ['verify', '/pa', '/all', '/v', '/tw', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (verification.status !== 0) {
    const message = `${verification.stdout ?? ''}\n${verification.stderr ?? ''}`.trim();
    if (required) throw new Error(`Authenticode verification failed for ${file}:\n${message}`);
    console.log(`Unsigned internal artifact: ${file}`);
    continue;
  }
  const powershell = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$signature=Get-AuthenticodeSignature -LiteralPath $args[0]; [pscustomobject]@{Status=[string]$signature.Status;Subject=[string]$signature.SignerCertificate.Subject;Thumbprint=[string]$signature.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress',
    file,
  ], { encoding: 'utf8', windowsHide: true });
  if (powershell.status !== 0) throw new Error(`Could not inspect signer metadata for ${file}.`);
  const signature = JSON.parse(powershell.stdout.trim());
  if (signature.Status !== 'Valid') throw new Error(`Signature status is ${signature.Status} for ${file}.`);
  if (expectedPublisher && !String(signature.Subject).toLocaleLowerCase().includes(expectedPublisher.toLocaleLowerCase())) {
    throw new Error(`Signer subject does not contain the expected publisher name for ${file}.`);
  }
  checked += 1;
  console.log(`Verified Authenticode: ${file} (${signature.Subject}, ${signature.Thumbprint})`);
}

if (required && checked !== files.length) throw new Error(`Only ${checked}/${files.length} required artifacts passed Authenticode verification.`);
