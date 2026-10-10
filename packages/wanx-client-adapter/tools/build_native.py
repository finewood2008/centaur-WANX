"""Build versioned native host binaries and hash manifest for npm consumers."""
from __future__ import annotations
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from source_state import native_state

HERE=Path(__file__).resolve().parent.parent
TARGETS={"darwin-arm64":("darwin","arm64"),"darwin-x64":("darwin","amd64"),"linux-x64":("linux","amd64"),"linux-arm64":("linux","arm64"),"win32-x64":("windows","amd64"),"win32-arm64":("windows","arm64")}

def main():
    go=os.environ.get("WANX_GO") or shutil.which("go")
    if not go:raise SystemExit("Go >=1.24 required for SDK source builds; set WANX_GO or install Go")
    out=HERE/"native/bin";out.mkdir(exist_ok=True)
    requested=sys.argv[1:] or list(TARGETS)
    manifest=json.loads((out/"manifest.json").read_text()) if (out/"manifest.json").exists() else {}
    for key in requested:
        os_name,arch=TARGETS[key]
        file="centaurai-wanx-host-"+key+(".exe" if os_name=="windows" else "")
        env={**os.environ,"GOOS":os_name,"GOARCH":arch,"CGO_ENABLED":"0"}
        subprocess.run([go,"build","-trimpath","-ldflags=-s -w","-o",str(out/file),"./cmd/centaurai-wanx-host"],cwd=HERE/"native",env=env,check=True)
        manifest[key]={"file":file,"sha256":hashlib.sha256((out/file).read_bytes()).hexdigest(),"source_sha256":native_state()}
        print("built",key,flush=True)
    (out/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")

if __name__=="__main__":main()
