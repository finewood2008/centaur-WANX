from copy import deepcopy
import pytest
from wanx_studio.contracts import StudioError
from test_studio import svc,create

CONFIG={'codex':{'enabled':True,'trusted':True,'command':'npx','args':['-y','@agentclientprotocol/codex-acp'],'env':{}},'claude_code':{'enabled':True,'command':'claude','env':{'SECRET':'never-return-this'}}}

def test_engine_projection_and_binding_follow_account_instance_config(svc):
 configs=deepcopy(CONFIG);svc.engines.provider=lambda owner:configs if owner=='alice' else {}
 listing=svc.engines.list('alice');assert listing['defaultId']=='codex'
 assert 'never-return-this' not in str(listing) and 'command' not in str(listing) and 'env' not in str(listing)
 assert listing['items'][1]['status']=='unsupported'
 p=svc.store.get('alice',create(svc)['id']);svc.engines.bind('alice',p);svc.engines.guard('alice',p,required=True)
 configs['codex']['tool_parse_mode']='call_title'
 with pytest.raises(StudioError,match='ENGINE_CONFIGURATION_CHANGED'):svc.engines.guard('alice',p,required=True)
 assert svc.engines.list('bob')['items']==[]
 with pytest.raises(StudioError,match='ENGINE_NOT_ADAPTED'):svc.engines.select('alice','claude_code')

def test_disabled_or_arbitrary_commands_cannot_be_bound(svc):
 configs=deepcopy(CONFIG);svc.engines.provider=lambda _:configs
 configs['codex']['command']='sh';configs['codex']['args']=['-c','touch /tmp/no']
 with pytest.raises(StudioError,match='ENGINE_NOT_ADAPTED'):svc.engines.require('alice','codex')
 configs['codex']=deepcopy(CONFIG['codex']);configs['codex']['enabled']=False
 with pytest.raises(StudioError,match='ENGINE_DISABLED'):svc.engines.select('alice','codex')

async def test_engine_checks_are_explicit_and_never_claim_model_inference(svc):
 svc.engines.provider=lambda _:CONFIG
 calls=[]
 async def probe(fresh=False,owner=None):calls.append(fresh);return {'available':False,'code':'PREFLIGHT_FAILED','modelCalls':0}
 svc.runner.preflight=probe
 assert svc.engines.list('alice')['items'][0]['status']=='unchecked' and calls==[]
 result=await svc.engines.check('alice','codex')
 assert calls==[True] and result['items'][0]['status']=='failed'

async def test_intake_binds_default_and_explicit_check_recovers_only_unbound_intake(svc):
 svc.engines.provider=lambda _:deepcopy(CONFIG)
 p=create(svc)
 p=svc.preparation.enable('alice',p['id'])
 assert p['engine']['id']=='codex'
 original=p['engine'].copy()
 svc.preparation.enable('alice',p['id'])
 assert svc.store.get('alice',p['id'])['engine']==original
 # Simulate an intake created by the older service; check binds the configured
 # default, but still executes real probe/preflight paths before passing.
 def unbind(p):p.pop('engine')
 svc.store.mutate('alice',p['id'],'legacy-unbound-test',{},unbind)
 async def probe(fresh=False,owner=None):return {'available':True,'modelCalls':0}
 svc.runner.preflight=probe
 result=await svc.preparation.check('alice',p['id'],{'operationId':'recover-intake-engine'})
 assert result['engine']['id']=='codex'
 assert result['preparation']['report']['codex']['available'] is True
 configs=deepcopy(CONFIG);configs['codex']['tool_parse_mode']='changed'
 svc.engines.provider=lambda _:configs
 with pytest.raises(StudioError,match='ENGINE_CONFIGURATION_CHANGED'):
  await svc.preparation.check('alice',p['id'],{'operationId':'do-not-rebind-existing'})
 assert svc.store.get('alice',p['id'])['engine']==original

async def test_http_intake_creation_binds_engine_and_retry_preserves_project(tmp_path):
 from httpx import ASGITransport,AsyncClient
 from wanx_studio.local import build_local
 app=build_local(tmp_path);service=app.state.studio
 service.engines.provider=lambda _:deepcopy(CONFIG)
 try:
  async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as client:
   await client.get('/api/app-studio/session')
   body={'name':'会议测试','goal':'仅本人跟进会议','intake':True,'operationId':'http-intake-engine-binding'}
   first=await client.post('/api/app-studio/projects',json=body)
   assert first.status_code==200
   p=first.json();assert p['engine']['id']=='codex'
   retry=await client.post('/api/app-studio/projects',json=body)
   assert retry.status_code==200 and retry.json()['id']==p['id']
   assert retry.json()['engine']==p['engine']
   listing=(await client.get('/api/app-studio/projects')).json()
   assert len(listing['projects'])==1
 finally:await service.close()
