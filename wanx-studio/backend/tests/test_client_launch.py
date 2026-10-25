import json
from uuid import uuid4
import pytest
from wanx_studio.client_launch import ClientLaunch
from wanx_studio.contracts import StudioError
from test_preparation import env,op

class LaunchContext:
 def __init__(self,base):self.base=base;self.reads=[];self.archives=[]
 def fingerprint(self):return 'launch-context'
 async def metadata(self,owner,kind,key):return await self.base.metadata(owner,kind,key)
 async def read(self,*args):self.reads.append(args);return '真实材料正文'
 async def launch_storage(self,owner,selection):
  if owner!='alice' or selection.get('folderId')!='folder1':raise StudioError('PROJECT_STORAGE_UNAVAILABLE',403)
  return {'spaceId':'space1','folderId':'folder1','name':'项目文件','spaceName':'项目空间'}
 async def launch_warehouse(self,owner,key):
  if key!='warehouse1':raise StudioError('CONTEXT_FORBIDDEN',403)
  return {'id':key,'name':'团队仓'},[{'kind':'xingtu','id':'file1','name':'仓库资料','revision':'1'}]
 async def launch_archive(self,owner,pid,selection,artifact):
  await self.launch_storage(owner,selection);self.archives.append(artifact);return {'state':'saved','id':'archive1'}

def body(pid=None):return {'operationId':op(),'projectId':pid,'expectedRevision':0,'original':'做一个会议助手','requirement':'目标：整理会议行动项\n建议：支持人工确认','confirmed':True,'engineId':'codex','storage':{'spaceId':'space1','folderId':'folder1'},'warehouseIds':['warehouse1'],'references':[{'kind':'space','id':'file1'}]}

@pytest.fixture
async def launch(env):
 svc,pid,calls=env
 provider=LaunchContext(svc.context_provider);svc.context_provider=provider
 svc.engines.provider=lambda owner:{'codex':{'command':'codex-acp','args':[],'trusted':True,'enabled':True}}
 bridge=ClientLaunch(svc);svc.client_launch=bridge
 return svc,pid,calls,bridge,provider

async def test_suggestion_is_stateless_and_only_uses_input(launch):
 svc,pid,calls,bridge,provider=launch
 async def model(owner,value):
  calls.append(value);return {'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'requirement':'目标：会议助手\n建议：待办确认'},ensure_ascii=False)}}]}
 svc.model=model
 before=svc.store.get('alice',pid)
 result=await bridge.suggest('alice',{'text':'我要会议助手'})
 assert '建议' in result['requirement']
 assert calls[-1]['messages'][-1]['content']=='我要会议助手'
 assert svc.store.get('alice',pid)==before and provider.reads==[]
 assert 'PRIVATE_FILENAME' not in json.dumps(calls,ensure_ascii=False)

async def test_confirmation_storage_and_engine_are_enforced(launch):
 svc,pid,calls,bridge,provider=launch
 request=body(pid);request['confirmed']=False
 with pytest.raises(StudioError,match='REQUIREMENT_CONFIRMATION_REQUIRED'):await bridge.configure('alice',request)
 request['confirmed']=True;request['storage']['folderId']='outside'
 with pytest.raises(StudioError,match='PROJECT_STORAGE_UNAVAILABLE'):await bridge.configure('alice',request)
 request['storage']['folderId']='folder1';request['engineId']='untrusted'
 with pytest.raises(StudioError,match='ENGINE_NOT_CONFIGURED'):await bridge.configure('alice',request)
 assert svc.store.get('alice',pid)['preparation']['revision']==0

async def test_confirmed_launch_hands_off_resources_but_never_confirms_prd_or_builds(launch):
 svc,pid,calls,bridge,provider=launch
 request=body(pid);p=await bridge.configure('alice',request)
 config=p['preparation']['launchConfiguration']
 assert config['storage']['folderId']=='folder1' and config['engineId']=='codex'
 assert len(p['preparation']['references'])==2 and provider.reads==[] and calls==[]
 assert p['preparation']['required']==[]
 p=await bridge.start('alice',pid)
 assert p['preparation']['phase']=='acp'
 assert p['preparation']['handoff']['launchConfiguration']==config
 assert p['confirmation'] is None and not p['tasks'] and provider.reads==[]
 assert '建议：支持人工确认' in p['preparation']['handoff']['brief']['goal']

async def test_launch_does_not_modify_other_users_projects_or_accept_stale_revision(launch):
 svc,pid,calls,bridge,provider=launch
 request=body(pid);request['expectedRevision']=8
 with pytest.raises(StudioError,match='INTAKE_CHANGED'):await bridge.configure('alice',request)
 request['expectedRevision']=0
 await bridge.configure('alice',request)
 assert (await bridge.configure('alice',request))['preparation']['revision']==1
 request['requirement']='偷偷改需求'
 with pytest.raises(StudioError,match='OPERATION_CONFLICT'):await bridge.configure('alice',request)

async def test_warehouse_denial_and_changed_material_abort_launch(launch):
 svc,pid,calls,bridge,provider=launch
 request=body(pid);request['warehouseIds']=['other-warehouse']
 with pytest.raises(StudioError,match='CONTEXT_FORBIDDEN'):await bridge.configure('alice',request)
 request['warehouseIds']=[];p=await bridge.configure('alice',request)
 provider.base.revision='changed'
 with pytest.raises(StudioError,match='CONTEXT_SOURCE_CHANGED'):await bridge.start('alice',pid)
 assert not svc.store.get('alice',pid)['tasks']

async def test_version_archive_records_actual_storage_receipt(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid))
 artifact={'hash':'a'*64,'version':'0.1.0','files':{'src/main.tsx':'source'}}
 await bridge.archive('alice',pid,artifact)
 assert provider.archives==[artifact]
 assert svc.store.get('alice',pid)['preparation']['storageReceipts'][artifact['hash']]['state']=='saved'

async def test_blocked_credential_source_is_explicitly_excluded_without_sending_it(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid))
 p=svc.store.get('alice',pid);p['preparation']['phase']='acp';p['preparation']['interview'].update({'state':'running','turnId':'safe-turn'});svc.store.save(p)
 async def read(owner,project,key,*bounds):
  if key.startswith('xingtu:'):raise StudioError('CONTEXT_CREDENTIAL_DETECTED',403)
  return {'ref':key,'text':'safe synthetic background','nextOffset':None,'totalCharacters':25}
 svc.preparation.read_context=read
 prepared=await svc.preparation.pm.prepare_context('alice',pid,'safe-turn')
 assert len(prepared)==1 and prepared[0]['text']=='safe synthetic background'
 latest=svc.store.get('alice',pid)
 assert all(part['ref'].startswith('space:') for part in prepared)
 async def denied(*args):raise StudioError('CONTEXT_NOT_SELECTED',403)
 svc.preparation.read_context=denied
 with pytest.raises(StudioError,match='CONTEXT_NOT_SELECTED'):await svc.preparation.pm.prepare_context('alice',pid,'safe-turn')

async def test_known_launch_capabilities_probe_and_resume_pending_user_turn(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid));await bridge.start('alice',pid)
 p=svc.store.get('alice',pid);x=p['preparation'];x['required']=['data','model'];p['solution']['capabilities']=['data','model'];x['report']=None
 x['interview'].update({'state':'failed','sync':'saved','error':'CAPABILITY_CHECK_REQUIRED','needsCapabilities':True,'turns':[{'id':'pending-user','operationId':'pending-op','text':'用户尚未处理的补充','state':'paused'}]});svc.store.save(p)
 assert await svc.preparation.pm.check_launch_capabilities('alice',pid)
 p=svc.store.get('alice',pid);x=p['preparation'];s=x['interview']
 assert not s['needsCapabilities'] and s['error'] is None
 assert len(s['turns'])==1 and s['turns'][0]['text']=='用户尚未处理的补充' and s['turns'][0]['state']=='queued'
 assert svc.preparation.valid_report('alice',p,development=True)
 assert p['confirmation'] is None and not p['tasks']
 assert len(calls)==1 # Actual synthetic model probe; no background content in prompt.
 assert 'PRIVATE' not in json.dumps(calls) and provider.reads==[]

async def test_failed_or_unsupported_probe_remains_visible_and_cannot_build(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid));await bridge.start('alice',pid)
 p=svc.store.get('alice',pid);x=p['preparation'];x['required']=['model'];p['solution']['capabilities']=['model'];x['report']=None;x['interview']['needsCapabilities']=True;svc.store.save(p)
 async def fail(*args):raise StudioError('MODEL_UPSTREAM_FAILED',502)
 svc.model=fail
 assert not await svc.preparation.pm.check_launch_capabilities('alice',pid)
 p=svc.store.get('alice',pid)
 assert p['preparation']['interview']['needsCapabilities'] and not svc.preparation.valid_report('alice',p,development=True)
 assert p['preparation']['report']['results']['model']['status']=='failed'
 p['preparation']['gaps']=['未接入的外部连接器'];svc.store.save(p);before=len(calls)
 assert not await svc.preparation.pm.check_launch_capabilities('alice',pid)
 assert len(calls)==before and not svc.store.get('alice',pid)['tasks']


async def test_prd_added_capability_is_checked_without_manual_flag_or_extra_interview(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid));await bridge.start('alice',pid)
 p=svc.store.get('alice',pid);x=p['preparation']
 p['solution']['capabilities']=['data','model','files']
 x['interview'].update({'state':'completed','sync':'saved','turns':[]})
 x['interview'].pop('needsCapabilities',None);x.pop('launchConfiguration',None)
 svc.store.save(p)
 original=svc.store.get('alice',pid)['solution']
 assert await svc.preparation.pm.check_launch_capabilities('alice',pid)
 p=svc.store.get('alice',pid)
 assert svc.preparation.valid_report('alice',p,development=True)
 assert p['solution']==original and p['preparation']['interview']['sync']=='saved'
 assert p['preparation']['interview']['turns']==[] and not p['tasks']
 assert not await svc.preparation.pm.check_launch_capabilities('alice',pid)

async def test_build_prepares_stale_report_without_changing_selected_resources(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid));await bridge.start('alice',pid)
 p=svc.store.get('alice',pid);p['solution']['capabilities']=['data','model','files']
 x=p['preparation'];x['report']=None;x['interview'].update({'state':'completed','sync':'saved','turns':[]})
 svc.store.save(p)
 from copy import deepcopy
 original=deepcopy(p)
 result=await svc.preparation.ensure_development('alice',pid)
 assert svc.preparation.valid_report('alice',result,development=True)
 assert result['solution']==original['solution'] and result['preparation']['references']==original['preparation']['references']
 assert result['preparation']['launchConfiguration']==original['preparation']['launchConfiguration']
 assert result['preparation']['interview']['sync']=='saved' and not result['tasks']
 # Repeated builds reuse the valid check rather than making extra model requests.
 count=len(calls);await svc.preparation.ensure_development('alice',pid);assert len(calls)==count

async def test_automatic_checks_report_real_failure_and_do_not_grant_knowledge(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid));await bridge.start('alice',pid)
 p=svc.store.get('alice',pid);p['solution']['capabilities']=['model']
 x=p['preparation'];x['report']=None;x['interview'].update({'state':'completed','sync':'saved','turns':[]});svc.store.save(p)
 async def failed(*args):raise StudioError('MODEL_UPSTREAM_FAILED',502)
 svc.model=failed
 with pytest.raises(StudioError,match='MODEL_UPSTREAM_FAILED'):
  await svc.preparation.ensure_development('alice',pid)
 assert not svc.store.get('alice',pid)['tasks']
 p=svc.store.get('alice',pid);p['solution']['capabilities']=['knowledge'];svc.store.save(p)
 with pytest.raises(StudioError,match='KNOWLEDGE_UNAVAILABLE'):
  await svc.preparation.ensure_development('alice',pid)
 assert not svc.store.get('alice',pid)['tasks']

async def test_automatic_readiness_keeps_prd_sync_and_admin_guards(launch):
 svc,pid,calls,bridge,provider=launch
 await bridge.configure('alice',body(pid));await bridge.start('alice',pid)
 p=svc.store.get('alice',pid);p['preparation']['interview'].update({'state':'completed','sync':'pending'});svc.store.save(p)
 with pytest.raises(StudioError,match='PRD_NOT_SYNCHRONIZED'):
  await svc.preparation.ensure_development('alice',pid)
 class Team:
  def is_admin(self,owner):return False
 svc.team=Team()
 with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
  await svc.preparation.ensure_development('alice',pid)
