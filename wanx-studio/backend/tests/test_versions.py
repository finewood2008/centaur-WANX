import json
from copy import deepcopy
from pathlib import Path
import pytest
from wanx_studio.contracts import StudioError,digest
from wanx_studio.versions import state,shadow
from test_studio import svc,seeded,op,accept


def adopt(svc,p):
    return svc.versions.adopt('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':p['artifacts'][-1]['hash'],'confirmedByUser':True})

async def candidate(svc,p,files=None):
    task_id=op()
    def change(q):
        it=svc.versions.task(q,'只调整界面')
        q['tasks'].append({'id':task_id,'state':'running','solutionHash':digest(q['solution']),'baseHash':it['baseHash'],'iterationId':it['id'],'instruction':'只调整界面','events':[],'question':None})
    svc.store.mutate('alice',p['id'],op(),{},change)
    previous=svc.store.get('alice',p['id'])['artifacts'][-1]
    return await svc.add_artifact('alice',p['id'],task_id,files or deepcopy(previous['files']))

async def test_compiled_launch_archive_receives_private_files_not_public_summary(svc):
    from wanx_studio.client_launch import ClientLaunch
    p=await seeded(svc)
    source=svc.store.get('alice',p['id'])['artifacts'][-1]['files']
    seen=[]
    class Context:
        async def launch_archive(self,owner,pid,storage,artifact):
            assert artifact['files']==source
            seen.append(artifact['hash'])
            return {'state':'saved','id':'archive-fixture'}
    svc.context_provider=Context()
    svc.client_launch=ClientLaunch(svc)
    def configure(q):
        from wanx_studio.preparation import initial
        q['preparation']={**initial(q),'handoff':{},'launchConfiguration':{'storage':{'folderId':'folder-fixture'}}}
    svc.store.mutate('alice',p['id'],op(),{},configure)
    # Exercise compilation and public snapshot redaction, not just archive() in isolation.
    p=await candidate(svc,p)
    artifact=svc.store.get('alice',p['id'])['artifacts'][-1]
    assert seen==[artifact['hash']]
    assert svc.store.get('alice',p['id'])['preparation']['storageReceipts'][artifact['hash']]['state']=='saved'
    assert 'files' not in p['artifacts'][-1]

def begin(svc,p,h=None):
    return svc.versions.iteration('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'action':'begin','baseHash':h,'goal':'调整布局'})

async def test_adopted_version_survives_draft_and_failed_improvement(svc):
    p=adopt(svc,await seeded(svc));h=p['versioning']['adoptedHash'];frozen=svc.versions.read('alice',p['id'],h)['snapshot']
    p=begin(svc,p)
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':{**p['solution'],'outputs':'新的输出'}})
    assert svc.install_payload('alice',p['id'],h)['artifactHash']==h
    assert svc.versions.read('alice',p['id'],h)['snapshot']==frozen
    assert p['versioning']['adoptedHash']==h
    # Failed work and abandonment retain frozen version and new draft.
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['tasks'].append({'id':'failed','state':'failed','solutionHash':digest(q['solution'])}))
    p=svc.versions.iteration('alice',p['id'],{'operationId':op(),'expectedRevision':p['versioning']['revision'],'action':'abandon'})
    assert p['versioning']['iteration'] is None and p['solution']['outputs']=='新的输出'
    assert svc.install_payload('alice',p['id'],h)['artifactHash']==h

async def test_explicit_historical_baseline_and_retry_do_not_use_latest_unrelated_source(svc):
    p=adopt(svc,await seeded(svc));old=p['artifacts'][0]['hash'];p=begin(svc,p)
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]['files']);files['src/app.js']+='\n// second version\n'
    p=adopt(svc,await candidate(svc,p,files));p=begin(svc,p,old)
    # Actual Runner reads the selected old files, not last artifact.
    task_id=op()
    def task(q):
        it=svc.versions.task(q,'new line');q['tasks'].append({'id':task_id,'state':'queued','baseHash':it['baseHash'],'iterationId':it['id'],'solutionHash':digest(q['solution'])})
    svc.store.mutate('alice',p['id'],op(),{},task);q=svc.store.get('alice',p['id'])
    assert '// second version' not in svc.runner.source_files('alice',q,task_id)['src/app.js']
    assert q['tasks'][-1]['baseHash']==old

async def test_restore_is_new_version_and_preserves_data_and_unknown_fields(svc):
    p=adopt(svc,await seeded(svc));old=p['artifacts'][0]['hash'];p=begin(svc,p)
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]['files']);m=json.loads(files['miniapp.manifest.json']);m['collections']['items']['priority']='string';files['miniapp.manifest.json']=json.dumps(m)
    p=adopt(svc,await candidate(svc,p,files));new=p['artifacts'][-1]['hash']
    token=svc.open_runtime('alice',p['id'],new,'preview')['session']
    row=await svc.invoke('alice',token,'data.put',{'collection':'items','value':{'title':'当前数据','priority':'高'}})
    check=svc.versions.restore_check('alice',p['id'],old)
    body={'operationId':op(),'expectedRevision':check['expectedRevision'],'checkHash':check['checkHash'],'artifactHash':old,'confirmedByUser':True}
    p=svc.versions.restore('alice',p['id'],body);again=svc.versions.restore('alice',p['id'],body)
    assert len(p['artifacts'])==len(again['artifacts'])==3
    a=p['artifacts'][-1];assert a['restoredFrom']==old and a['version']=='0.1.2' and p['versioning']['adoptedHash']==a['hash']
    assert new in [a['hash'] for a in p['artifacts']]
    restored=svc.open_runtime('alice',p['id'],a['hash'],'preview')['session']
    await svc.invoke('alice',restored,'data.put',{'collection':'items','id':row['_id'],'expectedRevision':1,'value':{'title':'旧版修改'}})
    latest=await svc.invoke('alice',token,'data.get',{'collection':'items','id':row['_id']})
    assert latest['priority']=='高' and latest['title']=='旧版修改'
    assert svc.install_payload('alice',p['id'],a['hash'])['version']=='0.1.2'

async def test_restore_and_adopt_checks_fence_stale_permission_integrity_and_busy(svc,monkeypatch):
    p=adopt(svc,await seeded(svc));old=p['artifacts'][0]['hash'];p=begin(svc,p)
    with pytest.raises(StudioError,match='ITERATION_ACTIVE'):svc.versions.restore_check('alice',p['id'],old)
    p=adopt(svc,await candidate(svc,p));check=svc.versions.restore_check('alice',p['id'],old)
    svc.versions.feedback('alice',p['id'],{'operationId':op(),'expectedRevision':check['expectedRevision'],'text':'新的意见'})
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.restore('alice',p['id'],{'operationId':op(),'expectedRevision':check['expectedRevision'],'checkHash':check['checkHash'],'artifactHash':old,'confirmedByUser':True})
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):svc.versions.read('bob',p['id'],old)
    def revoked(*_a,**_k):raise StudioError('CAPABILITY_CHECK_REQUIRED',409)
    monkeypatch.setattr(svc.preparation,'guard',revoked)
    with pytest.raises(StudioError,match='CAPABILITY_CHECK_REQUIRED'):svc.versions.restore_check('alice',p['id'],old)
    monkeypatch.undo()
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['artifacts'][0]['files'].update({'src/app.js':'tampered'}))
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):svc.versions.restore_check('alice',p['id'],old)

async def test_unadopted_and_incomplete_versions_cannot_restore_or_export(svc):
    p=await seeded(svc);h=p['artifacts'][0]['hash']
    with pytest.raises(StudioError,match='USER_ACCEPTANCE_REQUIRED'):svc.install_payload('alice',p['id'],h)
    with pytest.raises(StudioError,match='VERSION_NOT_ADOPTED'):svc.versions.restore_check('alice',p['id'],h)
    def incomplete(q):
        q['artifacts'][0].pop('snapshot');q['revisions']=[];q['solution']['outputs']='different'
    svc.store.mutate('alice',p['id'],op(),{},incomplete)
    assert not svc.versions.read('alice',p['id'],h)['snapshotAvailable']
    with pytest.raises(StudioError,match='VERSION_SNAPSHOT_INCOMPLETE'):begin(svc,p,h)

async def test_saved_feedback_is_model_free_and_idempotent(svc):
    p=await seeded(svc);body={'operationId':op(),'expectedRevision':p['versioning']['revision'],'text':'希望更清楚'}
    a=svc.versions.feedback('alice',p['id'],body);b=svc.versions.feedback('alice',p['id'],body)
    assert a['versioning']==b['versioning'] and svc.used('alice',p['id'])==0
    body['text']='changed'
    with pytest.raises(StudioError,match='OPERATION_CONFLICT'):svc.versions.feedback('alice',p['id'],body)

async def test_choose_earlier_candidate_from_same_iteration_without_replacing_data(svc):
    p=begin(svc,await seeded(svc));p=await candidate(svc,p);first=p['artifacts'][-1]
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][-1]['files']);files['src/app.js']+='\n// alternative layout\n'
    p=await candidate(svc,p,files);newest=p['artifacts'][-1]['hash']
    token=svc.open_runtime('alice',p['id'],newest,'preview')['session']
    row=await svc.invoke('alice',token,'data.put',{'collection':'items','value':{'title':'保留业务数据'}})
    body={'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':first['hash'],'confirmedByUser':True}
    selected=svc.versions.adopt('alice',p['id'],body);again=svc.versions.adopt('alice',p['id'],body)
    assert selected['versioning']==again['versioning']
    assert selected['versioning']['adoptedHash']==first['hash']
    assert newest in [a['hash'] for a in selected['artifacts']]
    assert (await svc.invoke('alice',token,'data.get',{'collection':'items','id':row['_id']}))['title']=='保留业务数据'
    assert svc.install_payload('alice',p['id'],first['hash'])['artifactHash']==first['hash']

async def test_earlier_candidate_still_requires_current_plan_and_completed_task(svc):
    p=begin(svc,await seeded(svc));p=await candidate(svc,p);first=p['artifacts'][-1];p=await candidate(svc,p)
    body={'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':first['hash'],'confirmedByUser':True}
    def incomplete(q):next(t for t in q['tasks'] if t['id']==first['taskId'])['state']='failed'
    svc.store.mutate('alice',p['id'],op(),{},incomplete)
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.adopt('alice',p['id'],body)
    def completed(q):next(t for t in q['tasks'] if t['id']==first['taskId'])['state']='completed'
    svc.store.mutate('alice',p['id'],op(),{},completed)
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':{**p['solution'],'outputs':'新的范围'}})
    with pytest.raises(StudioError,match='VERSION_CHANGED'):svc.versions.adopt('alice',p['id'],{**body,'operationId':op()})

async def test_legacy_acceptance_maps_on_read_without_rewriting_project(svc):
    p=await seeded(svc);accept(svc,p)
    def legacy(q):q.pop('versioning')
    svc.store.mutate('alice',p['id'],op(),{},legacy)
    before=svc.store.db.execute('select body from projects where id=?',(p['id'],)).fetchone()[0]
    q=svc.snapshot('alice',p['id']);assert q['versioning']['adoptedHash']==p['artifacts'][0]['hash']
    after=svc.store.db.execute('select body from projects where id=?',(p['id'],)).fetchone()[0]
    assert before==after

async def test_changed_field_types_block_adoption_without_losing_current_version(svc):
    p=adopt(svc,await seeded(svc));old=p['versioning']['adoptedHash'];p=begin(svc,p)
    files=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]['files']);m=json.loads(files['miniapp.manifest.json']);m['collections']['items']['title']='number';files['miniapp.manifest.json']=json.dumps(m)
    p=await candidate(svc,p,files)
    with pytest.raises(StudioError,match='VERSION_DATA_INCOMPATIBLE'):adopt(svc,p)
    assert svc.store.get('alice',p['id'])['versioning']['adoptedHash']==old

async def test_real_fixed_http_version_routes_validate_identity_user_action_and_shape(tmp_path):
    from httpx import ASGITransport,AsyncClient
    from wanx_studio.local import build_local
    app=build_local(tmp_path)
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as c:
            assert (await c.get('/api/app-studio/projects')).status_code==401
            await c.get('/api/app-studio/session')
            p=(await c.post('/api/app-studio/projects',json={'operationId':op(),'name':'软件测试','goal':'合成版本验证'})).json();pid=p['id']
            p=(await c.post(f'/api/app-studio/projects/{pid}/example',json={'operationId':op()})).json()
            payload={'operationId':op(),'expectedRevision':p['versioning']['revision'],'artifactHash':p['artifacts'][0]['hash'],'confirmedByUser':False}
            assert (await c.post(f'/api/app-studio/projects/{pid}/adopt',json=payload)).status_code==422
            payload['confirmedByUser']=True
            a=await c.post(f'/api/app-studio/projects/{pid}/adopt',json={**payload,'owner':'someone'})
            assert a.status_code==422
            a=await c.post(f'/api/app-studio/projects/{pid}/adopt',json=payload);assert a.status_code==200
            assert a.json()['versioning']['adoptedHash']==payload['artifactHash']
            assert (await c.get(f'/api/app-studio/projects/{pid}/versions')).json()['versions'][0]['status']=='current'
            assert (await c.get(f'/api/app-studio/projects/{pid}/versions/{payload["artifactHash"]}')).json()['snapshot']['solution']==p['solution']
            assert (await c.get('/api/app-studio/projects/'+'f'*32+'/versions')).status_code==404
            assert (await c.post(f'/api/app-studio/projects/{pid}/restore-version',json={**payload,'expectedRevision':a.json()['versioning']['revision'],'checkHash':'a'*64})).status_code==409
    finally:await app.state.studio.close()

async def test_public_history_preserves_actual_iteration_membership_without_draft(svc):
    p=adopt(svc,await seeded(svc));p=begin(svc,p)
    p=await candidate(svc,p);iteration_id=p['versioning']['iteration']['id']
    assert p['versions'][0]['iterationId']==iteration_id
    assert p['tasks'][-1]['iterationId']==iteration_id
    assert svc.versions.read('alice',p['id'],p['versions'][0]['hash'])['iterationId']==iteration_id
    p=adopt(svc,p)
    assert p['versioning']['iterations'][-1]['id']==iteration_id
    assert 'draft' not in p['versioning']['iterations'][-1]
