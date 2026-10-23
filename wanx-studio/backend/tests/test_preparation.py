import asyncio,json
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
import pytest
from wanx_studio.service import StudioService
from wanx_studio.contracts import StudioError,digest
from wanx_studio.preparation import CATALOG
from wanx_studio.prd_patch import apply_patch,rows
from test_discovery import solution
ROOT=Path(__file__).resolve().parents[2]
def op():return uuid4().hex
class Context:
 def __init__(self):self.reads=[];self.revision='1'
 def fingerprint(self):return 'context-adapter-v1'
 async def list(self,owner,kind,parent):return {'items':[{'kind':kind,'id':'file1','name':'PRIVATE_FILENAME.txt','revision':self.revision}]}
 async def metadata(self,owner,kind,key):
  if owner!='alice' or key!='file1':raise StudioError('CONTEXT_FORBIDDEN',403)
  return {'kind':kind,'id':key,'name':'PRIVATE_FILENAME.txt','revision':self.revision}
 async def read(self,owner,kind,key):self.reads.append((owner,kind,key));return 'PRIVATE_BODY '+('资料段落'*9000)
@pytest.fixture
async def env(tmp_path):
 svc=StudioService(tmp_path,ROOT);calls=[]
 async def model(owner,body):
  calls.append(body)
  if body['messages'][0]['content'].startswith('你是万象客户端'):
   content=json.dumps({'message':'最近一次整理会议时，最费力的是哪一步？','brief':{'goal':'会议助手','scenario':'每周例会','pain':'行动遗漏'},'capabilities':['data','model'],'options':['找不到负责人','忘记期限']},ensure_ascii=False)
  else:content='WANX_OK'
  return {'choices':[{'finish_reason':'stop','message':{'content':content}}]}
 svc.model=model
 async def files(owner,ids):return []
 svc.files=files;svc.context_provider=Context()
 class Runner:
  async def preflight(self,**kwargs):return {'available':True,'modelCalls':0,'policy':{'scope':'task-MCP-tools-only'}}
 svc.runner=Runner()
 p=svc.store.create('alice','测试','会议行动项跟进',op());svc.preparation.enable('alice',p['id'])
 yield svc,p['id'],calls
 await svc.close()
async def test_intake_never_receives_context_or_source_names_and_is_idempotent(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.set_context('alice',pid,{'references':[{'kind':'space','id':'file1'}],'expectedRevision':0})
 with pytest.raises(StudioError,match='CONTEXT_NOT_HANDED_OFF'):await prep.read_context('alice',pid,'space:file1')
 request={'operationId':op(),'text':'会后经常忘记行动项'}
 await asyncio.gather(prep.intake('alice',pid,request),prep.intake('alice',pid,request))
 assert len(calls)==1
 payload=json.dumps(calls,ensure_ascii=False)
 assert 'PRIVATE_FILENAME' not in payload and 'PRIVATE_BODY' not in payload and 'references' not in payload
 assert not svc.context_provider.reads
 assert prep.state('alice',pid)['brief']['scenario']=='每周例会'
async def test_real_fixed_probes_cleanup_and_block_before_handoff(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.intake('alice',pid,{'operationId':op(),'text':'保存并提取会议行动'})
 p=svc.store.get('alice',pid)
 with pytest.raises(StudioError,match='CAPABILITY_CHECK_REQUIRED'):await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 request={'operationId':op()};p=await prep.check('alice',pid,request)
 assert all(r['status']=='passed' for r in p['preparation']['report']['results'].values())
 assert not svc.store.db.execute("select * from records where app like '__probe__%'").fetchall()
 assert not svc.runtime_sessions
 count=len(calls);await prep.check('alice',pid,request);assert len(calls)==count
 p=await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 assert p['preparation']['phase']=='acp' and not p['tasks'] and p['confirmation'] is None
 assert p['preparation']['handoff']['contracts']['model']['methods']==['model.generate']
async def test_configured_model_can_fail_without_false_pass(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.intake('alice',pid,{'operationId':op(),'text':'保存并提取会议行动'})
 async def failed(*args):raise StudioError('MODEL_UPSTREAM_FAILED',502)
 svc.model=failed
 p=await prep.check('alice',pid,{'operationId':op()})
 assert p['preparation']['report']['results']['model']['status']=='failed'
 with pytest.raises(StudioError,match='CAPABILITY_CHECK_REQUIRED'):await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})

async def test_rechecking_unchanged_inputs_preserves_synced_plan_and_confirmation(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.intake('alice',pid,{'operationId':op(),'text':'保存并提取会议行动'})
 p=await prep.check('alice',pid,{'operationId':op()})
 await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 p=svc.store.get('alice',pid);p['solution']=solution();p['solution']['capabilities']=['data','model']
 p['preparation']['interview'].update({'state':'completed','sync':'saved','turns':[{'id':'completed-software-test-turn'}]});rows(p);svc.store.save(p)
 p=svc.confirm('alice',pid,{'operationId':op(),'solutionHash':digest(p['solution']),'reviewedSections':['goal','flow','scope','pages','data','rules','acceptance']})
 frozen=deepcopy(p['confirmation']);old_handoff=p['preparation']['handoff']['id'];old_plan=deepcopy(p['solution'])
 p=await prep.check('alice',pid,{'operationId':op()})
 await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 result=svc.snapshot('alice',pid)
 assert result['preparation']['handoff']['id']!=old_handoff
 assert result['preparation']['interview']['sync']=='saved'
 assert result['preparation']['capabilitiesValid'] and result['readiness']['ready']
 assert result['confirmation']==frozen and result['solution']==old_plan and not result['tasks']

async def test_recheck_with_changed_background_still_requires_plan_sync(env):
 svc,pid,calls=env;prep=svc.preparation
 p=await prep.check('alice',pid,{'operationId':op()})
 await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 p=svc.store.get('alice',pid);p['preparation']['interview'].update({'state':'completed','sync':'saved'});svc.store.save(p)
 await prep.set_context('alice',pid,{'references':[{'kind':'space','id':'file1'}],'expectedRevision':0})
 p=await prep.check('alice',pid,{'operationId':op()})
 await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 result=svc.snapshot('alice',pid)
 assert result['preparation']['interview']['sync']=='pending' and not result['readiness']['ready']
 assert not result['confirmation'] and not result['tasks'] and not svc.context_provider.reads
async def test_selected_metadata_checks_do_not_read_body_and_version_change_blocks(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.set_context('alice',pid,{'references':[{'kind':'space','id':'file1'}],'expectedRevision':0})
 p=await prep.check('alice',pid,{'operationId':op()});assert not svc.context_provider.reads
 assert '正文未读取' in p['preparation']['report']['results']['background.space']['coverage']
 svc.context_provider.revision='2'
 with pytest.raises(StudioError,match='CONTEXT_SOURCE_CHANGED'):await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
async def test_handoff_background_reads_are_scoped_paged_and_revoke_session(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.set_context('alice',pid,{'references':[{'kind':'space','id':'file1'}],'expectedRevision':0})
 p=await prep.check('alice',pid,{'operationId':op()});await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 part=await prep.read_context('alice',pid,'space:file1',limit=20)
 assert len(part['text'])==20 and part['nextOffset']==20 and part['totalCharacters']>20
 assert (await prep.search_context('alice',pid,'资料'))['items']
 with pytest.raises(StudioError,match='CONTEXT_NOT_SELECTED'):await prep.read_context('alice',pid,'space:other')
 with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):await prep.read_context('bob',pid,'space:file1')
 svc.store.db.execute('update projects set body=body where id=?',(pid,))
 await prep.set_context('alice',pid,{'references':[],'expectedRevision':1})
 with pytest.raises(StudioError,match='CONTEXT_NOT_SELECTED'):await prep.read_context('alice',pid,'space:file1')
 assert prep.state('alice',pid)['interview']['sessionId'] is None
async def test_incremental_patch_has_stable_ids_no_count_limit_and_atomic_failure(env):
 svc,pid,calls=env;prep=svc.preparation
 p=svc.store.get('alice',pid);p['solution']=solution();p['solution']['prd']['rules']=['规则'+str(i) for i in range(501)];rows(p);svc.store.save(p)
 p=svc.store.get('alice',pid);before=deepcopy(p);entry=rows(p)['rules'][250]
 candidate=apply_patch(p,{'expectedHash':digest(p['solution']),'upsert':[{'section':'rules','id':entry['id'],'value':'修正中间规则'}],'text':{'problem':'新的痛点'}})
 assert len(candidate['solution']['prd']['rules'])==501
 assert candidate['preparation']['entryIds']==p['preparation']['entryIds']
 assert candidate['solution']['prd']['tests']==p['solution']['prd']['tests']
 assert p==before
 with pytest.raises(StudioError,match='SOLUTION_CHANGED'):apply_patch(p,{'expectedHash':'stale','remove':[{'section':'rules','id':entry['id']}]})
 with pytest.raises(StudioError,match='PRD_PROVENANCE_INVALID'):apply_patch(p,{'expectedHash':digest(p['solution']),'provenance':[{'section':'rules','kind':'confirmed-by-user'}]})
 with pytest.raises(Exception):apply_patch(p,{'expectedHash':digest(p['solution']),'upsert':[{'section':'tests','value':{'title':'不完整'}}]})
 assert svc.store.get('alice',pid)['solution']==before['solution']
async def test_only_fixed_capability_set_can_be_probed_and_new_prd_caps_invalidate(env):
 svc,pid,calls=env;prep=svc.preparation
 with pytest.raises(StudioError,match='CAPABILITY_SET_CHANGED'):await prep.check('alice',pid,{'operationId':op(),'capabilityIds':['http://arbitrary']})
 p=await prep.check('alice',pid,{'operationId':op()});p=await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 p=svc.store.get('alice',pid);p['solution']['capabilities']=['files'];p['preparation']['interview']['sync']='saved';svc.store.save(p)
 with pytest.raises(StudioError,match='CAPABILITY_CHECK_REQUIRED'):prep.guard('alice',p,development=True)
async def test_legacy_project_read_does_not_upgrade_or_change_hash(env):
 svc,pid,calls=env
 legacy=svc.store.create('alice','旧项目','保留原样',op());before=deepcopy(svc.store.get('alice',legacy['id']))
 svc.snapshot('alice',legacy['id']);assert svc.store.get('alice',legacy['id'])==before
async def test_product_manager_tools_cannot_develop_or_forge_authority(env):
 svc,pid,calls=env;prep=svc.preparation
 p=await prep.check('alice',pid,{'operationId':op()});await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 p=svc.store.get('alice',pid);p['preparation']['interview'].update({'state':'running','turnId':'t'});svc.store.save(p)
 for method in ['write_source','validate_app','confirm','export','shell']:
  with pytest.raises(StudioError,match='INTERVIEW_TOOL_DENIED'):await prep.pm.tool('alice',pid,'t',method,{})
 before=svc.store.get('alice',pid)['solution']
 with pytest.raises(StudioError,match='PRD_PATCH_INVALID'):await prep.pm.tool('alice',pid,'t','update_prd',{'expectedHash':digest(before),'confirmation':True})
 assert svc.store.get('alice',pid)['solution']==before
 assert prep.state('alice',pid)['interview']['sync']=='failed'
async def test_failed_intake_keeps_input_and_does_not_retry_implicitly(env):
 svc,pid,calls=env;prep=svc.preparation;seen=[]
 async def fail(*args):seen.append(1);raise StudioError('MODEL_UPSTREAM_FAILED',502)
 svc.model=fail;request={'operationId':op(),'text':'原话不能丢失'}
 with pytest.raises(StudioError):await prep.intake('alice',pid,request)
 await prep.intake('alice',pid,request)
 assert len(seen)==1 and prep.state('alice',pid)['messages'][-1]['text']=='原话不能丢失'
async def test_explicit_retry_reuses_failed_input_without_duplicate_or_implicit_model_calls(env):
 svc,pid,calls=env;prep=svc.preparation;model=svc.model
 async def fail(*args):raise StudioError('INTAKE_RESPONSE_INVALID',502)
 svc.model=fail;first={'operationId':op(),'text':'同一天按创建顺序，编辑不改变顺序'}
 with pytest.raises(StudioError):await prep.intake('alice',pid,first)
 original=deepcopy(prep.state('alice',pid)['messages'][-1]);svc.model=model
 retry={**first,'operationId':op()};await prep.intake('alice',pid,retry)
 messages=prep.state('alice',pid)['messages'];users=[m for m in messages if m['role']=='user']
 assert users==[original] and len(calls)==1
 projection=json.loads(calls[0]['messages'][1]['content'])
 assert len(projection['conversation'])==1
 await prep.intake('alice',pid,first);await prep.intake('alice',pid,retry)
 assert len(calls)==1 and prep.state('alice',pid)['messages']==messages
 with pytest.raises(StudioError,match='OPERATION_CONFLICT'):
  await prep.intake('alice',pid,{**retry,'text':'改成其他规则'})
async def test_edited_retry_and_later_identical_answers_remain_distinct(env):
 svc,pid,calls=env;prep=svc.preparation;model=svc.model
 async def fail(*args):raise StudioError('MODEL_UPSTREAM_FAILED',502)
 svc.model=fail
 with pytest.raises(StudioError):await prep.intake('alice',pid,{'operationId':op(),'text':'原来的回答'})
 svc.model=model
 for text in ['修改后的回答','修改后的回答']:
  await prep.intake('alice',pid,{'operationId':op(),'text':text})
 users=[m['text'] for m in prep.state('alice',pid)['messages'] if m['role']=='user']
 assert users==['原来的回答','修改后的回答','修改后的回答'] and len(calls)==2
async def test_unsupported_scope_can_only_be_explicitly_deferred_by_user(env):
 svc,pid,calls=env;prep=svc.preparation
 p=svc.store.get('alice',pid);p['preparation']['gaps']=['外部平台发布'];svc.store.save(p)
 p=await prep.check('alice',pid,{'operationId':op()})
 with pytest.raises(StudioError,match='CAPABILITY_CHECK_REQUIRED'):await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 prep.defer_gap('alice',pid,{'operationId':op(),'gapId':digest('外部平台发布'),'detail':'本次先做本机草稿，发布以后再做'})
 p=await prep.check('alice',pid,{'operationId':op()});p=await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 assert p['preparation']['handoff']['scopeDecisions'][digest('外部平台发布')]['source']=='user-action'
async def test_background_credentials_never_reach_agent_read_or_search(env):
 svc,pid,calls=env;prep=svc.preparation
 await prep.set_context('alice',pid,{'references':[{'kind':'space','id':'file1'}],'expectedRevision':0})
 p=await prep.check('alice',pid,{'operationId':op()});await prep.handoff('alice',pid,{'expectedRevision':p['preparation']['revision']})
 async def sensitive(*args):return '合成凭据测试 api_key='+('x'*30)
 svc.context_provider.read=sensitive
 for call in [prep.read_context('alice',pid,'space:file1'),prep.search_context('alice',pid,'测试')]:
  with pytest.raises(StudioError,match='CONTEXT_CREDENTIAL_DETECTED'):await call
async def test_client_background_and_suggestion_cannot_create_fake_gap(env):
 svc,pid,calls=env
 async def model(owner,body):return {'choices':[{'message':{'content':json.dumps({'message':'已理解','brief':{'goal':'AI提取摘要'},'capabilities':['model'],'gaps':[{'requirement':'到期提醒','reason':'建议','evidence':'不存在的用户原话'},{'requirement':'AI提取摘要','reason':'模型误判','evidence':'AI提取摘要'}]})}}]}
 svc.model=model;p=await svc.preparation.intake('alice',pid,{'operationId':op(),'text':'AI提取摘要'})
 assert not p['preparation']['gaps']
async def test_pending_interview_cannot_be_deleted_and_restored_stuck(env):
 svc,pid,_=env;p=svc.store.get('alice',pid);p['preparation']['interview']['state']='running';svc.store.save(p)
 with pytest.raises(StudioError,match='INTERVIEW_BUSY'):svc.project_metadata('alice',pid,{'operationId':op(),'action':'delete','name':''})
 assert not svc.store.get('alice',pid).get('deletedAt')
async def test_probe_interrupted_request_never_implicitly_runs_again(env):
 svc,pid,calls=env;prep=svc.preparation;request={'operationId':op()};p=svc.store.get('alice',pid);p['preparation']['probeAttempts']=[{'operationId':request['operationId'],'state':'interrupted'}];svc.store.save(p)
 await prep.check('alice',pid,request);assert not calls
async def test_accidental_credentials_are_not_saved_or_sent_to_intake_model(env):
 svc,pid,calls=env;secret='api_key="'+('x'*30)+'"'
 before=len(svc.preparation.state('alice',pid)['messages'])
 with pytest.raises(StudioError,match='INPUT_CREDENTIAL_DETECTED'):await svc.preparation.intake('alice',pid,{'operationId':op(),'text':secret})
 assert len(svc.preparation.state('alice',pid)['messages'])==before and not calls

async def test_provenance_cannot_promote_assistant_text_into_user_evidence(env):
 svc,pid,_=env;p=svc.store.get('alice',pid)
 p['messages'].append({'id':'assistant-suggestion','role':'assistant','text':'尚未采纳的建议'})
 with pytest.raises(StudioError,match='CONTEXT_NOT_SELECTED'):
  apply_patch(p,{'expectedHash':digest(p['solution']),'provenance':[{'section':'rules','kind':'user','sources':['assistant-suggestion']}]})
 with pytest.raises(StudioError,match='PRD_PROVENANCE_INVALID'):
  apply_patch(p,{'expectedHash':digest(p['solution']),'provenance':[{'section':'rules','kind':'background','sources':[]}]})

async def test_xingtu_metadata_pages_use_only_fixed_document_route():
 from wanx_studio.context_sources import WanxContextSources
 calls=[]
 class Star:
  async def request(self,method,path,query):
   calls.append((method,path,query));return {'items':[{'id':'doc1','title':'资料'}],'has_more':True}
 source=WanxContextSources(None,None,None);source.star=lambda owner:Star()
 page=await source.list('alice','xingtu','offset:200')
 assert page['nextParent']=='offset:201' and page['items'][0]['name']=='资料'
 assert calls==[('GET','/documents',{'limit':'200','offset':'200'})]
 with pytest.raises(StudioError,match='CONTEXT_REFERENCE_INVALID'):await source.list('alice','xingtu','https://arbitrary')
