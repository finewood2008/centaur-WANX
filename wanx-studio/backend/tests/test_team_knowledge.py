import pytest
from types import SimpleNamespace
from wanx_studio.contracts import check_manifest, StudioError

def test_knowledge_capability_is_explicit_and_keeps_existing_manifest_shape():
    manifest={'schemaVersion':1,'name':'团队知识应用','entry':'src/app.js','capabilities':['knowledge'],'collections':{}}
    assert check_manifest(manifest)['capabilities']==['knowledge']

async def test_existing_runtime_without_knowledge_capability_cannot_query_team_data(tmp_path):
    from wanx_studio.service import StudioService
    from pathlib import Path
    import time
    svc=StudioService(tmp_path,Path(__file__).parents[2])
    svc.runtime_sessions['test']={'owner':'wanx:1','expires':time.time()+30,'manifest':{'capabilities':['data']}}
    with pytest.raises(StudioError) as error:
        await svc.invoke('wanx:1','test','knowledge.search',{'warehouseId':'a','query':'test'})
    assert error.value.code=='CAPABILITY_DENIED'
    await svc.close()

async def test_knowledge_preflight_uses_the_project_application_id():
    from wanx_studio.preparation import Preparation
    app='ai.wanx.selfmade.'+'b'*32
    seen=[]
    def deployment(identifier):
        seen.append(identifier)
        return {'configuration':{'studio_team_data':{'warehouse-a':{'reference':'server-owned'}}}} if identifier==app else None
    svc=SimpleNamespace(runtime_sessions={},store=SimpleNamespace(get=lambda owner,pid:{'appId':app}),team=SimpleNamespace(services=SimpleNamespace(application_repo=SimpleNamespace(deployment=deployment))))
    async def invoke(owner,token,method,params):
        assert svc.runtime_sessions[token]['app']==app
        assert method=='knowledge.documents'
        return {'items':[]}
    svc.invoke=invoke
    prep=Preparation(svc)
    # The probe's final database cleanup only applies to data probes; knowledge is read-only.
    svc.store.transaction=lambda:__import__('contextlib').nullcontext()
    svc.store.db=SimpleNamespace(execute=lambda *args:None)
    result=await prep.probe_runtime('wanx:1','a'*32,'knowledge')
    assert result['status']=='passed'
    assert seen==[app]
