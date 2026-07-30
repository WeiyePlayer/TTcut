import { createHash, verify as verifySignature } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const THUMBPRINT_PATTERN = /^[A-F0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const updateManifestSchema = z.object({
  schema_version: z.literal(1),
  app_id: z.literal('com.weiye.ttcut'),
  version: z.string().regex(VERSION_PATTERN),
  channel: z.enum(['latest', 'beta']),
  artifact: z.object({
    file_name: z.string().regex(/^TTcut-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-x64-Setup\.exe$/),
    size: z.number().int().positive(),
    sha512: z.string().regex(BASE64_PATTERN),
    authenticode: z.object({
      subject: z.string().min(1),
      thumbprint: z.string().regex(THUMBPRINT_PATTERN),
    }).strict(),
  }).strict(),
}).strict();

const updateManifestSignatureSchema = z.object({
  schema_version: z.literal(1),
  algorithm: z.literal('RSA-SHA256'),
  key_id: z.string().regex(THUMBPRINT_PATTERN),
  signature: z.string().regex(BASE64_PATTERN),
}).strict();

export interface TrustedUpdateSigner {
  subject: string;
  thumbprint: string;
  publicKeyPem: string;
}

export interface AuthenticodeInspection {
  status: string;
  signatureType: string;
  subject: string;
  thumbprint: string;
  timestampSubject: string;
  chainStatus: string[];
}

export type UpdateVerificationResult =
  | { ok: true }
  | {
    ok: false;
    code:
      | 'MANIFEST_UNAVAILABLE'
      | 'MANIFEST_INVALID'
      | 'MANIFEST_SIGNATURE_INVALID'
      | 'RELEASE_MISMATCH'
      | 'ARTIFACT_MISMATCH'
      | 'AUTHENTICODE_INVALID';
    detail: string;
  };

export interface VerifySignedUpdatePackageOptions {
  installerPath: string;
  version: string;
  channel: 'latest' | 'beta';
  trustedSigners: readonly TrustedUpdateSigner[];
  fetchReleaseAsset(version: string, name: string): Promise<Uint8Array>;
  inspectAuthenticode(installerPath: string): Promise<AuthenticodeInspection>;
}

function normalizeThumbprint(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function failure(code: Exclude<UpdateVerificationResult, { ok: true }>['code'], detail: string): UpdateVerificationResult {
  return { ok: false, code, detail };
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

async function sha512(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest('base64');
}

function acceptsAuthenticodeStatus(inspection: AuthenticodeInspection): boolean {
  if (inspection.status === 'Valid') return inspection.chainStatus.length === 0;
  return inspection.status === 'UnknownError'
    && inspection.chainStatus.length === 1
    && inspection.chainStatus[0] === 'UntrustedRoot';
}

export async function verifySignedUpdatePackage(
  options: VerifySignedUpdatePackageOptions,
): Promise<UpdateVerificationResult> {
  if (!VERSION_PATTERN.test(options.version)) {
    return failure('RELEASE_MISMATCH', 'The update version is malformed.');
  }

  let manifestBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    [manifestBytes, signatureBytes] = await Promise.all([
      options.fetchReleaseAsset(options.version, 'update-manifest.json'),
      options.fetchReleaseAsset(options.version, 'update-manifest.json.sig'),
    ]);
  } catch (error) {
    return failure('MANIFEST_UNAVAILABLE', error instanceof Error ? error.message : String(error));
  }
  if (
    manifestBytes.byteLength === 0
    || manifestBytes.byteLength > MAX_MANIFEST_BYTES
    || signatureBytes.byteLength === 0
    || signatureBytes.byteLength > MAX_SIGNATURE_BYTES
  ) {
    return failure('MANIFEST_INVALID', 'The signed update metadata has an invalid size.');
  }

  const parsedSignature = updateManifestSignatureSchema.safeParse(
    (() => {
      try {
        return decodeJson(signatureBytes);
      } catch {
        return null;
      }
    })(),
  );
  if (!parsedSignature.success) {
    return failure('MANIFEST_INVALID', 'The update signature envelope is malformed.');
  }

  const signer = options.trustedSigners.find(
    (candidate) => normalizeThumbprint(candidate.thumbprint) === parsedSignature.data.key_id,
  );
  if (!signer || !THUMBPRINT_PATTERN.test(normalizeThumbprint(signer.thumbprint))) {
    return failure('MANIFEST_SIGNATURE_INVALID', 'The update manifest signer is not trusted.');
  }

  let manifestSignatureValid = false;
  try {
    manifestSignatureValid = verifySignature(
      'RSA-SHA256',
      manifestBytes,
      signer.publicKeyPem,
      Buffer.from(parsedSignature.data.signature, 'base64'),
    );
  } catch {
    manifestSignatureValid = false;
  }
  if (!manifestSignatureValid) {
    return failure('MANIFEST_SIGNATURE_INVALID', 'The update manifest signature is invalid.');
  }

  const parsedManifest = updateManifestSchema.safeParse(
    (() => {
      try {
        return decodeJson(manifestBytes);
      } catch {
        return null;
      }
    })(),
  );
  if (!parsedManifest.success) {
    return failure('MANIFEST_INVALID', 'The update manifest is malformed.');
  }
  const manifest = parsedManifest.data;
  const expectedFileName = `TTcut-${options.version}-x64-Setup.exe`;
  if (
    manifest.version !== options.version
    || manifest.channel !== options.channel
    || manifest.artifact.file_name !== expectedFileName
  ) {
    return failure('RELEASE_MISMATCH', 'The signed update metadata does not match the requested release.');
  }

  const expectedThumbprint = normalizeThumbprint(signer.thumbprint);
  if (
    manifest.artifact.authenticode.subject !== signer.subject
    || manifest.artifact.authenticode.thumbprint !== expectedThumbprint
  ) {
    return failure('RELEASE_MISMATCH', 'The signed update metadata names an unexpected Authenticode signer.');
  }

  let installerStat;
  let installerSha512;
  try {
    [installerStat, installerSha512] = await Promise.all([
      stat(options.installerPath),
      sha512(options.installerPath),
    ]);
  } catch (error) {
    return failure('ARTIFACT_MISMATCH', error instanceof Error ? error.message : String(error));
  }
  if (
    !installerStat.isFile()
    || installerStat.size !== manifest.artifact.size
    || installerSha512 !== manifest.artifact.sha512
  ) {
    return failure('ARTIFACT_MISMATCH', 'The downloaded installer does not match the signed update manifest.');
  }

  let inspection: AuthenticodeInspection;
  try {
    inspection = await options.inspectAuthenticode(options.installerPath);
  } catch (error) {
    return failure('AUTHENTICODE_INVALID', error instanceof Error ? error.message : String(error));
  }
  if (
    inspection.signatureType !== 'Authenticode'
    || inspection.subject !== signer.subject
    || normalizeThumbprint(inspection.thumbprint) !== expectedThumbprint
    || !inspection.timestampSubject.trim()
    || !acceptsAuthenticodeStatus(inspection)
  ) {
    return failure('AUTHENTICODE_INVALID', 'The installer Authenticode signature is invalid.');
  }

  return { ok: true };
}
