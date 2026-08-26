import { spawnSync } from 'node:child_process';
import { createHash, verify, X509Certificate } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = process.env.TTCUT_PUBLIC_RC === '1' || process.env.TTCUT_OFFICIAL_RELEASE === '1';
const expectedPublisher = process.env.TTCUT_PUBLISHER_NAME?.trim() || 'weiye';
const expectedThumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replace(/\s+/g, '').toUpperCase() || null;
const onlineModelInstaller = process.env.TTCUT_ONLINE_MODEL_INSTALLER === '1';
const signTool = process.env.WINDOWS_SIGNTOOL_PATH?.trim()
  || path.join(root, 'node_modules', '@electron', 'windows-sign', 'vendor', 'signtool.exe');
const packagedApp = path.join(root, 'out', 'TTcut-win32-x64', 'TTcut.exe');
const releaseDirectory = path.join(root, 'out', 'make', onlineModelInstaller ? 'nsis-online' : 'nsis', 'x64');
const setupName = existsSync(releaseDirectory)
  ? readdirSync(releaseDirectory).find((name) => onlineModelInstaller ? /-Online-Setup\.exe$/i.test(name) : /-Setup\.exe$/i.test(name))
  : null;
const setup = setupName ? path.join(releaseDirectory, setupName) : null;
const capturedUninstaller = path.join(releaseDirectory, '.verification', 'Uninstall TTcut.exe');
const updateManifest = path.join(releaseDirectory, 'update-manifest.json');
const updateManifestSignature = path.join(releaseDirectory, 'update-manifest.json.sig');

if (!required) console.log('Signature verification is diagnostic only. Set TTCUT_OFFICIAL_RELEASE=1 to enforce it.');
if (required && !existsSync(signTool)) throw new Error(`Windows SDK SignTool is missing: ${signTool}`);
if (required && !expectedThumbprint) throw new Error('Official signature verification requires WINDOWS_CERTIFICATE_THUMBPRINT.');

function inspectSignature(file) {
  const powershell = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '$env:PSModulePath=[Environment]::ExpandEnvironmentVariables("%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\Modules"); Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $signature=Get-AuthenticodeSignature -LiteralPath $env:TTCUT_VERIFY_SIGNATURE_FILE; if($null -eq $signature.SignerCertificate){throw "Artifact is not signed."}; $chain=New-Object System.Security.Cryptography.X509Certificates.X509Chain; $chain.ChainPolicy.RevocationMode=[System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck; [void]$chain.Build($signature.SignerCertificate); [pscustomobject]@{Status=[string]$signature.Status;SignatureType=[string]$signature.SignatureType;Subject=[string]$signature.SignerCertificate.Subject;Thumbprint=[string]$signature.SignerCertificate.Thumbprint;TimestampSubject=[string]$signature.TimeStamperCertificate.Subject;ChainStatus=@($chain.ChainStatus|ForEach-Object{[string]$_.Status});CertificateRawData=[Convert]::ToBase64String($signature.SignerCertificate.RawData)}|ConvertTo-Json -Compress',
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
    return signature;
  }

  const thumbprint = String(signature.Thumbprint).replace(/\s+/g, '').toUpperCase();
  const chainStatus = Array.isArray(signature.ChainStatus)
    ? signature.ChainStatus.map(String)
    : signature.ChainStatus == null ? [] : [String(signature.ChainStatus)];
  const acceptedStatus = (signature.Status === 'Valid' && chainStatus.length === 0)
    || (signature.Status === 'UnknownError' && chainStatus.length === 1 && chainStatus[0] === 'UntrustedRoot');
  if (!acceptedStatus || signature.SignatureType !== 'Authenticode') {
    throw new Error(`Signature status is ${signature.Status} (${chainStatus.join('|') || 'no-chain-errors'}) for ${file}.`);
  }
  if (!String(signature.Subject).toLocaleLowerCase().includes(expectedPublisher.toLocaleLowerCase())) {
    throw new Error(`Signer subject does not contain ${expectedPublisher} for ${file}.`);
  }
  if (expectedThumbprint && thumbprint !== expectedThumbprint) {
    throw new Error(`Signer thumbprint mismatch for ${file}: ${thumbprint}.`);
  }
  if (!String(signature.TimestampSubject).trim()) throw new Error(`RFC 3161 timestamp is missing for ${file}.`);
  console.log(`Verified Authenticode: ${file} (${signature.Status}, ${signature.Subject}, ${thumbprint}, timestamp=${signature.TimestampSubject})`);
  return signature;
}

const files = [packagedApp, capturedUninstaller, setup].filter(Boolean);
let setupSignature = null;
for (const file of files) {
  if (!existsSync(file)) {
    if (required) throw new Error(`Required signed artifact is missing: ${file}`);
    console.log(`Skipped missing artifact: ${file}`);
    continue;
  }
  const signature = inspectSignature(file);
  if (file === setup) setupSignature = signature;
}

if (required && files.length !== 3) {
  throw new Error('Packaged TTcut.exe, NSIS uninstaller, and outer Setup are required for official signature verification.');
}

async function sha512(file) {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest('base64');
}

if (required) {
  if (!setup || !setupSignature || !existsSync(updateManifest) || !existsSync(updateManifestSignature)) {
    throw new Error('The signed update manifest assets are required for an official release.');
  }
  const [manifestBytes, signatureSource, setupStat, setupSha512] = await Promise.all([
    readFile(updateManifest),
    readFile(updateManifestSignature, 'utf8'),
    stat(setup),
    sha512(setup),
  ]);
  if (manifestBytes.length === 0 || manifestBytes.length > 64 * 1024) {
    throw new Error('The signed update manifest has an invalid size.');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const envelope = JSON.parse(signatureSource);
  const certificate = new X509Certificate(Buffer.from(setupSignature.CertificateRawData, 'base64'));
  const certificateThumbprint = certificate.fingerprint.replaceAll(':', '').toUpperCase();
  if (
    envelope.schema_version !== 1
    || envelope.algorithm !== 'RSA-SHA256'
    || envelope.key_id !== expectedThumbprint
    || certificateThumbprint !== expectedThumbprint
  ) {
    throw new Error('The update manifest signature envelope names an unexpected signer.');
  }
  if (!verify(
    'RSA-SHA256',
    manifestBytes,
    certificate.publicKey,
    Buffer.from(envelope.signature, 'base64'),
  )) {
    throw new Error('The detached update manifest signature is invalid.');
  }
  if (
    manifest.schema_version !== 1
    || manifest.app_id !== 'com.weiye.ttcut'
    || manifest.artifact?.file_name !== setupName
    || manifest.artifact?.size !== setupStat.size
    || manifest.artifact?.sha512 !== setupSha512
    || manifest.artifact?.authenticode?.subject !== setupSignature.Subject
    || manifest.artifact?.authenticode?.thumbprint !== expectedThumbprint
  ) {
    throw new Error('The signed update manifest does not match the official installer.');
  }
  console.log(`Verified detached update manifest: ${updateManifest} (${expectedThumbprint})`);
}
