import asyncio
from copy import deepcopy
import json

import pytest

from test_studio import svc,seeded,op
from wanx_studio.contracts import StudioError,digest
from wanx_studio.iterative import proposal,propose_contract
from wanx_studio.store import public
from wanx_studio.versions import verify


async def draft(svc):
    p=await seeded(svc)
    def edit(q):
        q['solution']['outputs']='先做可用首版，再试用改进'
        q['confirmation']=None
    svc.store.mutate('alice',p['id'],op(),{},edit)
    return svc.store.get('alice',p['id'])


async def start(svc,p,monkeypatch,**overrides):
    proposed=proposal(p)
    body={'operationId':op(),'specHash':proposed['specHash'],'impactHash':proposed['impactHash'],'confirmedContract':True,'instruction':'调整界面',**overrides}
    async def wait(*_):await asyncio.sleep(60)
    monkeypatch.setattr(svc.runner,'run',wait)
    result=await svc.runner.start('alice',p['id'],{'operationId':body['operationId'],'solutionHash':body['specHash'],'instruction':body['instruction']},iterative=body)
    return result,body


async def test_new_build_does_not_require_legacy_full_prd_confirmation(svc,monkeypatch):
    p=await draft(svc)
    assert p['confirmation'] is None
    result,body=await start(svc,p,monkeypatch)
    task=svc.store.get('alice',p['id'])['tasks'][-1]
    assert task['change']['spec']['behavior']==p['solution']
    assert task['change']['specHash']==digest(p['solution'])
    assert 'change' not in result['tasks'][-1]
    again=await svc.runner.start('alice',p['id'],{'operationId':body['operationId'],'solutionHash':body['specHash'],'instruction':body['instruction']},iterative=body)
    assert again['tasks'][-1]['id']==task['id']
    with pytest.raises(StudioError,match='OPERATION_CONFLICT'):
        await svc.runner.start('alice',p['id'],{'operationId':body['operationId'],'solutionHash':body['specHash'],'instruction':'另一个要求'},iterative=body)


async def test_stale_impact_is_rejected_and_build_action_freezes_contract(svc,monkeypatch):
    p=await draft(svc)
    with pytest.raises(StudioError,match='SOLUTION_CHANGED'):await start(svc,p,monkeypatch,impactHash='a'*64)
    # A newly proposed schema is separate from ordinary prose edits.
    propose_contract(svc,'alice',p['id'],{'expectedHash':digest(p['solution']),'collections':{'notes':{'title':'string'}}})
    p=svc.store.get('alice',p['id'])
    assert not proposal(p)['needsContractConfirmation']
    result,_=await start(svc,p,monkeypatch,confirmedContract=False)
    task=svc.store.get('alice',p['id'])['tasks'][-1]
    assert task['change']['contract']['collections']=={'notes':{'title':'string'}}
    assert task['change']['confirmationMode']=='build-action'
    assert result['tasks'][-1]['state']=='queued'


async def test_behavior_change_preserves_contract_confirmation(svc,monkeypatch):
    p=await draft(svc)
    assert not proposal(p)['needsContractConfirmation']
    result,_=await start(svc,p,monkeypatch,confirmedContract=False)
    assert result['tasks'][-1]['state']=='queued'


async def test_compiler_enforces_frozen_schema_and_records_checkpoint(svc,monkeypatch):
    p=await draft(svc);result,_=await start(svc,p,monkeypatch)
    task_id=result['tasks'][-1]['id']
    svc.store.mutate('alice',p['id'],op(),{},lambda q:q['tasks'][-1].update({'state':'running'}))
    files=deepcopy(p['artifacts'][-1]['files']);m=json.loads(files['miniapp.manifest.json'])
    m['collections']['items']['undeclared']='string';files['miniapp.manifest.json']=json.dumps(m)
    with pytest.raises(StudioError,match='CONTRACT_SCHEMA_NOT_CONFIRMED'):await svc.add_artifact('alice',p['id'],task_id,files)
    await svc.add_artifact('alice',p['id'],task_id,p['artifacts'][-1]['files'])
    artifact=svc.store.get('alice',p['id'])['artifacts'][-1]
    verify(artifact)
    assert artifact['checkpoint']['parent']==p['artifacts'][-1]['hash']
    artifact['checkpoint']['contract']['capabilities'].append('files')
    with pytest.raises(StudioError,match='ARTIFACT_INTEGRITY_FAILED'):verify(artifact)


async def test_private_state_never_leaks_through_legacy_projection(svc):
    p=await seeded(svc);p['_iterative']={'secret':'private'};p['futureInternal']='private'
    p['tasks'][-1]['change']={'spec':'private'}
    result=public(p)
    assert '_iterative' not in result and 'futureInternal' not in result
    assert 'change' not in result['tasks'][-1]


async def test_other_project_interview_does_not_consume_build_slot(svc,monkeypatch):
    p=await draft(svc)
    class Process:
        returncode=0
    svc.processes['interview:other-project']=Process()
    result,_=await start(svc,p,monkeypatch)
    assert result['tasks'][-1]['state']=='queued'


async def test_lease_has_reconnect_grace_but_revocation_is_immediate(svc):
    import time
    svc.runner.leases[('alice','project')]=time.monotonic()-30
    guard=asyncio.create_task(svc.runner.guard_lease('alice','project'))
    await asyncio.sleep(2.1)
    assert not guard.done()
    class Team:
        def is_admin(self,owner):return False
    svc.team=Team()
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        await asyncio.wait_for(guard,3)


async def test_warehouse_retrieval_rejects_foreign_documents_and_caps_output():
    from wanx_studio.context_sources import WanxContextSources
    warehouse='11111111-1111-1111-1111-111111111111'
    refs=[{'kind':'xingtu','id':'team-'+warehouse+'__doc','name':'资料','revision':'1'}]
    calls=[]
    class Star:
        foreign=False
        async def request(self,method,path,**kwargs):
            calls.append((method,path,kwargs))
            return {'items':[{'document_id':'foreign' if self.foreign else 'doc','text':'a'*5000}]*6}
    star=Star();provider=WanxContextSources(None,None,None);provider.team_star=lambda _:star
    result=await provider.search_selected('alice',refs,'query')
    assert sum(len(r['text']) for r in result['items'])<=16000
    assert calls[-1][2]['payload']['document_ids']==['doc']
    star.foreign=True
    with pytest.raises(StudioError,match='CONTEXT_NOT_SELECTED'):await provider.search_selected('alice',refs,'query')

async def test_iterative_negotiation_is_private_and_preserves_public_context(tmp_path):
    from httpx import ASGITransport,AsyncClient
    from wanx_studio.local import build_local
    app=build_local(tmp_path)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as client:
            assert (await client.get('/api/app-studio/_builder/context')).status_code==401
            await client.get('/api/app-studio/session')
            context=(await client.get('/api/app-studio/context')).json()
            assert set(context['features'])=={'taskPreparation','codexInterview','productVersions','continuousWorkspace','engines'}
            assert (await client.get('/api/app-studio/_builder/context')).json()=={'protocolVersion':1,'iterativeBuild':1,'directEdits':1}


async def test_service_shutdown_marks_build_interrupted_and_preserves_baseline(svc,monkeypatch):
    p=await draft(svc)
    entered=asyncio.Event()
    async def probing(**_):
        entered.set()
        await asyncio.Future()
    monkeypatch.setattr(svc.runner,'preflight',probing)
    proposed=proposal(p)
    body={'operationId':op(),'specHash':proposed['specHash'],'impactHash':proposed['impactHash'],'confirmedContract':False,'instruction':''}
    result=await svc.runner.start('alice',p['id'],{'operationId':body['operationId'],'solutionHash':body['specHash'],'instruction':''},iterative=body)
    await entered.wait()
    svc.closing=True
    job=svc.runner.jobs[result['tasks'][-1]['id']]
    job.cancel()
    await job
    svc.closing=False
    saved=svc.store.get('alice',p['id'])
    assert saved['tasks'][-1]['state']=='interrupted'
    assert saved['tasks'][-1]['error']=='SERVICE_RESTARTED'
    assert saved['artifacts']==p['artifacts']
    assert not svc.runner.jobs
