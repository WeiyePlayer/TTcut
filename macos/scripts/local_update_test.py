#!/usr/bin/env python3
"""Exercise real Sparkle installation/relaunch and bad signatures on isolated app copies."""
import base64, functools, http.server, json, os, plistlib, shutil, subprocess, threading, time, uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/".build/xcode/Build/Products/Debug/TTcut.app"
TOOLS=ROOT/".tools/Sparkle/bin"
WORK=ROOT/"output/update-test"/str(uuid.uuid4())

def run(*args):return subprocess.check_output(list(map(str,args)),text=True)
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass

def main():
    WORK.mkdir(parents=True)
    keys=ROOT/".tools/update-test-keys";keys.mkdir(parents=True,exist_ok=True)
    private=keys/"private.txt";public=keys/"public.txt"
    generator=keys/"generate.swift"
    generator.write_text('''import Foundation
import CryptoKit
let key=Curve25519.Signing.PrivateKey()
let url=URL(fileURLWithPath:CommandLine.arguments[1])
try key.rawRepresentation.base64EncodedString().write(to:url,atomically:true,encoding:.utf8)
try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
try key.publicKey.rawRepresentation.base64EncodedString().write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8)
''')
    if not private.exists():run("swift",generator,private,public)
    server=http.server.ThreadingHTTPServer(("127.0.0.1",0),functools.partial(QuietHandler,directory=str(WORK)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f"http://127.0.0.1:{server.server_port}"
    results=[]
    try:
        for bad in [True,False]:
            name="invalid-signature" if bad else "install-relaunch"
            case=WORK/name;case.mkdir()
            log=case/"events.log"
            identifier="com.weiyeplayer.ttcut.updatetest."+uuid.uuid4().hex
            for version in [1,2]:
                app=case/str(version)/"TTcut.app"
                shutil.copytree(SOURCE,app,symlinks=True)
                plist=app/"Contents/Info.plist"
                info=plistlib.loads(plist.read_bytes())
                info.update(CFBundleIdentifier=identifier,CFBundleVersion=str(version),CFBundleShortVersionString=f"1.2.{version}",
                            SUFeedURL=f"{base}/{name}/appcast.xml",SUPublicEDKey=public.read_text().strip(),SUVerifyUpdateBeforeExtraction=True,
                            TTcutUpdateTest=True,TTcutUpdateTestLog=str(log),TTcutUpdateTestRoot=str(case/"state"),NSAppTransportSecurity={"NSAllowsLocalNetworking":True})
                plist.write_bytes(plistlib.dumps(info))
                run("codesign","--force","--sign","-",app)
            archive=case/"update.zip"
            run("ditto","-c","-k","--sequesterRsrc","--keepParent",case/"2/TTcut.app",archive)
            signature=run(TOOLS/"sign_update","-f",private,"-p",archive).strip()
            run(TOOLS/"sign_update","--verify","-f",private,archive,signature)
            if bad:signature=base64.b64encode(os.urandom(64)).decode()
            (case/"appcast.xml").write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>TTcut local test</title>
<item><title>Local test 2</title><sparkle:version>2</sparkle:version><sparkle:shortVersionString>1.2.2</sparkle:shortVersionString><sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
<enclosure url="{base}/{name}/update.zip" sparkle:edSignature="{signature}" length="{archive.stat().st_size}" type="application/octet-stream"/></item>
</channel></rss>''')
            env=os.environ.copy();env["TTCUT_UI_TEST_ROOT"]=str(case/"state")
            with (case/"app.log").open("w") as output:
                process=subprocess.Popen([str(case/"1/TTcut.app/Contents/MacOS/TTcut")],env=env,stdout=output,stderr=subprocess.STDOUT)
                deadline=time.monotonic()+100;events=""
                while time.monotonic()<deadline:
                    events=log.read_text() if log.exists() else ""
                    if (bad and "error:" in events) or (not bad and "launched-2" in events):break
                    time.sleep(0.25)
                if process.poll() is None:process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            final=plistlib.loads((case/"1/TTcut.app/Contents/Info.plist").read_bytes())["CFBundleVersion"]
            passed=("error:" in events and final=="1" and "ready-to-install" not in events) if bad else ("launched-2" in events and final=="2")
            result=dict(test=name,passed=passed,final_version=final,events=events.splitlines());results.append(result)
            print(json.dumps(result),flush=True)
        report=ROOT/"output/verification/local-update.json";report.parent.mkdir(parents=True,exist_ok=True)
        report.write_text(json.dumps(dict(work=str(WORK),results=results),indent=2)+"\n")
        if not all(item["passed"] for item in results):raise RuntimeError("Local update gate failed; inspect test logs")
    finally:server.shutdown();server.server_close()

if __name__ == "__main__":main()
