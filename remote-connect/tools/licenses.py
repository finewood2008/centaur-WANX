from pathlib import Path
import subprocess,json,shutil,os
root=Path(__file__).resolve().parents[1];go=root.parent/'.tooling/go/bin/go';out=root/'licenses';out.mkdir(exist_ok=True)
raw='\n'.join(subprocess.check_output([str(go),'list','-deps','-json','./cmd/wanx-link'],cwd=root,text=True,env={**os.environ,'GOOS':platform,'GOARCH':arch,'CGO_ENABLED':'0'}) for platform,arch in [('darwin','arm64'),('windows','amd64')]);decoder=json.JSONDecoder();modules={};pos=0
while pos<len(raw):
 while pos<len(raw) and raw[pos].isspace():pos+=1
 if pos==len(raw):break
 item,n=decoder.raw_decode(raw,pos);pos=n;m=item.get('Module')
 if m and not m.get('Main') and m.get('Dir'):modules[m['Path']]=m
missing=[]
for name,m in modules.items():
 folder=Path(m['Dir']);files=[f for f in folder.iterdir() if f.is_file() and (f.name.upper().startswith(('LICENSE','COPYING','NOTICE','PATENTS')))]
 if not files:missing.append(name)
 dest=out/(name.replace('/','_')+'@'+m.get('Version',''));dest.mkdir(exist_ok=True)
 for f in files:shutil.copy2(f,dest/f.name)
(out/'MODULES.json').write_text(json.dumps([{'module':n,'version':m.get('Version')} for n,m in sorted(modules.items())],indent=2))
print(json.dumps({'modules':len(modules),'missingRootNotices':missing}))
