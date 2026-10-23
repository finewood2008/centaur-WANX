"""Contract tests for durable input while an interview/build owns the PRD."""
import asyncio,json,time
from copy import deepcopy
import pytest
from test_preparation import env,op
from wanx_studio.contracts import StudioError,digest
from wanx_studio.store import Store

async def ready(svc,pid):
 p=await svc.preparation.check('alice',pid,{'operationId':op()})
 await svc.preparation.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})

async def test_build_accepts_modifications_without_mutating_frozen_plan(env,monkeypatch):
 svc,pid,_=env;await ready(svc,pid);p=svc.store.get('alice',pid)
 p['confirmation']={'hash':digest(p['solution'])};p['tasks']=[{'id':'build','state':'running','events':[]}];svc.store.save(p)
 frozen=deepcopy(p['solution']);confirmation=deepcopy(p['confirmation'])
 body={'operationId':op(),'text':'列表需要显示意向课程，请整理方案供我确认'}
 a=await svc.preparation.pm.start('alice',pid,body)
 b=await svc.preparation.pm.start('alice',pid,body)
 assert len(b['preparation']['interview']['turns'])==1
 assert b['preparation']['interview']['turns'][0]['state']=='queued'
 assert len([m for m in b['messages'] if m['text']==body['text']])==1
 assert b['solution']==frozen and b['confirmation']==confirmation and not svc.processes
 with pytest.raises(StudioError,match='OPERATION_CONFLICT'):
  await svc.preparation.pm.start('alice',pid,{**body,'text':'changed'})
 with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):
  await svc.preparation.pm.start('bob',pid,body)
 with pytest.raises(StudioError,match='INPUT_CREDENTIAL_DETECTED'):
  await svc.preparation.pm.start('alice',pid,{'operationId':op(),'text':'password=12345678901234567'})
 assert len(svc.store.get('alice',pid)['preparation']['interview']['turns'])==1

async def test_live_interview_serializes_followups_and_associates_right_turn(env,monkeypatch):
 svc,pid,_=env;await ready(svc,pid);pm=svc.preparation.pm;gates=[];started=[];readbacks=[]
 monkeypatch.setattr('wanx_studio.product_manager.runtime_config',lambda *a:{'WANX_CODEX_CONFIG':'{}'})
 class Input:
  def write(self,data):pass
  async def drain(self):pass
 class Output:
  def __init__(self,index):self.index=index
  async def __aiter__(self):
   # Exercise the real tools, finish mutation and automatic dispatcher.
   p=svc.store.get('alice',pid);turn=p['preparation']['interview']['turnId'];started.append(turn)
   readbacks.append((await pm.tool('alice',pid,turn,'read_project',{}))['conversation'])
   await pm.tool('alice',pid,turn,'update_prd',{'expectedHash':digest(p['solution']),'summary':{'projectName':'合成流程检查'}})
   await gates[self.index].wait()
   yield json.dumps({'type':'text','text':'本轮修改已整理 '+str(self.index)}).encode()
   yield json.dumps({'type':'complete'}).encode()
 class Proc:
  def __init__(self,index):self.stdin=Input();self.stdout=Output(index);self.returncode=None
  async def wait(self):self.returncode=0;return 0
  def terminate(self):self.returncode=0
  def kill(self):self.returncode=0
 async def create(*a,**kw):
  gates.append(asyncio.Event());return Proc(len(gates)-1)
 monkeypatch.setattr(asyncio,'create_subprocess_exec',create)
 async def until(test):
  for _ in range(100):
   if test():return
   await asyncio.sleep(.01)
  assert test()
 first={'operationId':op(),'text':'先显示课程'};second={'operationId':op(),'text':'再按日期排序'}
 await pm.start('alice',pid,first);await until(lambda:len(started)==1)
 p=await pm.start('alice',pid,second)
 assert [t['state'] for t in p['preparation']['interview']['turns']]==['running','queued']
 # The frozen current round must not consume the pending text early.
 current=await pm.tool('alice',pid,started[0],'read_project',{})
 assert not any(m['text']==second['text'] for m in current['conversation'])
 gates[0].set();await until(lambda:len(started)==2)
 p=svc.snapshot('alice',pid)
 assert [t['state'] for t in p['preparation']['interview']['turns']]==['completed','running']
 assert next(m for m in p['messages'] if m['role']=='assistant')['operationId']==first['operationId']
 assert any(m['text']==second['text'] for m in readbacks[1])
 gates[1].set();await until(lambda:not svc.preparation.jobs)
 p=svc.snapshot('alice',pid)
 assert [t['state'] for t in p['preparation']['interview']['turns']]==['completed','completed']
 assert [m['operationId'] for m in p['messages'] if m['role']=='assistant']==[first['operationId'],second['operationId']]
 assert not p['tasks'] and p['confirmation'] is None
 assert len([m for m in p['messages'] if m['text']==second['text']])==1

async def test_queued_input_pauses_after_revocation_or_disconnect_and_survives_restart(env,monkeypatch,tmp_path):
 svc,pid,_=env;await ready(svc,pid);pm=svc.preparation.pm
 p=svc.store.get('alice',pid);p['tasks']=[{'id':'build','state':'running','events':[]}];svc.store.save(p)
 request={'operationId':op(),'text':'界面增加清楚的空状态'}
 await pm.start('alice',pid,request)
 p=svc.store.get('alice',pid);p['tasks'][0]['state']='completed';p['preparation']['report']=None;svc.store.save(p)
 await pm.drain('alice',pid)
 p=svc.snapshot('alice',pid)
 assert p['preparation']['interview']['error']=='CAPABILITY_CHECK_REQUIRED'
 assert p['preparation']['interview']['turns'][0]['state']=='paused' and not svc.processes
 from wanx_studio.versions import idle
 with pytest.raises(StudioError,match='PRD_NOT_SYNCHRONIZED'):idle(svc.store.get('alice',pid))
 await ready(svc,pid)
 svc.runner.leases={('alice',pid):time.monotonic()-30}
 p=svc.store.get('alice',pid);p['preparation']['interview']['turns'][0]['state']='queued';svc.store.save(p)
 await pm.drain('alice',pid)
 assert svc.snapshot('alice',pid)['preparation']['interview']['error']=='WORKBENCH_SESSION_EXPIRED'
 # A server restart keeps both running and queued input, but never auto-runs it.
 p=svc.store.get('alice',pid);p['preparation']['interview'].update({'state':'running','turnId':'a','turns':[{'id':'a','state':'running'},{'id':'b','state':'queued'}]});svc.store.save(p)
 root=tmp_path/'restart';copy=Store(root);copy.save(p);copy.close();reopened=Store(root)
 recovered=reopened.get('alice',pid)['preparation']['interview']
 assert [t['state'] for t in recovered['turns']]==['failed','paused']
 assert recovered['error']=='INTERVIEW_INTERRUPTED'
 reopened.close()

async def test_new_iteration_row_ids_remain_stable_between_read_and_patch(env,monkeypatch):
 from test_discovery import solution
 svc,pid,_=env;await ready(svc,pid);pm=svc.preparation.pm
 p=svc.store.get('alice',pid);p['solution']=solution();p['preparation'].pop('entryIds',None);svc.store.save(p)
 monkeypatch.setattr('wanx_studio.product_manager.runtime_config',lambda *a:{'WANX_CODEX_CONFIG':'{}'})
 gate=asyncio.Event()
 async def wait(*args):await gate.wait()
 monkeypatch.setattr(pm,'run',wait)
 p=await pm.start('alice',pid,{'operationId':op(),'text':'只调整现有页面的按钮文案'})
 turn=p['preparation']['interview']['turnId']
 first=await pm.tool('alice',pid,turn,'read_project',{})
 second=await pm.tool('alice',pid,turn,'read_project',{})
 assert first['entries']==second['entries']
 entry=first['entries']['pages'][0];value=deepcopy(entry['value']);value['purpose']='只调整按钮文案，保留原流程'
 result=await pm.tool('alice',pid,turn,'update_prd',{'expectedHash':first['expectedHash'],'upsert':[{'section':'pages','id':entry['id'],'value':value}]})
 assert result['saved'] and result['entries']['pages'][0]['id']==entry['id']
 gate.set()
 await asyncio.gather(*svc.background)

async def test_frozen_artifact_authorization_does_not_require_live_turn_history(env):
 from wanx_studio.versions import frozen
 svc,pid,_=env;await ready(svc,pid)
 p=svc.store.get('alice',pid);p['preparation']['interview'].update({'state':'completed','sync':'saved'})
 saved=frozen(p);p['preparation']=saved['preparation']
 assert 'turns' not in p['preparation']['interview']
 svc.preparation.guard('alice',p,development=True)

async def test_explicit_resume_keeps_fifo_for_multiple_paused_inputs(env,monkeypatch):
 svc,pid,_=env;await ready(svc,pid);pm=svc.preparation.pm
 p=svc.store.get('alice',pid);p['tasks']=[{'id':'build','state':'running','events':[]}];svc.store.save(p)
 first={'operationId':op(),'text':'先把按钮文案改成添加客户'}
 second={'operationId':op(),'text':'再将最终按钮改成记录客户'}
 await pm.start('alice',pid,first);await pm.start('alice',pid,second)
 pm.pause('alice',pid,'WORKBENCH_SESSION_EXPIRED')
 p=svc.store.get('alice',pid);p['tasks'][0]['state']='completed';svc.store.save(p)
 monkeypatch.setattr('wanx_studio.product_manager.runtime_config',lambda *a:{'WANX_CODEX_CONFIG':'{}'})
 gate=asyncio.Event()
 async def wait(*a):await gate.wait()
 monkeypatch.setattr(pm,'run',wait)
 p=await pm.start('alice',pid,second)
 turns=p['preparation']['interview']['turns']
 assert [(t['operationId'],t['state']) for t in turns]==[(first['operationId'],'running'),(second['operationId'],'queued')]
 assert len([m for m in p['messages'] if m.get('operationId') in {first['operationId'],second['operationId']}])==2
 gate.set();await asyncio.gather(*svc.background)

async def test_build_cleanup_dispatches_received_modification_without_starting_new_development(env,monkeypatch):
 from wanx_studio.runner import Runner
 svc,pid,_=env;await ready(svc,pid);pm=svc.preparation.pm;runner=Runner(svc);svc.runner=runner
 p=svc.store.get('alice',pid);p['confirmation']={'hash':digest(p['solution'])};p['tasks']=[{'id':'current-build','state':'running','events':[]}];svc.store.save(p)
 frozen=deepcopy(p['confirmation']);building=asyncio.Event();release=asyncio.Event();pm_release=asyncio.Event()
 async def execute(owner,project,task_id,instruction):
  building.set();await release.wait()
  with svc.store.transaction():
   current=svc.store.get(owner,pid);current['tasks'][0]['state']='completed';svc.store.save(current)
 async def interview(*a):await pm_release.wait()
 monkeypatch.setattr(runner,'execute',execute);monkeypatch.setattr(pm,'run',interview)
 monkeypatch.setattr('wanx_studio.product_manager.runtime_config',lambda *a:{'WANX_CODEX_CONFIG':'{}'})
 runner.touch('alice',pid);job=asyncio.create_task(runner.run('alice',p,'current-build',''))
 runner.jobs['current-build']=job
 await building.wait()
 received=await pm.start('alice',pid,{'operationId':op(),'text':'制作期间补充：将添加按钮改为添加客户，请先整理方案'})
 assert received['confirmation']==frozen and received['preparation']['interview']['turns'][-1]['state']=='queued'
 release.set();await job
 result=svc.snapshot('alice',pid)
 assert not runner.jobs and not svc.processes
 assert result['preparation']['interview']['turns'][-1]['state']=='running'
 assert result['confirmation'] is None and len(result['tasks'])==1 and result['tasks'][0]['state']=='completed'
 pm_release.set();await asyncio.gather(*svc.background)
