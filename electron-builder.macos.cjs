module.exports = {
  appId: 'com.weiye.ttcut.electron.macos', productName: 'TTcut',
  directories: { output: 'out/make/macos/arm64' },
  artifactName: 'TTcut-${version}-macOS-arm64-electron.${ext}',
  publish: [{ provider: 'github', owner: 'WeiyePlayer', repo: 'TTcut', channel: 'latest' }],
  mac: { icon: 'macos/Resources/TTcut.icns', target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }], category: 'public.app-category.video', minimumSystemVersion: '15.0', identity: null },
  dmg: { sign: false, title: 'TTcut', contents: [{ x: 130, y: 150 }, { x: 410, y: 150, type: 'link', path: '/Applications' }] },
};
