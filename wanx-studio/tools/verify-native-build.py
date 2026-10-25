"""Two synthetic local turns; no production data, files or services."""
import asyncio,json,tempfile,time,sys,base64
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from wanx_studio.codex_config import runtime_config
from wanx_studio.native_codex import NativeCodex
async def main():
 pool=NativeCodex(SimpleNamespace(project_root=Path.cwd()));config=runtime_config();results=[];session=None
 files={'miniapp.manifest.json':json.dumps({'schemaVersion':1,'name':'原生链路合成验证','entry':'src/app.js','capabilities':[],'collections':{}},ensure_ascii=False),'src/app.js':'export function mount(root,api){root.textContent="原生链路验证 A";return ()=>{root.textContent=""}}'}
 with tempfile.TemporaryDirectory(prefix='wanx-native-build-synthetic-') as folder:
  try:
   for i in range(2):
    task=Path(folder)/str(i);task.mkdir();worker=await pool.acquire(('synthetic','native-build','build'),'driver.mjs',config);proc=worker.proc;start=time.monotonic();idle=False
    instruction='现有源码已经符合验收。读取当前材料和源码，保持所有文件字节不变，直接 validate_app 交付。' if i==0 else '仅把界面文字“原生链路验证 A”改成“原生链路验证 B”。必须读取本轮现有源码，只用 patch_source 改这个文字，保留其他所有字节，validate_app 交付。'
    material={'originalGoal':'合成技术验证：仅显示一个静态标题，无数据读写，无模型调用，无用户问题。','instruction':instruction,'solution':{'workflow':instruction,'acceptance':['仅显示本轮指定文字']},'contract':{'entry':'src/app.js','export':'mount(root,api)','manifest':'miniapp.manifest.json','capabilities':[],'collections':{},'rules':['只允许静态DOM界面，无依赖、网络、Shell、外部文件或资料。']}}
    proc.stdin.write((json.dumps({'scope':'synthetic-native-build','sessionId':session,'taskRoot':str(task),'files':files,'material':material,'authorizeTools':True},ensure_ascii=False)+'\n').encode());await proc.stdin.drain()
    marks={};returned=None;attached=False;terminal_bytes=bytearray()
    async with asyncio.timeout(240):
     while line:=await proc.stdout.readline():
      e=json.loads(line);kind=e.get('type');elapsed=round(time.monotonic()-start,3)
      if kind not in marks:marks[kind]=elapsed
      if kind=='terminal':terminal_bytes.extend(base64.b64decode(e['data']))
      if kind=='status' and '终端' in e.get('text',''):print('terminal_status',i,e['text'],elapsed,flush=True)
      if kind=='session':session=e['sessionId'];print('session',i,session,e.get('reused'),elapsed,flush=True)
      if kind=='authorize':proc.stdin.write((json.dumps({'id':e['id'],'result':True})+'\n').encode());await proc.stdin.drain()
      if kind=='terminal_attached':attached=e.get('acpSessionId')==e.get('cliSessionId')
      if kind=='result':returned=e['files']
      if kind=='failed':raise RuntimeError(e)
      if kind=='idle':idle=True;break
    assert returned is not None
    if i==0:assert returned==files
    else:assert returned['miniapp.manifest.json']==files['miniapp.manifest.json'];assert returned['src/app.js']==files['src/app.js'].replace('原生链路验证 A','原生链路验证 B')
    Path('verification/last-native-terminal-'+str(i)+'.txt').write_bytes(terminal_bytes)
    files=returned;results.append({'round':i,'pid':proc.pid,'session':session,'seconds':marks,'terminalSameSession':attached})
    await pool.release(worker,idle)
   assert results[0]['pid']==results[1]['pid'] and results[0]['session']==results[1]['session']
   Path('verification/live-native-build-debug.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
   assert all(r['terminalSameSession'] for r in results)
   Path('verification/live-native-build.json').write_text(json.dumps({'passed':True,'rounds':results},ensure_ascii=False,indent=2));print(json.dumps(results,ensure_ascii=False,indent=2),flush=True)
  finally:await pool.close()
asyncio.run(main())
