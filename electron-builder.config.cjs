const officialRelease = process.env.TTCUT_OFFICIAL_RELEASE === '1';
const independentBeta = process.env.TTCUT_INDEPENDENT_BETA === '1';
const certificateSha1 = process.env.WINDOWS_CERTIFICATE_THUMBPRINT?.replace(/\s+/g, '').toUpperCase();
const version = require('./package.json').version;
const updateChannel = version.includes('-') ? 'beta' : 'latest';
const productName = independentBeta ? 'TTcut Beta' : 'TTcut';
const executableName = independentBeta ? 'TTcut Beta' : 'TTcut';

if (officialRelease && !certificateSha1) {
  throw new Error('TTCUT_OFFICIAL_RELEASE requires WINDOWS_CERTIFICATE_THUMBPRINT.');
}

module.exports = {
  appId: independentBeta ? 'com.weiye.ttcut.beta' : 'com.weiye.ttcut',
  productName,
  executableName,
  asar: true,
  directories: {
    output: independentBeta ? 'out/make/nsis-beta/x64' : 'out/make/nsis/x64',
    buildResources: '.runtime/installer-assets',
  },
  artifactName: independentBeta ? 'TTcut-Beta-${version}-x64-Setup.${ext}' : 'TTcut-${version}-x64-Setup.${ext}',
  generateUpdatesFilesForAllChannels: !independentBeta,
  publish: independentBeta ? null : [{
    provider: 'github',
    owner: 'WeiyePlayer',
    repo: 'TTcut',
    channel: updateChannel,
  }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: '.runtime/installer-assets/ttcut.ico',
    ...(certificateSha1 ? {
      signtoolOptions: {
        certificateSha1,
        publisherName: 'weiye',
        rfc3161TimeStampServer: process.env.WINDOWS_TIMESTAMP_SERVER || 'http://timestamp.digicert.com',
      },
    } : {}),
  },
  nsis: {
    warningsAsErrors: false,
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: independentBeta,
    createDesktopShortcut: independentBeta,
    createStartMenuShortcut: independentBeta,
    runAfterFinish: true,
    displayLanguageSelector: false,
    installerLanguages: ['en_US', 'zh_CN'],
    ...(!independentBeta ? { include: 'build/installer/installer.nsh' } : {}),
    shortcutName: productName,
    uninstallDisplayName: `${productName} ${version}`,
    installerIcon: '.runtime/installer-assets/ttcut.ico',
    uninstallerIcon: '.runtime/installer-assets/ttcut.ico',
    installerHeader: '.runtime/installer-assets/header.bmp',
    installerSidebar: '.runtime/installer-assets/sidebar.bmp',
    uninstallerSidebar: '.runtime/installer-assets/sidebar.bmp',
    differentialPackage: true,
  },
};
