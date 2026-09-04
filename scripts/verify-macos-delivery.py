#!/usr/bin/env python3
"""Verify local archives and inspect the DMG without installing or publishing."""
from pathlib import Path
import hashlib, json, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
output=root/'out/make/macos/arm64'
manifest=json.loads((output/'build-manifest.json').read_text())
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as file:
  for block in iter(lambda:file.read(1024*1024),b''): h.update(block)
 return h.hexdigest()
checks=[]
for entry in manifest['files']:
 file=output/entry['file']
 assert file.stat().st_size==entry['bytes'] and digest(file)==entry['sha256'],file
 checks.append(dict(file=entry['file'],sha256=entry['sha256'],verified=True))
dmg=next(output/entry['file'] for entry in manifest['files'] if entry['file'].endswith('.dmg'))
with tempfile.TemporaryDirectory(prefix='TTcut DMG 验证 ') as directory:
 mount=Path(directory)/'mounted';mount.mkdir()
 subprocess.run(['hdiutil','attach',str(dmg),'-readonly','-nobrowse','-mountpoint',str(mount)],check=True,stdout=subprocess.DEVNULL)
 try:
  app=mount/'TTcut.app';original=Path(manifest['app'])
  subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
  for name in ['Contents/Resources/app.asar','Contents/Resources/runtime/manifest.json','Contents/_CodeSignature/CodeResources']:
   assert digest(app/name)==digest(original/name),name
  assert (mount/'Applications').is_symlink()
  subprocess.run([str(app/'Contents/Resources/runtime/bin/ffprobe'),'-version'],check=True,stdout=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin'})
 finally: subprocess.run(['hdiutil','detach',str(mount)],check=True,stdout=subprocess.DEVNULL)
report=dict(sourceCommit=manifest['sourceCommit'],build=manifest['build'],archives=checks,dmgMounted=True,signatureVerified=True,matchesPackagedApp=True,bundledFFprobeExecuted=True,passed=True)
(output/'delivery-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
