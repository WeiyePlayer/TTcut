import { execFile } from 'node:child_process';
import { verify, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function createTestCertificate(pfxPath: string, certificatePath: string): Promise<void> {
  const source = [
    '$ErrorActionPreference="Stop"',
    '$rsa=[System.Security.Cryptography.RSA]::Create(2048)',
    '$certificate=$null',
    'try {',
    '$request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=weiye",$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
    '$oids=New-Object System.Security.Cryptography.OidCollection',
    '[void]$oids.Add((New-Object System.Security.Cryptography.Oid("1.3.6.1.5.5.7.3.3")))',
    '$request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($oids,$false)))',
    '$request.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,$true)))',
    '$certificate=$request.CreateSelfSigned([DateTimeOffset]::Now.AddMinutes(-1),[DateTimeOffset]::Now.AddDays(1))',
    '[IO.File]::WriteAllBytes($env:TTCUT_TEST_PFX,$certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,"test-password"))',
    '[IO.File]::WriteAllBytes($env:TTCUT_TEST_CERT,$certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))',
    '} finally {',
    'if($certificate){$certificate.Dispose()}',
    '$rsa.Dispose()',
    '}',
  ].join(';');
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(source, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, TTCUT_TEST_PFX: pfxPath, TTCUT_TEST_CERT: certificatePath },
    windowsHide: true,
  });
}

describe('update manifest signing command', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('signs the exact manifest bytes with the selected certificate private key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ttcut-update-signature-'));
    temporaryDirectories.push(directory);
    const pfxPath = path.join(directory, 'signer.pfx');
    const certificatePath = path.join(directory, 'signer.cer');
    const manifestPath = path.join(directory, 'update-manifest.json');
    const signaturePath = path.join(directory, 'update-manifest.json.sig');
    await createTestCertificate(pfxPath, certificatePath);
    const certificate = new X509Certificate(await readFile(certificatePath));
    const thumbprint = certificate.fingerprint.replaceAll(':', '');
    const manifest = `${JSON.stringify({
      schema_version: 1,
      app_id: 'com.weiye.ttcut',
      version: '1.1.2',
      channel: 'latest',
      artifact: {
        file_name: 'TTcut-1.1.2-x64-Setup.exe',
        size: 24,
        sha512: 'q/EXy5sFcd2r42DxA4pvLYFFVSgLJplFCX1uEI71oaAnJkafVWfZrkTDipvXc4nRAwmci20JOd/c9r2QcKJ0GQ==',
        authenticode: { subject: 'CN=weiye', thumbprint },
      },
    }, null, 2)}\n`;
    await writeFile(manifestPath, manifest);

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve('scripts/sign-update-manifest.ps1'),
      '-ManifestPath', manifestPath,
      '-SignaturePath', signaturePath,
      '-CertificatePfxPath', pfxPath,
      '-CertificatePfxPassword', 'test-password',
    ], { cwd: path.resolve('.'), windowsHide: true });

    const envelope = JSON.parse(await readFile(signaturePath, 'utf8')) as {
      schema_version: number;
      algorithm: string;
      key_id: string;
      signature: string;
    };
    expect(envelope).toMatchObject({
      schema_version: 1,
      algorithm: 'RSA-SHA256',
      key_id: thumbprint,
    });
    expect(verify(
      'RSA-SHA256',
      Buffer.from(manifest),
      certificate.publicKey,
      Buffer.from(envelope.signature, 'base64'),
    )).toBe(true);
  });
});
