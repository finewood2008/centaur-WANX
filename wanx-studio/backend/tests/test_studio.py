import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest
from httpx import ASGITransport,AsyncClient

from wanx_studio.contracts import StudioError,digest,readiness
from wanx_studio.service import StudioService
from wanx_studio.runner import Runner
from wanx_studio.local import build_local

ROOT=Path(__file__).resolve().parents[2]

def op():return uuid4().hex

@pytest.fixture
async def svc(tmp_path):
    service=StudioService(tmp_path,ROOT)
    service.runner=Runner(service)
    yield service
    await service.close()

def create(svc,owner='alice'):
    return svc.store.create(owner,'台账','跟进业务事项',op())

async def seeded(svc,owner='alice'):
    p=create(svc,owner)
    return await svc.runner.example(owner,p['id'],op())

def accept(svc,p,owner='alice'):
    return svc.accept(owner,p['id'],{'operationId':op(),'artifactHash':p['artifacts'][-1]['hash'],'criteria':list(range(len(p['solution']['acceptance']))),'confirmedByUser':True})

def mark_installed(svc,p,owner='alice'):
    a=p['artifacts'][-1]
    return svc.installed(owner,p['id'],{'operationId':op(),'artifactHash':a['hash'],'applicationId':p['appId'],'version':a['version']})

async def test_owner_and_runtime_isolation(svc):
    p=await seeded(svc)
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):
        svc.store.get('bob',p['id'])
    runtime=svc.open_runtime('alice',p['id'],p['artifacts'][0]['hash'],'preview')
    with pytest.raises(StudioError,match='RUNTIME_SESSION_EXPIRED'):
        await svc.invoke('bob',runtime['session'],'data.list',{'collection':'items'})
    with pytest.raises(StudioError,match='DATA_INPUT_INVALID'):
        await svc.invoke('alice',runtime['session'],'data.list',{'collection':'items','appId':'other'})

async def test_preview_production_and_cross_app_data(svc):
    p=await seeded(svc)
    accept(svc,p);mark_installed(svc,p)
    preview=svc.open_runtime('alice',p['id'],p['artifacts'][0]['hash'],'preview')['session']
    production=svc.open_runtime('alice',p['id'],p['artifacts'][0]['hash'],'production')['session']
    row=await svc.invoke('alice',preview,'data.put',{'collection':'items','value':{'title':'仅试用'}})
    assert row['_revision']==1
    assert not (await svc.invoke('alice',production,'data.list',{'collection':'items'}))['items']
    other=await seeded(svc)
    other_session=svc.open_runtime('alice',other['id'],other['artifacts'][0]['hash'],'preview')['session']
    assert not (await svc.invoke('alice',other_session,'data.list',{'collection':'items'}))['items']

async def test_records_optimistic_update_and_reload(svc):
    p=await seeded(svc)
    session=svc.open_runtime('alice',p['id'],p['artifacts'][0]['hash'],'preview')['session']
    row=await svc.invoke('alice',session,'data.put',{'collection':'items','value':{'title':'事项'}})
    with pytest.raises(StudioError,match='RECORD_CHANGED'):
        await svc.invoke('alice',session,'data.put',{'collection':'items','id':row['_id'],'value':{'title':'覆盖'}})
    await svc.invoke('alice',session,'data.put',{'collection':'items','id':row['_id'],'expectedRevision':1,'value':{'status':'进行中'}})
    rows=await svc.invoke('alice',session,'data.list',{'collection':'items'})
    assert rows['items'][0]['title']=='事项'
    assert rows['items'][0]['status']=='进行中'
    with pytest.raises(StudioError,match='RECORD_SCHEMA_INVALID'):
        await svc.invoke('alice',session,'data.put',{'collection':'items','value':{'title':12}})

async def test_dependency_cannot_disappear_with_no_open_questions(svc):
    p=create(svc)
    # Preserve the pre-PRD project contract as well as the stricter new flow.
    legacy=svc.store.get('alice',p['id']);legacy['solution'].pop('prd');svc.store.save(legacy)
    body={'operationId':op(),'text':'我还需要公众号自动发布，并且每天自动定时执行'}
    p=await svc.chat('alice',p['id'],body)
    solution={**p['solution'],'audience':'本人','workflow':'生成文案','inputs':'主题','outputs':'文章','acceptance':['生成文章']}
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':solution})
    assert {d['id'] for d in p['solution']['dependencies']}=={'external-publishing','scheduling'}
    with pytest.raises(StudioError,match='SOLUTION_NOT_READY'):
        svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash']})
    for d in p['solution']['dependencies']:
        p=svc.decide('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'dependencyId':d['id'],'choice':'defer','detail':'本次只完成文案，发布和定时以后再做'})
    p=svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash']})
    assert p['confirmation']
    assert '公众号自动发布' in p['messages'][-2]['text']

async def test_model_cannot_forge_authority(svc):
    p=create(svc)
    value={**p['solution'],'dependencyDecisions':{'external-publishing':'approved'}}
    with pytest.raises(Exception):
        svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':value})

async def test_legacy_acceptance_is_strict_but_adopted_export_survives_new_draft(svc):
    p=await seeded(svc)
    with pytest.raises(StudioError,match='USER_ACCEPTANCE_REQUIRED'):
        svc.install_payload('alice',p['id'],p['artifacts'][0]['hash'])
    with pytest.raises(StudioError,match='ACCEPTANCE_INCOMPLETE'):
        svc.accept('alice',p['id'],{'operationId':op(),'artifactHash':p['artifacts'][0]['hash'],'criteria':[0],'confirmedByUser':True})
    accept(svc,p)
    payload=svc.install_payload('alice',p['id'],p['artifacts'][0]['hash'])
    assert 'files' not in payload and 'owner' not in payload and 'messages' not in payload
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':{**p['solution'],'outputs':'新的输出'}})
    assert svc.install_payload('alice',p['id'],p['artifacts'][0]['hash'])['artifactHash']==p['versioning']['adoptedHash']
    assert p['artifacts'] and p['acceptance'] is None

async def test_idempotency_and_conflicting_operation(svc):
    operation=op()
    a=svc.store.create('alice','同一应用','相同目标',operation)
    b=svc.store.create('alice','同一应用','相同目标',operation)
    assert a['id']==b['id']
    with pytest.raises(StudioError,match='OPERATION_CONFLICT'):
        svc.store.create('alice','不同应用','不同目标',operation)
    p=await seeded(svc)
    body={'operationId':op(),'text':'补充：只供本人使用'}
    await svc.chat('alice',p['id'],body)
    await svc.chat('alice',p['id'],body)
    project=svc.store.get('alice',p['id'])
    assert sum(m['text']==body['text'] for m in project['messages'])==1
    assert sum(m.get('operationId')==body['operationId'] for m in project['messages'])==1

async def test_model_failure_is_recorded_without_exposing_provider_error(svc):
    p=create(svc)
    async def model(_owner,_body):raise RuntimeError('must not expose raw provider exception')
    svc.model=model
    with pytest.raises(StudioError,match='MODEL_UPSTREAM_FAILED'):
        await svc.generate('alice',p['id'],{'messages':[]})
    with pytest.raises(StudioError,match='MODEL_UPSTREAM_FAILED'):
        await svc.generate('alice',p['id'],{'messages':[]})
    assert svc.used('alice',p['id'])==2

async def test_legacy_project_limit_does_not_restrict_model_calls(svc):
    async def model(_owner,_body):return {'choices':[{'message':{'content':'ok'}}]}
    svc.model=model
    first=create(svc)
    legacy=svc.store.get('alice',first['id']);legacy['callLimit']=0;svc.store.save(legacy)
    await svc.generate('alice',first['id'],{'messages':[]})
    second=create(svc)
    await svc.generate('alice',second['id'],{'messages':[]})
    assert svc.used('alice',first['id'])==svc.used('alice',second['id'])==1

async def test_usage_history_survives_restart_without_thirty_call_limit(tmp_path):
    async def model(_owner,_body):return {'choices':[{'message':{'content':'ok'}}]}
    first=StudioService(tmp_path,ROOT,model=model)
    p=create(first)
    for _ in range(30):
        await first.generate('alice',p['id'],{'messages':[]})
    await first.close()
    restored=StudioService(tmp_path,ROOT,model=model)
    try:
        await restored.generate('alice',p['id'],{'messages':[]})
        assert restored.used('alice',p['id'])==31
    finally:await restored.close()

async def test_queued_build_still_requires_isolation_without_a_call_limit(svc):
    p=await seeded(svc);svc.model=object()
    async def unavailable(**_kwargs):return {'available':False}
    svc.runner.preflight=unavailable
    result=await svc.runner.start('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'instruction':''})
    task_id=result['tasks'][-1]['id']
    await svc.runner.jobs[task_id]
    task=svc.store.get('alice',p['id'])['tasks'][-1]
    assert task['state']=='failed' and task['error']=='ISOLATION_UNAVAILABLE'
    assert not svc.processes

async def test_selected_files_and_revocation(svc):
    p=await seeded(svc)
    token=svc.open_runtime('alice',p['id'],p['artifacts'][0]['hash'],'preview')['session']
    async def read(owner,ids):return [{'id':ids[0],'name':'合成资料.md','text':'合成内容'}]
    svc.files=read
    with pytest.raises(StudioError,match='FILE_NOT_SELECTED'):
        await svc.invoke('alice',token,'files.read',{'id':'not-selected'})
    await svc.select_files('alice',token,['selected'])
    assert (await svc.invoke('alice',token,'files.read',{'id':'selected'}))['text']=='合成内容'
    del svc.runtime_sessions[token]
    with pytest.raises(StudioError,match='RUNTIME_SESSION_EXPIRED'):
        await svc.invoke('alice',token,'data.list',{'collection':'items'})

async def test_restart_recovers_pending_question_as_interrupted(tmp_path):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    p=create(svc)
    with svc.store.transaction():
        project=svc.store.get('alice',p['id']);project['tasks'].append({'id':'test','state':'waiting','question':{'id':'q','question':'请选择','options':['A','B']}});svc.store.save(project)
    await svc.close()
    restored=StudioService(tmp_path,ROOT)
    try:
        task=restored.store.get('alice',p['id'])['tasks'][0]
        assert task['state']=='interrupted' and task['error']=='SERVICE_RESTARTED'
    finally:await restored.close()

async def test_real_http_auth_origin_and_schema(tmp_path):
    app=build_local(tmp_path)
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as client:
            assert (await client.get('/api/app-studio/projects')).status_code==401
            await client.get('/api/app-studio/session')
            assert (await client.get('/api/app-studio/context')).json()['mode']=='local-preview'
            assert (await client.post('/api/app-studio/projects',json={'operationId':op(),'name':'测试','goal':'目标','owner':'other'})).status_code==422
            assert (await client.get('/api/app-studio/projects',headers={'origin':'https://evil.example'})).status_code==403
            created=(await client.post('/api/app-studio/projects',json={'operationId':op(),'name':'测试','goal':'目标'})).json()
            legacy=app.state.studio.store.get('synthetic-local-user',created['id']);legacy['callLimit']=20
            app.state.studio.store.save(legacy)
            restored=await client.get('/api/app-studio/projects/'+created['id'])
            assert restored.status_code==200
            assert 'callLimit' not in restored.json() and 'callsUsed' not in restored.json()
            assert (await client.post('/api/app-studio/projects/'+created['id']+'/budget',json={'operationId':op(),'limit':200})).status_code==404
    finally:await app.state.studio.close()

async def test_concurrent_duplicate_chat_spends_once(svc):
    p=create(svc)
    calls=[]
    async def model(owner,body):
        calls.append(body)
        await asyncio.sleep(.02)
        return {'choices':[{'message':{'content':json.dumps({'message':'已记录','solution':p['solution']})}}]}
    svc.model=model
    body={'operationId':op(),'text':'只给我本人用'}
    await asyncio.gather(svc.chat('alice',p['id'],body),svc.chat('alice',p['id'],body))
    assert len(calls)==1
    assert svc.used('alice',p['id'])==1

async def test_compatible_upgrade_preserves_production_and_old_writer_fields(svc):
    p=await seeded(svc);accept(svc,p);mark_installed(svc,p)
    old=svc.open_runtime('alice',p['id'],p['artifacts'][0]['hash'],'production')['session']
    row=await svc.invoke('alice',old,'data.put',{'collection':'items','value':{'title':'正式记录'}})
    files=dict(svc.store.get('alice',p['id'])['artifacts'][0]['files'])
    manifest=json.loads(files['miniapp.manifest.json']);manifest['collections']['items']['priority']='string'
    files['miniapp.manifest.json']=json.dumps(manifest)
    def task(project):
        project['tasks'].append({'id':'upgrade','state':'running','solutionHash':digest(project['solution'])})
    svc.store.mutate('alice',p['id'],op(),{},task)
    p=await svc.add_artifact('alice',p['id'],'upgrade',files)
    accept(svc,p);mark_installed(svc,p)
    new=svc.open_runtime('alice',p['id'],p['artifacts'][-1]['hash'],'production')['session']
    updated=await svc.invoke('alice',new,'data.put',{'collection':'items','id':row['_id'],'expectedRevision':1,'value':{'priority':'高'}})
    await svc.invoke('alice',old,'data.put',{'collection':'items','id':row['_id'],'expectedRevision':2,'value':{'title':'旧版继续使用'}})
    restored=await svc.invoke('alice',new,'data.get',{'collection':'items','id':row['_id']})
    assert restored['priority']=='高'
    assert restored['title']=='旧版继续使用'
    files['miniapp.manifest.json']=json.dumps({**manifest,'collections':{'items':{'priority':'string'}}})
    def broken(project):project['tasks'].append({'id':'broken','state':'running','solutionHash':digest(project['solution'])})
    svc.store.mutate('alice',p['id'],op(),{},broken)
    with pytest.raises(StudioError,match='BREAKING_SCHEMA_CHANGE'):
        await svc.add_artifact('alice',p['id'],'broken',files)
    assert svc.store.get('alice',p['id'])['installed']['artifactHash']==p['artifacts'][-1]['hash']

async def test_workbench_lease_stops_abandoned_task(svc):
    svc.runner.leases[('alice','project')]=0
    with pytest.raises(StudioError,match='WORKBENCH_SESSION_EXPIRED'):
        await asyncio.wait_for(svc.runner.guard_lease('alice','project'),3)

async def test_explicitly_excluded_capabilities_are_not_gaps(svc):
    p=create(svc)
    p=await svc.chat('alice',p['id'],{'operationId':op(),'text':'不要引入任何外部发布、连接器或定时任务；无需 PDF 或 Excel。'})
    assert p['solution']['dependencies']==[]

async def test_unknown_gap_survives_ai_answer(svc):
    p=create(svc)
    def add(project):project['solution']['dependencies']=[{'id':'custom-integration','requirement':'业务特殊能力','reason':'待确认实现接口'}]
    svc.store.mutate('alice',p['id'],op(),{},add)
    p=svc.store.get('alice',p['id'])
    svc.revise(p,{**p['solution'],'dependencies':[]},'ai-proposal')
    assert p['solution']['dependencies'][0]['id']=='custom-integration'

async def test_single_service_owns_data_root(tmp_path):
    first=StudioService(tmp_path,ROOT)
    try:
        with pytest.raises(StudioError,match='STUDIO_ALREADY_RUNNING'):
            StudioService(tmp_path,ROOT)
    finally:await first.close()

async def test_duplicate_failed_interview_does_not_retry_model(svc):
    p=create(svc)
    async def failing(owner,body):raise RuntimeError('synthetic failure')
    svc.model=failing
    body={'operationId':op(),'text':'记录本人使用'}
    with pytest.raises(StudioError,match='MODEL_UPSTREAM_FAILED'):
        await svc.chat('alice',p['id'],body)
    await svc.chat('alice',p['id'],body)
    assert svc.used('alice',p['id'])==1


async def test_denied_native_task_lease_does_not_leave_build_queued(svc,monkeypatch):
    p=await seeded(svc);svc.model=object()
    async def denied(*args,**kwargs):
        raise StudioError('STUDIO_TASK_AUTHORIZATION_DENIED',403)
    monkeypatch.setattr('wanx_studio.local_authority.start_background',denied)
    for _ in range(2):
        with pytest.raises(StudioError,match='STUDIO_TASK_AUTHORIZATION_DENIED'):
            await svc.runner.start('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'instruction':''})
    tasks=svc.store.get('alice',p['id'])['tasks'][len(p['tasks']):]
    assert len(tasks)==2 and all(t['state']=='failed' for t in tasks)
    assert not svc.runner.jobs and not svc.background
