import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const required = process.env.TTCUT_PUBLIC_RC === '1' || process.env.TTCUT_OFFICIAL_RELEASE === '1';
const expectedPublisher = process.env.TTCUT_PUBLISHER_NAME?.trim() || 'weiye';
const expectedThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replace(/\s+/g, '').toUpperCase() || null;
const signTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim()
  || path.join(root, 'node_modules', '@electron', 'windows-sign', 'vendor', 'signtool.exe');
const packagedApp = path.join(root, 'out', 'TTcut-win32-x64', 'TTcut.exe');
const releaseDirectory = path.join(root, 'out', 'make', 'squirrel.windows', 'x64');
const installer = path.join(releaseDirectory, `TTcut-${packageVersion}-x64-Setup.exe`);
const nupkg = path.join(releaseDirectory, `TTcut-${packageVersion}-full.nupkg`);
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'ttcut-signature-verification-'));
const packagedNupkgApp = path.join(temporaryDirectory, 'TTcut.exe');

if (!required) console.log('Signature verification is diagnostic only. Set TTCUT_OFFICIAL_RELEASE=1 to enforce it.');
if (!existsSync(signTool)) throw new Error(`Windows SDK SignTool is missing: ${signTool}`);
if (required && !expectedThumbprint) throw new Error('Official signature verification requires WINDOWS_CERTIFICATE_THUMBPRINT.');

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function extractPackagedExecutable() {
  if (!existsSync(nupkg)) {
    if (required) throw new Error(`Required Squirrel package is missing: ${nupkg}`);
    return false;
  }
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    '$archive=[System.IO.Compression.ZipFile]::OpenRead($env:TTCUT_VERIFY_NUPKG);',
    "try {$entry=$archive.GetEntry('lib/net45/TTcut.exe'); if (-not $entry) { throw 'TTcut.exe is missing from the Squirrel package.' }; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$env:TTCUT_VERIFY_EXE,$true)} finally {$archive.Dispose()}",
  ].join(' ');
  const extraction = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TTCUT_VERIFY_NUPKG: nupkg, TTCUT_VERIFY_EXE: packagedNupkgApp },
  });
  if (extraction.status !== 0) {
    throw new Error(`Could not inspect the Squirrel package: ${extraction.stderr || extraction.stdout}`);
  }
  if (!existsSync(packagedNupkgApp)) throw new Error('PowerShell did not extract TTcut.exe from the Squirrel package.');
  if (!existsSync(packagedApp) || sha256(packagedNupkgApp) !== sha256(packagedApp)) {
    throw new Error('The signed application executable does not match the executable embedded in the Squirrel package.');
  }
  return true;
}

function inspectSignature(file) {
  const verification = spawnSync(signTool, ['verify', '/pa', '/all', '/v', '/tw', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (verification.status !== 0) {
    const message = `${verification.stdout ?? ''}\n${verification.stderr ?? ''}`.trim();
    if (required) throw new Error(`Authenticode verification failed for ${file}:\n${message}`);
    console.log(`Signature did not pass local trust verification: ${file}`);
    return false;
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
  return true;
}

try {
  const files = [packagedApp, installer];
  if (extractPackagedExecutable()) files.splice(1, 0, packagedNupkgApp);
  let checked = 0;
  for (const file of files) {
    if (!existsSync(file)) {
      if (required) throw new Error(`Required signed artifact is missing: ${file}`);
      console.log(`Skipped missing artifact: ${file}`);
      continue;
    }
    if (inspectSignature(file)) checked += 1;
  }
  if (required && checked !== files.length) throw new Error(`Only ${checked}/${files.length} required artifacts passed Authenticode verification.`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
