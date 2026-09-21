import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const THUMBPRINT_PATTERN = /^[A-F0-9]{40}$/;

const { values, positionals } = parseArgs({
  allowPositionals: false,
  strict: true,
  options: {
    installer: { type: 'string' },
    output: { type: 'string' },
    version: { type: 'string' },
    channel: { type: 'string' },
    'signer-subject': { type: 'string' },
    'signer-thumbprint': { type: 'string' },
  },
});
if (positionals.length) throw new Error('Positional arguments are not supported.');

const installerPath = values.installer ? path.resolve(values.installer) : '';
const outputPath = values.output ? path.resolve(values.output) : '';
const version = values.version ?? '';
const channel = values.channel ?? '';
const signerSubject = values['signer-subject'] ?? '';
const signerThumbprint = (values['signer-thumbprint'] ?? '').replace(/\s+/g, '').toUpperCase();

if (!installerPath || !outputPath) throw new Error('--installer and --output are required.');
if (!VERSION_PATTERN.test(version)) throw new Error('--version is invalid.');
if (channel !== (version.includes('-') ? 'beta' : 'latest')) {
  throw new Error('--channel does not match the release version.');
}
if (signerSubject !== 'CN=weiye') throw new Error('--signer-subject must be CN=weiye.');
if (!THUMBPRINT_PATTERN.test(signerThumbprint)) throw new Error('--signer-thumbprint is invalid.');
if (installerPath.toLocaleLowerCase() === outputPath.toLocaleLowerCase()) {
  throw new Error('The update manifest cannot overwrite the installer.');
}

const expectedInstallerName = `TTcut-${version}-x64-Setup.exe`;
if (path.basename(installerPath) !== expectedInstallerName) {
  throw new Error(`The installer must be named ${expectedInstallerName}.`);
}

async function sha512(filePath) {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest('base64');
}

const installerStat = await stat(installerPath);
if (!installerStat.isFile() || installerStat.size <= 0) throw new Error('The installer is missing or empty.');

const manifest = {
  schema_version: 1,
  app_id: 'com.weiye.ttcut',
  version,
  channel,
  artifact: {
    file_name: expectedInstallerName,
    size: installerStat.size,
    sha512: await sha512(installerPath),
    authenticode: {
      subject: signerSubject,
      thumbprint: signerThumbprint,
    },
  },
};
const source = `${JSON.stringify(manifest, null, 2)}\n`;
const partialPath = `${outputPath}.partial`;
await writeFile(partialPath, source, { encoding: 'utf8', flag: 'wx' });
await rename(partialPath, outputPath);
console.log(`Generated signed-update manifest payload: ${outputPath}`);
