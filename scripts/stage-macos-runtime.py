#!/usr/bin/env python3
"""Build and stage just the native helpers and their closed runtime, not the SwiftUI app."""
from pathlib import Path
import subprocess, shutil, json, hashlib, re
ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'macos'
STAGE = ROOT / '.runtime/macos'
def run(*args): return subprocess.check_output(list(map(str,args)),text=True).strip()
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
 return h.hexdigest()
for name in ['TTcutWorker','TTcutMediaWorker']:
 subprocess.run(['swift','build','--package-path',str(NATIVE),'-c','release','--product',name],check=True)
binpath=Path(run('swift','build','--package-path',NATIVE,'-c','release','--show-bin-path'))
STAGE.mkdir(parents=True,exist_ok=True)
for name in ['bin','lib','Models']:
 p=STAGE/name
 if p.exists(): shutil.rmtree(p)
 p.mkdir()
for name in ['TTcutWorker','TTcutMediaWorker']: shutil.copy2(binpath/name,STAGE/'bin'/name)
for name in ['ffmpeg','ffprobe']: shutil.copy2(NATIVE/'Vendor/native/bin'/name,STAGE/'bin'/name)
for p in (NATIVE/'Vendor/native/lib').glob('*.dylib'):
 dst=STAGE/'lib'/p.name
 if p.is_symlink(): dst.symlink_to(p.resolve().name)
 else: shutil.copy2(p,dst)
for name in ['BlurBall','Table']: shutil.copytree(NATIVE/'Resources/Models/compiled'/(name+'.mlmodelc'),STAGE/'Models'/(name+'.mlmodelc'))
for p in list((STAGE/'lib').glob('*.dylib'))+list((STAGE/'bin').iterdir()):
 if p.is_symlink(): continue
 if run('lipo','-archs',p)!='arm64': raise RuntimeError(f'Not arm64: {p}')
 subprocess.run(['codesign','--remove-signature',str(p)],capture_output=True)
 for line in run('otool','-L',p).splitlines()[1:]:
  dep=line.strip().split(' (',1)[0]
  if dep.startswith(str(NATIVE/'Vendor/native')): run('install_name_tool','-change',dep,'@rpath/'+Path(dep).name,p)
  elif dep.startswith('/Users/') or dep.startswith('/opt/homebrew/'): raise RuntimeError(f'External dependency: {dep}')
 if p.parent.name=='lib': run('install_name_tool','-id','@rpath/'+p.name,p)
 for rpath in re.findall(r'cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset',run('otool','-l',p)):
  if rpath.startswith('/Users/') or rpath.startswith('/opt/homebrew'): run('install_name_tool','-delete_rpath',rpath,p)
 expected='@loader_path' if p.parent.name=='lib' else '@loader_path/../lib'
 run('install_name_tool','-add_rpath',expected,p)
 run('codesign','--force','--sign','-',p)
files=[dict(path=str(p.relative_to(STAGE)),bytes=p.stat().st_size,sha256=digest(p)) for p in sorted(STAGE.rglob('*')) if p.is_file() and not p.is_symlink() and p.name!='manifest.json']
(STAGE/'manifest.json').write_text(json.dumps(dict(schema_version=1,architecture='arm64',minimum_os='15.0',files=files),indent=2)+'\n')
print(f'Staged {len(files)} verified native resources at {STAGE}')
