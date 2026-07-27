import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = process.env.TTCUT_PUBLIC_RC === '1' || process.env.TTCUT_OFFICIAL_RELEASE === '1';
const expectedPublisher = process.env.TTCUT_PUBLISHER_NAME?.trim() || 'weiye';
const expectedThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replace(/\s+/g, '').toUpperCase() || null;
const signTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim()
  || path.join(root, 'node_modules', '@electron', 'windows-sign', 'vendor', 'signtool.exe');
const packagedApp = path.join(root, 'out', 'TTcut-win32-x64', 'TTcut.exe');
const releaseDirectory = path.join(root, 'out', 'make', 'nsis', 'x64');
const setupName = existsSync(releaseDirectory)
  ? readdirSync(releaseDirectory).find((name) => /-Setup\.exe$/i.test(name))
  : null;
const setup = setupName ? path.join(releaseDirectory, setupName) : null;
const capturedUninstaller = path.join(releaseDirectory, '.verification', 'Uninstall TTcut.exe');

if (!required) console.log('Signature verification is diagnostic only. Set TTCUT_OFFICIAL_RELEASE=1 to enforce it.');
if (required && !existsSync(signTool)) throw new Error(`Windows SDK SignTool is missing: ${signTool}`);
if (required && !expectedThumbprint) throw new Error('Official signature verification requires WINDOWS_CERTIFICATE_THUMBPRINT.');

function inspectSignature(file) {
  if (required) {
    const verification = spawnSync(signTool, ['verify', '/pa', '/all', '/v', '/tw', file], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (verification.status !== 0) {
      const message = `${verification.stdout ?? ''}\n${verification.stderr ?? ''}`.trim();
      throw new Error(`Authenticode verification failed for ${file}:\n${message}`);
    }
  }

  const powershell = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$signature=Get-AuthenticodeSignature -LiteralPath $env:TTCUT_VERIFY_SIGNATURE_FILE; [pscustomobject]@{Status=[string]$signature.Status;Subject=[string]$signature.SignerCertificate.Subject;Thumbprint=[string]$signature.SignerCertificate.Thumbprint;TimestampSubject=[string]$signature.TimeStamperCertificate.Subject}|ConvertTo-Json -Compress',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TTCUT_VERIFY_SIGNATURE_FILE: file },
  });
  if (powershell.status !== 0) {
    throw new Error(`Could not inspect signer metadata for ${file}: ${powershell.stderr || powershell.stdout}`);
  }
  const signature = JSON.parse(powershell.stdout.trim());
  if (!required) {
    console.log(`Authenticode status: ${file} (${signature.Status})`);
    return;
  }

  const thumbprint = String(signature.Thumbprint).replace(/\s+/g, '').toUpperCase();
  if (signature.Status !== 'Valid') throw new Error(`Signature status is ${signature.Status} for ${file}.`);
  if (!String(signature.Subject).toLocaleLowerCase().includes(expectedPublisher.toLocaleLowerCase())) {
    throw new Error(`Signer subject does not contain ${expectedPublisher} for ${file}.`);
  }
  if (expectedThumbprint && thumbprint !== expectedThumbprint) {
    throw new Error(`Signer thumbprint mismatch for ${file}: ${thumbprint}.`);
  }
  if (!String(signature.TimestampSubject).trim()) throw new Error(`RFC 3161 timestamp is missing for ${file}.`);
  console.log(`Verified Authenticode: ${file} (${signature.Subject}, ${thumbprint}, timestamp=${signature.TimestampSubject})`);
}

const files = [packagedApp, capturedUninstaller, setup].filter(Boolean);
for (const file of files) {
  if (!existsSync(file)) {
    if (required) throw new Error(`Required signed artifact is missing: ${file}`);
    console.log(`Skipped missing artifact: ${file}`);
    continue;
  }
  inspectSignature(file);
}

if (required && files.length !== 3) {
  throw new Error('Packaged TTcut.exe, NSIS uninstaller, and outer Setup are required for official signature verification.');
}
