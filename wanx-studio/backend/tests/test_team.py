"""Real runtime/store behavior; HTTP authentication is exercised separately against WANX."""
import copy
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.runner import Runner
from wanx_studio.service import StudioService
from wanx_studio.team import TeamPublications

ROOT=__import__('pathlib').Path(__file__).resolve().parents[2]

def op():return uuid4().hex

class Applications:
    def __init__(self):self.products={};self.deployments={};self.access={}
    def get(self,key):return self.products.get(key)
    def deployment(self,key):return copy.deepcopy(self.deployments.get(key))
    def user_access(self,key,user):return self.access.get((key,user))

@pytest.fixture
async def team(tmp_path):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    users={i:SimpleNamespace(id=i,role='admin' if i==1 else 'user',disabled=False) for i in [1,2,3]}
    repo=Applications();services=SimpleNamespace(user_repo=SimpleNamespace(get=users.get),application_repo=repo)
    svc.team=TeamPublications(svc,services)
    p=svc.store.create('wanx:1','内部台账','管理员私有需求',op())
    p=await svc.runner.example('wanx:1',p['id'],op())
    a=p['artifacts'][-1]
    svc.accept('wanx:1',p['id'],{'operationId':op(),'artifactHash':a['hash'],'criteria':list(range(len(p['solution']['acceptance']))),'confirmedByUser':True})
    repo.products[p['appId']]=SimpleNamespace(created_by=1)
    repo.deployments[p['appId']]={'enabled':False,'configuration':{'studio_team':{'projectId':p['id'],'artifactHash':a['hash'],'audience':'all'}}}
    receipt={'operationId':op(),'artifactHash':a['hash'],'applicationId':p['appId'],'version':a['version']}
    svc.installed('wanx:1',p['id'],receipt)
    repo.deployments[p['appId']]['enabled']=True
    yield SimpleNamespace(svc=svc,users=users,repo=repo,project=p,artifact=a,receipt=receipt)
    await svc.close()

async def test_members_share_published_records_but_keep_preview_and_tokens_private(team):
    s,p,a=team.svc,team.project,team.artifact
    user=s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')['session']
    admin=s.open_installed_runtime('wanx:1',p['appId'],a['hash'],'production')['session']
    row=await s.invoke('wanx:2',user,'data.put',{'collection':'items','value':{'title':'成员提交的事项'}})
    assert (await s.invoke('wanx:1',admin,'data.get',{'collection':'items','id':row['_id']}))['title']=='成员提交的事项'
    preview=s.open_runtime('wanx:1',p['id'],a['hash'],'preview')['session']
    assert not (await s.invoke('wanx:1',preview,'data.list',{'collection':'items'}))['items']
    with pytest.raises(StudioError,match='RUNTIME_SESSION_EXPIRED'):
        await s.invoke('wanx:3',user,'data.list',{'collection':'items'})

async def test_catalog_and_portable_payload_exclude_private_requirements(team):
    s,p,a=team.svc,team.project,team.artifact
    catalog=s.list_projects('wanx:2')
    assert catalog[0]['appId']==p['appId']
    for key in ['solution','context','owner','confirmation','acceptance','preparation']:
        assert key not in catalog[0]
    payload=s.install_payload('wanx:2',p['id'],a['hash'])
    assert payload['bundle']==s.artifact('wanx:1',p['id'],a['hash'])[1]['bundle']
    assert 'owner' not in payload and 'solution' not in payload
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):s.store.get('wanx:2',p['id'])

@pytest.mark.parametrize('change',['unpublish','revoke','disable','policy','replace'])
async def test_revocation_applies_to_existing_runtime_on_every_call(team,change):
    s,p,a=team.svc,team.project,team.artifact
    token=s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')['session']
    if change=='unpublish':team.repo.deployments[p['appId']]['enabled']=False
    if change=='revoke':team.repo.access[(p['appId'],2)]=False
    if change=='disable':team.users[2].disabled=True
    if change=='policy':team.repo.deployments[p['appId']]['configuration']['studio_team']['audience']='selected'
    if change=='replace':
        with s.store.lock:s.store.db.execute('UPDATE team_publications SET artifact=?',('f'*64,))
    with pytest.raises(StudioError):await s.invoke('wanx:2',token,'data.list',{'collection':'items'})
    with pytest.raises(StudioError):s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')
    if change!='disable':assert s.list_projects('wanx:2')==[]

async def test_selected_members_and_explicit_denial_override_all(team):
    s,p,a=team.svc,team.project,team.artifact
    team.repo.deployments[p['appId']]['configuration']['studio_team']['audience']='selected'
    s.installed('wanx:1',p['id'],{**team.receipt,'operationId':op()})
    team.repo.access[(p['appId'],2)]=True
    assert s.list_projects('wanx:2')
    assert not s.list_projects('wanx:3')
    with pytest.raises(StudioError):s.install_payload('wanx:3',p['id'],a['hash'])

async def test_deployment_metadata_without_admin_receipt_is_not_executable(team):
    s,p,a=team.svc,team.project,team.artifact
    with s.store.lock:s.store.db.execute('DELETE FROM team_publications')
    assert s.list_projects('wanx:2')==[]
    with pytest.raises(StudioError):s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')
    with pytest.raises(StudioError,match='STUDIO_ADMIN_REQUIRED'):
        s.team.seal('wanx:2',p['id'],s.install_payload('wanx:1',p['id'],a['hash']))

async def test_model_usage_uses_actual_member_identity(team):
    s,p,a=team.svc,team.project,team.artifact;seen=[]
    async def model(owner,body):
        seen.append(owner);return {'choices':[{'message':{'content':'已整理'}}]}
    s.model=model
    token=s.open_installed_runtime('wanx:2',p['appId'],a['hash'],'production')['session']
    # The fixture declares data/model; all runtime methods still check declared capabilities.
    s.runtime_sessions[token]['manifest']['capabilities'].append('model') if 'model' not in s.runtime_sessions[token]['manifest']['capabilities'] else None
    result=await s.invoke('wanx:2',token,'model.generate',{'prompt':'整理这条事项'})
    assert result['text']=='已整理' and seen==['wanx:2']
    assert s.store.db.execute('SELECT owner FROM usage').fetchone()[0]=='wanx:2'
