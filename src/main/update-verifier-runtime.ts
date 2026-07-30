import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { promisify } from 'node:util';
import { net } from 'electron';
import type { VerifyUpdateCodeSignature } from 'electron-updater';
import {
  verifySignedUpdatePackage,
  type AuthenticodeInspection,
  type TrustedUpdateSigner,
} from './update-verifier';
import updateTrust from './update-trust.json';

const execFileAsync = promisify(execFile);
const RELEASE_BASE_URL = 'https://github.com/WeiyePlayer/TTcut/releases/download';
const RELEASE_ASSET_NAMES = new Set(['update-manifest.json', 'update-manifest.json.sig']);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_RELEASE_ASSET_BYTES = 64 * 1024;
const RELEASE_ASSET_TIMEOUT_MS = 30_000;

function loadTrustedUpdateSigners(): readonly TrustedUpdateSigner[] {
  if (updateTrust.schema_version !== 1 || !Array.isArray(updateTrust.signers) || updateTrust.signers.length === 0) {
    throw new Error('UPDATE_TRUST_CONFIG_INVALID');
  }
  return Object.freeze(updateTrust.signers.map((record) => {
    const certificate = new X509Certificate(Buffer.from(record.certificate_der_base64, 'base64'));
    const certificateThumbprint = certificate.fingerprint.replaceAll(':', '').toUpperCase();
    if (
      certificate.subject !== record.subject
      || certificateThumbprint !== record.thumbprint
      || !/^[A-F0-9]{40}$/.test(record.thumbprint)
    ) {
      throw new Error('UPDATE_TRUST_CERTIFICATE_INVALID');
    }
    return Object.freeze({
      subject: record.subject,
      thumbprint: record.thumbprint,
      publicKeyPem: certificate.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
  }));
}

export const TRUSTED_UPDATE_SIGNERS = loadTrustedUpdateSigners();

async function readLimitedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RELEASE_ASSET_BYTES) {
    throw new Error('UPDATE_MANIFEST_TOO_LARGE');
  }
  if (!response.body) throw new Error('UPDATE_MANIFEST_EMPTY');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RELEASE_ASSET_BYTES) {
      await reader.cancel();
      throw new Error('UPDATE_MANIFEST_TOO_LARGE');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function fetchUpdateReleaseAsset(version: string, name: string): Promise<Uint8Array> {
  if (!VERSION_PATTERN.test(version) || !RELEASE_ASSET_NAMES.has(name)) {
    throw new Error('UPDATE_MANIFEST_ASSET_INVALID');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_ASSET_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await net.fetch(`${RELEASE_BASE_URL}/v${version}/${name}`, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`UPDATE_MANIFEST_HTTP_${response.status}`);
    return await readLimitedBody(response);
  } finally {
    clearTimeout(timeout);
  }
}

export async function inspectWindowsAuthenticode(installerPath: string): Promise<AuthenticodeInspection> {
  const command = [
    '$signature=Get-AuthenticodeSignature -LiteralPath $env:TTCUT_UPDATE_VERIFY_FILE;',
    'if ($null -eq $signature.SignerCertificate) { throw "UPDATE_INSTALLER_NOT_SIGNED" };',
    '$chain=New-Object System.Security.Cryptography.X509Certificates.X509Chain;',
    '$chain.ChainPolicy.RevocationMode=[System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck;',
    '[void]$chain.Build($signature.SignerCertificate);',
    '[pscustomobject]@{',
    'Status=[string]$signature.Status;',
    'SignatureType=[string]$signature.SignatureType;',
    'Subject=[string]$signature.SignerCertificate.Subject;',
    'Thumbprint=[string]$signature.SignerCertificate.Thumbprint;',
    'TimestampSubject=[string]$signature.TimeStamperCertificate.Subject;',
    'ChainStatus=@($chain.ChainStatus|ForEach-Object{[string]$_.Status})',
    '}|ConvertTo-Json -Compress',
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-InputFormat', 'None',
    '-Command', command,
  ], {
    encoding: 'utf8',
    env: { ...process.env, TTCUT_UPDATE_VERIFY_FILE: installerPath },
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  const value = JSON.parse(stdout.trim()) as {
    Status?: unknown;
    SignatureType?: unknown;
    Subject?: unknown;
    Thumbprint?: unknown;
    TimestampSubject?: unknown;
    ChainStatus?: unknown;
  };
  return {
    status: String(value.Status ?? ''),
    signatureType: String(value.SignatureType ?? ''),
    subject: String(value.Subject ?? ''),
    thumbprint: String(value.Thumbprint ?? ''),
    timestampSubject: String(value.TimestampSubject ?? ''),
    chainStatus: Array.isArray(value.ChainStatus)
      ? value.ChainStatus.map(String)
      : value.ChainStatus == null ? [] : [String(value.ChainStatus)],
  };
}

export function createUpdateCodeSignatureVerifier(
  getVersion: () => string | null,
): VerifyUpdateCodeSignature {
  return async (_publisherNames, installerPath) => {
    const version = getVersion();
    if (!version) return 'UPDATE_VERSION_UNAVAILABLE';
    const result = await verifySignedUpdatePackage({
      installerPath,
      version,
      channel: version.includes('-') ? 'beta' : 'latest',
      trustedSigners: TRUSTED_UPDATE_SIGNERS,
      fetchReleaseAsset: fetchUpdateReleaseAsset,
      inspectAuthenticode: inspectWindowsAuthenticode,
    });
    return result.ok ? null : `${result.code}: ${result.detail}`;
  };
}
