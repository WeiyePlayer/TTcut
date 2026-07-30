import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifySignedUpdatePackage } from '../src/main/update-verifier';

const SIGNER_THUMBPRINT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const INSTALLER_CONTENT = 'signed installer fixture';
const INSTALLER_SHA512 = 'q/EXy5sFcd2r42DxA4pvLYFFVSgLJplFCX1uEI71oaAnJkafVWfZrkTDipvXc4nRAwmci20JOd/c9r2QcKJ0GQ==';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

function signedReleaseAssets() {
  const manifest = `${JSON.stringify({
    schema_version: 1,
    app_id: 'com.weiye.ttcut',
    version: '1.1.2',
    channel: 'latest',
    artifact: {
      file_name: 'TTcut-1.1.2-x64-Setup.exe',
      size: 24,
      sha512: INSTALLER_SHA512,
      authenticode: {
        subject: 'CN=weiye',
        thumbprint: SIGNER_THUMBPRINT,
      },
    },
  }, null, 2)}\n`;
  const signature = `${JSON.stringify({
    schema_version: 1,
    algorithm: 'RSA-SHA256',
    key_id: SIGNER_THUMBPRINT,
    signature: sign('RSA-SHA256', Buffer.from(manifest), privateKey).toString('base64'),
  }, null, 2)}\n`;
  return new Map([
    ['update-manifest.json', Buffer.from(manifest)],
    ['update-manifest.json.sig', Buffer.from(signature)],
  ]);
}

function verificationOptions(
  installerPath: string,
  assets: Map<string, Buffer>,
): Parameters<typeof verifySignedUpdatePackage>[0] {
  return {
    installerPath,
    version: '1.1.2',
    channel: 'latest',
    trustedSigners: [{
      subject: 'CN=weiye',
      thumbprint: SIGNER_THUMBPRINT,
      publicKeyPem,
    }],
    fetchReleaseAsset: async (_version, name) => assets.get(name) ?? Buffer.alloc(0),
    inspectAuthenticode: async () => ({
      status: 'UnknownError',
      signatureType: 'Authenticode',
      subject: 'CN=weiye',
      thumbprint: SIGNER_THUMBPRINT,
      timestampSubject: 'CN=Trusted timestamp',
      chainStatus: ['UntrustedRoot'],
    }),
  };
}

describe('signed update package verification', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('accepts a release whose signed manifest, artifact hash, and pinned Authenticode signer all match', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-verifier-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'temp-TTcut-1.1.2-x64-Setup.exe');
    await writeFile(installerPath, INSTALLER_CONTENT);
    const assets = signedReleaseAssets();

    await expect(verifySignedUpdatePackage(verificationOptions(installerPath, assets)))
      .resolves.toEqual({ ok: true });
  });

  it('rejects an installer whose bytes changed after the manifest was signed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-verifier-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'temp-TTcut-1.1.2-x64-Setup.exe');
    await writeFile(installerPath, `${INSTALLER_CONTENT}!`);

    await expect(verifySignedUpdatePackage(verificationOptions(installerPath, signedReleaseAssets())))
      .resolves.toMatchObject({ ok: false, code: 'ARTIFACT_MISMATCH' });
  });

  it('rejects update metadata changed after signing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-verifier-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'temp-TTcut-1.1.2-x64-Setup.exe');
    await writeFile(installerPath, INSTALLER_CONTENT);
    const assets = signedReleaseAssets();
    const manifest = Buffer.from(assets.get('update-manifest.json') ?? Buffer.alloc(0));
    manifest[manifest.length - 2] = manifest[manifest.length - 2] === 10 ? 32 : 10;
    assets.set('update-manifest.json', manifest);

    await expect(verifySignedUpdatePackage(verificationOptions(installerPath, assets)))
      .resolves.toMatchObject({ ok: false, code: 'MANIFEST_SIGNATURE_INVALID' });
  });

  it('rejects a manifest signed by a key outside the pinned signer list', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-verifier-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'temp-TTcut-1.1.2-x64-Setup.exe');
    await writeFile(installerPath, INSTALLER_CONTENT);
    const assets = signedReleaseAssets();
    const envelope = JSON.parse(Buffer.from(assets.get('update-manifest.json.sig') ?? Buffer.alloc(0)).toString('utf8')) as {
      key_id: string;
    };
    envelope.key_id = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    assets.set('update-manifest.json.sig', Buffer.from(`${JSON.stringify(envelope)}\n`));

    await expect(verifySignedUpdatePackage(verificationOptions(installerPath, assets)))
      .resolves.toMatchObject({ ok: false, code: 'MANIFEST_SIGNATURE_INVALID' });
  });

  it('rejects a hash-mismatched Authenticode signature even when the manifest is valid', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-verifier-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'temp-TTcut-1.1.2-x64-Setup.exe');
    await writeFile(installerPath, INSTALLER_CONTENT);
    const options = verificationOptions(installerPath, signedReleaseAssets());
    options.inspectAuthenticode = async () => ({
      status: 'HashMismatch',
      signatureType: 'Authenticode',
      subject: 'CN=weiye',
      thumbprint: SIGNER_THUMBPRINT,
      timestampSubject: 'CN=Trusted timestamp',
      chainStatus: [],
    });

    await expect(verifySignedUpdatePackage(options))
      .resolves.toMatchObject({ ok: false, code: 'AUTHENTICODE_INVALID' });
  });

  it('accepts a publicly trusted Authenticode chain without weakening manifest verification', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-verifier-'));
    temporaryDirectories.push(directory);
    const installerPath = path.join(directory, 'temp-TTcut-1.1.2-x64-Setup.exe');
    await writeFile(installerPath, INSTALLER_CONTENT);
    const options = verificationOptions(installerPath, signedReleaseAssets());
    options.inspectAuthenticode = async () => ({
      status: 'Valid',
      signatureType: 'Authenticode',
      subject: 'CN=weiye',
      thumbprint: SIGNER_THUMBPRINT,
      timestampSubject: 'CN=Trusted timestamp',
      chainStatus: [],
    });

    await expect(verifySignedUpdatePackage(options)).resolves.toEqual({ ok: true });
  });
});
