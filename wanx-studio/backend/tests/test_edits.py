import asyncio
from copy import deepcopy
import json
import time

import pytest
from test_studio import svc,seeded,op
from wanx_studio.contracts import StudioError,digest
from wanx_studio.edits import ACTIVE,STOPPED
from wanx_studio.versions import verify


async def wait(svc,pid):
    for _ in range(500):
        result=svc.edits.result('alice',pid)
        states=[edit['state'] for edit in result['items']]
        pending=next((state for state in states if state in ACTIVE|STOPPED|{'queued'}),None)
        # Dispatch awaits the upgrade guard after persisting preparing, before
        # registering a job. A stopped head can also leave queued followers.
        if ('alice',pid) not in svc.edits.jobs and not any(state in ACTIVE for state in states) and (pending is None or pending in STOPPED or getattr(svc,'closing',False)):
            return result
        await asyncio.sleep(.01)
    raise AssertionError('edit did not finish')


def body(p,text,**kwargs):
    return {'operationId':op(),'expectedRevision':p['versioning']['revision'],'baseHash':p['artifacts'][-1]['hash'],'text':text,'contextId':'qa',**kwargs}


@pytest.fixture
def pipeline(svc,monkeypatch):
    async def probe(*_):return {'status':'passed'}
    async def preflight(**_):return {'available':True}
    async def analyse(owner,pid,eid):
        r=await svc.edits.tool(owner,pid,eid,'read_project',{})
        await svc.edits.tool(owner,pid,eid,'update_prd',{'expectedHash':r['expectedHash'],'summary':{'outputs':r['solution']['outputs']+' / '+r['request']}})
        await svc.edits.tool(owner,pid,eid,'finish_edit',{'outcome':'ready','summary':r['request']})
    async def execute(owner,p,tid,instruction):
        files=deepcopy(svc.runner.source_files(owner,p,tid));files['src/styles.css']+='\n/* '+instruction+' */\n'
        task=next(t for t in p['tasks'] if t['id']==tid)
        m=json.loads(files['miniapp.manifest.json']);m['collections']=task['change']['contract']['collections'];m['capabilities']=task['change']['contract']['capabilities'];files['miniapp.manifest.json']=json.dumps(m)
        await svc.add_artifact(owner,p['id'],tid,files)
    monkeypatch.setattr(svc.preparation,'probe_runtime',probe)
    monkeypatch.setattr(svc.runner,'preflight',preflight)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    monkeypatch.setattr(svc.runner,'execute',execute)
    return analyse,execute


async def test_first_successful_unadopted_version_direct_edit_ignores_old_interview_failure(svc,pipeline,monkeypatch):
    p=await seeded(svc);old=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]);svc.preparation.enable('alice',p['id'])
    def stale(q):q['preparation'].update({'phase':'acp'});q['preparation']['interview'].update({'state':'failed','sync':'failed','error':'INTERVIEW_CODEX_FAILED'})
    svc.store.mutate('alice',p['id'],op(),{},stale)
    original=deepcopy(svc.store.get('alice',p['id'])['solution'])
    entered=asyncio.Event();release=asyncio.Event();analyse=pipeline[0]
    async def preparing(*args):
        await analyse(*args);entered.set();await release.wait()
    monkeypatch.setattr(svc.edits,'analyse',preparing)
    request=body(p,'网站名称改为半人马AI');await svc.edits.submit('alice',p['id'],request);await entered.wait()
    assert svc.store.get('alice',p['id'])['solution']==original
    release.set();r=await wait(svc,p['id']);assert r['items'][-1]['state']=='completed',r['items'][-1]
    q=svc.store.get('alice',p['id']);assert len(q['artifacts'])==2 and q['artifacts'][0]==old
    assert q['versioning']['adoptedHash'] is None and q['tasks'][-1]['change']['confirmationMode']=='direct-edit'
    verify(q['artifacts'][-1]);assert '_edits' not in r['project']
    again=await svc.edits.submit('alice',p['id'],request);assert len(again['items'])==1


async def test_two_messages_during_build_are_serial_and_use_preceding_result(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();execute=pipeline[1]
    async def delayed(*args):
        if not entered.is_set():entered.set();await release.wait()
        await execute(*args)
    monkeypatch.setattr(svc.runner,'execute',delayed)
    await svc.edits.submit('alice',p['id'],body(p,'第一处修改'));await entered.wait()
    p=svc.edits.result('alice',p['id'])['project']
    await svc.edits.submit('alice',p['id'],body(p,'第二处修改'))
    p=svc.edits.result('alice',p['id'])['project'];await svc.edits.submit('alice',p['id'],body(p,'第三处修改'))
    release.set();r=await wait(svc,p['id']);assert [e['state'] for e in r['items']]==['completed']*3
    q=svc.store.get('alice',p['id']);assert len(q['artifacts'])==4
    assert [a['baseHash'] for a in q['artifacts'][1:]]==[a['hash'] for a in q['artifacts'][:-1]]
    assert all(text in q['artifacts'][-1]['files']['src/styles.css'] for text in ['第一处修改','第二处修改','第三处修改'])


async def test_compatible_new_data_field_is_prepared_without_user_contract_confirmation(svc,pipeline,monkeypatch):
    p=await seeded(svc);old=svc.store.get('alice',p['id'])['artifacts'][0]['manifest']
    async def analyse(owner,pid,eid):
        r=await svc.edits.tool(owner,pid,eid,'read_project',{})
        patch=await svc.edits.tool(owner,pid,eid,'update_prd',{'expectedHash':r['expectedHash'],'upsert':[{'section':'dataFields','value':{'name':'主题颜色','type':'text'}}]})
        collections=deepcopy(old['collections']);collections['settings']={'primaryColor':'string'}
        await svc.edits.tool(owner,pid,eid,'propose_contract',{'expectedHash':patch['expectedHash'],'collections':collections})
        await svc.edits.tool(owner,pid,eid,'finish_edit',{'outcome':'ready','summary':'支持修改主体颜色'})
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('alice',p['id'],body(p,'支持修改主体颜色'));r=await wait(svc,p['id'])
    assert r['items'][-1]['state']=='completed',r['items'][-1]
    q=svc.store.get('alice',p['id']);assert q['artifacts'][-1]['manifest']['collections']['settings']=={'primaryColor':'string'}
    assert q['artifacts'][-1]['manifest']['collections']['items']==old['collections']['items']


async def test_question_and_discussion_stay_in_same_edit_without_initial_prd_flow(svc,pipeline,monkeypatch):
    p=await seeded(svc);normal=pipeline[0]
    async def analyse(owner,pid,eid):
        _,e=svc.edits.get(owner,pid,eid)
        if not e['answers']:
            await svc.edits.tool(owner,pid,eid,'ask_product',{'text':'本轮是否只增加手动清理入口？','why':'保留现有历史数据','options':['增加手动入口','先保留现状']});return
        await normal(owner,pid,eid)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('alice',p['id'],body(p,'增加清理入口'));r=await wait(svc,p['id']);e=r['items'][0]
    assert e['state']=='clarifying' and len(r['project']['artifacts'])==1
    answer={'operationId':op(),'text':'增加手动入口','questionHash':e['questionHash'],'contextId':'qa'}
    await svc.edits.answer('alice',p['id'],e['id'],answer);r=await wait(svc,p['id']);assert r['items'][0]['state']=='completed'
    assert len(r['items'])==1 and len(r['project']['artifacts'])==2


async def test_migration_keeps_unbuilt_requests_and_original_operation_ids(svc,pipeline):
    p=await seeded(svc);svc.preparation.enable('alice',p['id']);operation=op()
    def unfinished(q):
        q['preparation']['phase']='acp';q['preparation']['interview'].update({'state':'failed','sync':'failed'})
        q['preparation']['interview']['turns']=[{'id':op(),'operationId':operation,'text':'旧的名称修改','state':'completed','at':time.time()}]
        q['messages'].append({'id':op(),'role':'user','text':'旧的名称修改','operationId':operation})
    svc.store.mutate('alice',p['id'],op(),{},unfinished)
    await svc.edits.read('alice',p['id'],'qa');r=await wait(svc,p['id']);assert len(r['items'])==1
    assert r['items'][0]['sourceOperations']==[operation] and r['items'][0]['state']=='completed',r['items'][0]
    again=await svc.edits.read('alice',p['id'],'qa');assert len(again['items'])==1


async def test_scope_stop_and_revocation_reject_late_artifact_without_touching_old_version(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();execute=pipeline[1]
    async def delayed(*args):entered.set();await release.wait();await execute(*args)
    monkeypatch.setattr(svc.runner,'execute',delayed)
    await svc.edits.submit('alice',p['id'],body(p,'改字号'));await entered.wait()
    r=svc.edits.result('alice',p['id']);eid=r['items'][0]['id']
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):await svc.edits.read('bob',p['id'])
    await svc.edits.stop('alice',p['id'],eid,'other-context');assert svc.edits.get('alice',p['id'],eid)[1]['state']=='building'
    await svc.edits.stop('alice',p['id'],eid,'qa');release.set();r=await wait(svc,p['id'])
    assert len(r['project']['artifacts'])==1 and r['items'][0]['state']=='cancelled'

async def test_failed_edit_retries_once_and_restoration_keeps_records(svc,pipeline,monkeypatch):
    p=await seeded(svc);h=p['artifacts'][0]['hash'];session=svc.open_runtime('alice',p['id'],h,'preview')['session']
    row=await svc.invoke('alice',session,'data.put',{'collection':'items','value':{'title':'保留学员记录'}})
    execute=pipeline[1];attempts=0
    async def flaky(*args):
        nonlocal attempts
        attempts+=1
        if attempts==1:raise StudioError('ISOLATION_UNAVAILABLE',409)
        await execute(*args)
    monkeypatch.setattr(svc.runner,'execute',flaky)
    request=body(p,'修改标题');await svc.edits.submit('alice',p['id'],request);r=await wait(svc,p['id']);e=r['items'][0]
    assert e['state']=='failed' and len(r['project']['artifacts'])==1
    assert svc.store.get('alice',p['id'])['_edits']['items'][0]['draft']
    await svc.edits.retry('alice',p['id'],e['id'],{'contextId':'qa'});r=await wait(svc,p['id']);assert r['items'][0]['state']=='completed'
    await svc.edits.submit('alice',p['id'],request);assert attempts==2
    check=svc.versions.restore_check('alice',p['id'],h)
    restored=svc.versions.restore('alice',p['id'],{'operationId':op(),'artifactHash':h,'expectedRevision':check['expectedRevision'],'checkHash':check['checkHash'],'confirmedByUser':True},trial=True)
    assert restored['versioning']['adoptedHash'] is None
    new=svc.open_runtime('alice',p['id'],restored['artifacts'][-1]['hash'],'preview')['session']
    assert (await svc.invoke('alice',new,'data.list',{'collection':'items'}))['items'][0]['_id']==row['_id']


async def test_failed_head_stops_queued_followers_until_explicit_retry(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();execute=pipeline[1];attempts=0
    async def fail_first(*args):
        nonlocal attempts
        attempts+=1
        if attempts==1:
            entered.set();await release.wait();raise StudioError('ISOLATION_UNAVAILABLE',409)
        await execute(*args)
    monkeypatch.setattr(svc.runner,'execute',fail_first)
    await svc.edits.submit('alice',p['id'],body(p,'先改标题'));await entered.wait()
    current=svc.edits.result('alice',p['id'])['project']
    await svc.edits.submit('alice',p['id'],body(current,'再改颜色'))
    release.set();result=await wait(svc,p['id'])
    assert [edit['state'] for edit in result['items']]==['failed','queued']
    assert attempts==1 and len(result['project']['artifacts'])==1
    await svc.edits.retry('alice',p['id'],result['items'][0]['id'],{'contextId':'qa'})
    result=await wait(svc,p['id'])
    assert [edit['state'] for edit in result['items']]==['completed','completed']
    assert attempts==3 and len(result['project']['artifacts'])==3


async def test_restart_recovers_draft_without_automatically_repeating_build(svc,pipeline):
    from wanx_studio.store import Store
    p=await seeded(svc);await svc.edits.activate('alice',p['id'])
    eid=op()
    def saved(q):
        e=svc.edits.new_edit(op(),'重启前修改',q['artifacts'][-1]['hash'],None,'qa',False)
        e.update({'id':eid,'state':'preparing','baseHash':q['artifacts'][-1]['hash']});draft=svc.edits.project(q,e);e['draft']=svc.edits.draft(draft)
        from wanx_studio.iterative import data_intent
        e['iterative']={'contractDraft':{'dataIntent':data_intent(draft),'contract':{'collections':q['artifacts'][-1]['manifest']['collections'],'capabilities':draft['solution']['capabilities'],'visibility':'application-access'}}}
        q['_edits']['items'].append(e)
    svc.store.mutate('alice',p['id'],op(),{},saved)
    reopened=Store(svc.store.root)
    try:
        q=reopened.get('alice',p['id']);assert q['_edits']['items'][0]['state']=='interrupted'
        assert q['_edits']['items'][0]['draft'] and len(q['artifacts'])==1
    finally:reopened.close()
    await svc.edits.read('alice',p['id'],'qa');assert not svc.edits.jobs
    await svc.edits.retry('alice',p['id'],eid,{'contextId':'qa'});r=await wait(svc,p['id']);assert r['items'][0]['state']=='completed'


async def test_discussion_does_not_build_or_block_later_clear_change(svc,pipeline,monkeypatch):
    p=await seeded(svc);normal=pipeline[0]
    async def analyse(owner,pid,eid):
        _,e=svc.edits.get(owner,pid,eid)
        if e['text'].startswith('先讨论'):
            await svc.edits.tool(owner,pid,eid,'finish_edit',{'outcome':'discussed','summary':'建议先保持现有布局'});return
        await normal(owner,pid,eid)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('alice',p['id'],body(p,'先讨论主页'));r=await wait(svc,p['id'])
    assert r['items'][0]['state']=='discussed' and len(r['project']['artifacts'])==1
    await svc.edits.submit('alice',p['id'],body(r['project'],'标题改为半人马AI'));r=await wait(svc,p['id']);assert len(r['project']['artifacts'])==2


async def test_older_version_requires_explicit_base_and_new_group(svc,pipeline):
    p=await seeded(svc);h=p['artifacts'][0]['hash']
    await svc.edits.submit('alice',p['id'],body(p,'最新版本调整'));r=await wait(svc,p['id'])
    with pytest.raises(StudioError,match='EDIT_BASE_CHANGED'):
        await svc.edits.submit('alice',p['id'],body(r['project'],'从旧版改',baseHash=h))
    await svc.edits.submit('alice',p['id'],body(r['project'],'基于旧版改',baseHash=h,explicitBase=True));r=await wait(svc,p['id'])
    q=svc.store.get('alice',p['id']);assert q['artifacts'][-1]['baseHash']==h
    assert q['artifacts'][-1]['iterationId']!=q['artifacts'][-2]['iterationId']
    assert '最新版本调整' not in q['artifacts'][-1]['files']['src/styles.css']


async def test_private_planning_blocks_conflicting_manual_prd_and_restore(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();normal=pipeline[0]
    async def analyse(*args):entered.set();await release.wait();await normal(*args)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('alice',p['id'],body(p,'改标题'));await entered.wait()
    with pytest.raises(StudioError,match='BUILD_ACTIVE'):
        svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':p['solution']})
    with pytest.raises(StudioError,match='BUILD_ACTIVE'):
        await svc.runner.start('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'instruction':'过时客户端构建'})
    with pytest.raises(StudioError,match='BUILD_ACTIVE'):svc.versions.restore_check('alice',p['id'],p['artifacts'][0]['hash'])
    release.set();await wait(svc,p['id'])


async def test_revoked_admin_cannot_commit_late_compiler_result(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();execute=pipeline[1];allowed=True
    def management(_):
        if not allowed:raise StudioError('STUDIO_ADMIN_REQUIRED',403)
    async def delayed(*args):entered.set();await release.wait();await execute(*args)
    monkeypatch.setattr(svc,'authorize_management',management);monkeypatch.setattr(svc.runner,'execute',delayed)
    await svc.edits.submit('alice',p['id'],body(p,'改颜色'));await entered.wait();allowed=False;release.set()
    for _ in range(300):
        if not svc.edits.jobs:break
        await asyncio.sleep(.01)
    assert len(svc.store.get('alice',p['id'])['artifacts'])==1


async def test_incompatible_contract_creates_one_choice_instead_of_first_interview(svc,pipeline,monkeypatch):
    p=await seeded(svc)
    async def analyse(owner,pid,eid):
        r=await svc.edits.tool(owner,pid,eid,'read_project',{})
        result=await svc.edits.tool(owner,pid,eid,'propose_contract',{'expectedHash':r['expectedHash'],'collections':{'items':{'title':'number'}}})
        assert result['requiresUserDecision']
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('alice',p['id'],body(p,'改变已有字段类型'));r=await wait(svc,p['id']);assert r['items'][0]['state']=='clarifying' and len(r['project']['artifacts'])==1

async def test_private_api_requires_identity_and_keeps_public_project_shape(tmp_path):
    from wanx_studio.local import build_local
    from httpx import ASGITransport,AsyncClient
    app=build_local(tmp_path)
    async with app.router.lifespan_context(app):
        service=app.state.studio
        p=await seeded(service,'synthetic-local-user');path='/api/app-studio/_builder/projects/'+p['id']+'/edits'
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as c:
            assert (await c.get(path)).status_code==401
            await c.get('/api/app-studio/session')
            before=(await c.get('/api/app-studio/projects/'+p['id'])).json()
            r=await c.post(path,json={'operationId':op(),'text':'测试'})
            assert r.status_code==422
            service.closing=True
            r=await c.get(path);assert r.status_code==200 and r.json()['enabled']
            after=(await c.get('/api/app-studio/projects/'+p['id'])).json()
            assert set(after)==set(before) and '_edits' not in after
            service.closing=False

async def test_queued_screenshot_never_silently_rebases_after_preceding_edit(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();execute=pipeline[1]
    async def delayed(*args):entered.set();await release.wait();await execute(*args)
    monkeypatch.setattr(svc.runner,'execute',delayed)
    await svc.edits.submit('alice',p['id'],body(p,'先修改标题'));await entered.wait()
    now=svc.edits.result('alice',p['id'])['project'];review={'baseHash':p['artifacts'][-1]['hash'],'image':'unit-test-image','regions':[{'x':0,'y':0,'width':.2,'height':.1}]}
    await svc.edits.submit('alice',p['id'],body(now,'圈选位置修改',visualReview=review));release.set();r=await wait(svc,p['id'])
    assert [e['state'] for e in r['items']]==['completed','failed']
    assert r['items'][1]['error']=='VISUAL_REVIEW_STALE' and len(r['project']['artifacts'])==2
    original=r['items'][1];now=r['project'];fresh={**review,'baseHash':now['artifacts'][-1]['hash'],'expectedRevision':now['versioning']['revision']}
    with pytest.raises(StudioError,match='VISUAL_REVIEW_STALE'):
        await svc.edits.retry('alice',p['id'],original['id'],{'operationId':op(),'contextId':'qa','visualReview':{**fresh,'baseHash':review['baseHash']}})
    await svc.edits.submit('alice',p['id'],body(now,'后续文字要求'))
    retry={'operationId':op(),'contextId':'qa','visualReview':fresh}
    await svc.edits.retry('alice',p['id'],original['id'],retry);r=await wait(svc,p['id'])
    assert [e['state'] for e in r['items']]==['completed']*3
    assert r['items'][1]['id']==original['id'] and r['items'][1]['operationId']==original['operationId']
    assert r['items'][1]['baseHash']==fresh['baseHash']
    q=svc.store.get('alice',p['id']);assert q['_edits']['items'][1]['visualHistory']==[review]
    count=len(q['artifacts']);await svc.edits.retry('alice',p['id'],original['id'],retry)
    assert len(svc.store.get('alice',p['id'])['artifacts'])==count


async def test_migration_keeps_each_original_request_as_a_separate_ordered_edit(svc,pipeline):
    p=await seeded(svc);svc.preparation.enable('alice',p['id']);operations=[op(),op()]
    def pending(q):
        q['preparation']['interview']['turns']=[{'id':op(),'operationId':o,'text':text,'state':'completed','at':time.time()+i} for i,(o,text) in enumerate(zip(operations,['先改标题','再加颜色']))]
    svc.store.mutate('alice',p['id'],op(),{},pending);await svc.edits.read('alice',p['id'],'qa');r=await wait(svc,p['id'])
    assert [e['operationId'] for e in r['items']]==operations and [e['state'] for e in r['items']]==['completed','completed']
    assert r['project']['artifacts'][-1]['baseHash']==r['project']['artifacts'][-2]['hash']

async def test_migrated_followers_keep_the_host_context_and_context_stop_cancels_them(svc,pipeline,monkeypatch):
    p=await seeded(svc);svc.preparation.enable('alice',p['id']);entered=asyncio.Event();release=asyncio.Event();normal=pipeline[0]
    def pending(q):
        q['preparation']['interview']['turns']=[{'id':op(),'operationId':op(),'text':text,'state':'completed','at':time.time()+i} for i,text in enumerate(['第一处','第二处'])]
    svc.store.mutate('alice',p['id'],op(),{},pending)
    async def analyse(owner,pid,eid):
        if len(svc.store.get(owner,pid)['artifacts'])==2:entered.set();await release.wait()
        await normal(owner,pid,eid)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.read('alice',p['id'],'host-a');await entered.wait();r=svc.edits.result('alice',p['id'])
    assert r['items'][1]['contextId']=='host-a'
    await svc.edits.stop_context('alice',p['id'],'host-a');release.set();assert svc.edits.result('alice',p['id'])['items'][1]['state']=='cancelled'

async def test_restart_after_artifact_commit_marks_edit_done_without_rebuilding(svc,pipeline):
    from wanx_studio.store import Store
    p=await seeded(svc);await svc.edits.submit('alice',p['id'],body(p,'改标题'));r=await wait(svc,p['id']);eid=r['items'][0]['id']
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['_edits']['items'][0].update({'state':'validating'}))
    reopened=Store(svc.store.root)
    try:
        q=reopened.get('alice',p['id']);assert q['_edits']['items'][0]['state']=='completed' and q['stage']=='preview'
    finally:reopened.close()
    await svc.edits.retry('alice',p['id'],eid,{'contextId':'qa','operationId':op()})
    assert len(svc.store.get('alice',p['id'])['artifacts'])==2 and not svc.edits.jobs

async def test_scoped_heartbeat_cannot_renew_a_different_host_lease(svc,pipeline,monkeypatch):
    p=await seeded(svc);entered=asyncio.Event();release=asyncio.Event();normal=pipeline[0]
    async def analyse(*args):entered.set();await release.wait();await normal(*args)
    monkeypatch.setattr(svc.edits,'analyse',analyse)
    await svc.edits.submit('alice',p['id'],body(p,'调整标题'));await entered.wait()
    svc.runner.leases[('alice',p['id'])]=1
    assert svc.edits.heartbeat('alice',p['id'],'foreign')=={'active':False}
    assert svc.runner.leases[('alice',p['id'])]==1
    assert svc.edits.heartbeat('alice',p['id'],'qa')=={'active':True}
    assert svc.runner.leases[('alice',p['id'])]>1
    release.set();await wait(svc,p['id'])
