"""End-to-end Runner lifecycle against a synthetic native server."""
import asyncio,json,sys,tempfile
from pathlib import Path
from uuid import uuid4
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from wanx_studio.service import StudioService
from wanx_studio.runner import Runner
import wanx_studio.runner as module
ROOT=Path.cwd()
async def main():
 original=module.runtime_config
 module.runtime_config=lambda *a:{'WANX_CODEX_PATH':str(ROOT/'tests/fixtures/native-codex.mjs'),'WANX_CODEX_CONFIG':json.dumps({'features':{'shell_tool':False},'mcp_servers':{}})}
 with tempfile.TemporaryDirectory(prefix='wanx-native-runner-') as folder:
  svc=StudioService(Path(folder),ROOT);svc.runner=Runner(svc);results=[]
  try:
   p=svc.store.create('synthetic-owner','原生Runner合成验证','合成目标',uuid4().hex)
   p=await svc.runner.example('synthetic-owner',p['id'],uuid4().hex)
   # A persistent business record must remain byte-identical across both builds.
   svc.store.db.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?)",('synthetic-owner','synthetic-app','production','items','synthetic-row',1,'{"title":"keep"}'))
   for _ in range(2):
    p=svc.snapshot('synthetic-owner',p['id']);p=svc.confirm('synthetic-owner',p['id'],{'operationId':uuid4().hex,'solutionHash':p['solutionHash']})
    saved=await svc.runner.start('synthetic-owner',p['id'],{'operationId':uuid4().hex,'solutionHash':p['solutionHash'],'instruction':''})
    task=saved['tasks'][-1];await svc.runner.jobs[task['id']]
    current=svc.store.get('synthetic-owner',p['id']);done=current['tasks'][-1];assert done['state']=='completed',done
    worker=svc.native_codex.workers[('synthetic-owner',p['id'],'build')]
    results.append({'pid':worker.proc.pid,'sessionId':done['sessionId'],'state':done['state']})
    assert not svc.processes and not svc.runner.jobs
   assert results[0]['pid']==results[1]['pid'] and results[0]['sessionId']==results[1]['sessionId']
   assert svc.store.db.execute('select body from records').fetchone()[0]=='{"title":"keep"}'
   Path('verification/native-service.json').write_text(json.dumps({'passed':True,'rounds':results,'recordsPreserved':True},indent=2))
   print(json.dumps(results))
  finally:await svc.close();module.runtime_config=original
asyncio.run(main())
