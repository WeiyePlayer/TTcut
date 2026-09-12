#!/usr/bin/env python3
"""Audit a packaged Electron app, including its independent native runtime."""
from pathlib import Path
import subprocess, sys, json, re, plistlib, tempfile, shutil
app=Path(sys.argv[1]).resolve()
report=Path(sys.argv[2]) if len(sys.argv)>2 else app.parent/'bundle-audit.json'
def run(*args): return subprocess.check_output(list(map(str,args)),text=True,stderr=subprocess.STDOUT).strip()
run('codesign','--verify','--deep','--strict',app)
plist=plistlib.loads((app/'Contents/Info.plist').read_bytes())
assert plist['LSMinimumSystemVersion']=='15.0'
assert not (app/'Contents/Resources/app-update.yml').exists()
magic=[bytes.fromhex(v) for v in ['cffaedfe','feedfacf','cafebabe','bebafeca']]
binaries=[]
for p in app.rglob('*'):
 if p.is_symlink() or not p.is_file() or any(word in p.name.lower() for word in ['license','notice','copyright','copying']): continue
 with p.open('rb') as f: header=f.read(4)
 if header not in magic: continue
 arches=run('lipo','-archs',p); assert arches=='arm64',(p,arches)
 dependencies=[]
 # otool-classic treats a filename ending in parentheses as archive(member).
 with tempfile.TemporaryDirectory(prefix='ttcut-binary-audit-') as temporary:
  inspected=Path(temporary)/'binary'; shutil.copy2(p,inspected)
  dependency_text=run('otool','-L',inspected); loads=run('otool','-l',inspected)
 for line in dependency_text.splitlines()[1:]:
  dep=line.strip().split(' (',1)[0]
  own_install_name = p.suffix == '.dylib' and dep in (p.name, './'+p.name)
  assert own_install_name or dep.startswith(('@','/System/Library/','/usr/lib/')),(p,dep)
  dependencies.append(dep)
 minimum=re.findall(r'\bminos\s+([\d.]+)',loads)
 assert all(tuple(map(int,v.split('.'))) <= (15,0,0) for v in minimum),(p,minimum)
 for rpath in re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset',loads):
  assert not rpath.startswith(('/Users/','/opt/homebrew/')),(p,rpath)
 binaries.append(dict(path=str(p.relative_to(app)),architecture=arches,minimum_os=minimum,dependencies=dependencies))
assert any(p['path'].endswith('/TTcutWorker') for p in binaries)
assert any(p['path'].endswith('/TTcutMediaWorker') for p in binaries)
result=dict(app=str(app),bundle_id=plist['CFBundleIdentifier'],minimum_os=plist['LSMinimumSystemVersion'],signature='verified ad-hoc',binaries=binaries,passed=True)
report.parent.mkdir(parents=True,exist_ok=True); report.write_text(json.dumps(result,indent=2)+'\n')
print(f'Passed: {len(binaries)} arm64 Mach-O files, app-relative/system dependencies, signatures, minimum OS; {report}')
