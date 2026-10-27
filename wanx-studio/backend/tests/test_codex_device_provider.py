"""Device configuration, isolation, and rotation at the native Codex seam."""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from wanx_studio.codex_config import config_fingerprint, runtime_config
from wanx_studio.native_codex import NativeCodex
from wanx_studio.runner import Runner
from wanx_studio.wanx import WanxModels


@pytest.fixture
def device(monkeypatch):
    monkeypatch.setenv('WANX_MODEL_PROVIDERS_ENABLED','1')
    row=SimpleNamespace(name='admin-managed-qeetoken',enabled=True,api_key='local-proxy-token',
                        base_url='http://127.0.0.1:8123/model-providers/qeetoken/v1',
                        note='wanx-admin-model-provider-v1:device-1')
    selection=[row.name,'gpt-selected']
    names=['gpt-z','gpt-a','gpt-selected','gpt-image-1','gpt-realtime','gpt-audio','embedding-1']
    capability={}
    class ProviderStore:
        def __init__(self,repo):self.repo=repo
        def build_harness_configs(self):
            return [SimpleNamespace(id=row.name,models=[SimpleNamespace(id=name) for name in names])]
        def get_model_reasoning_capability(self,ref):return capability.get(ref)
    monkeypatch.setitem(sys.modules,'octop.infra.agents.providers.store',SimpleNamespace(ProviderStore=ProviderStore))
    models=WanxModels.__new__(WanxModels)
    models.device_managed=True
    models.services=SimpleNamespace(provider_repo=SimpleNamespace(get_by_name=lambda name:row if name==row.name else None),
                                   settings_repo=SimpleNamespace(get_active_model=lambda:tuple(selection)))
    return models,row,selection,names,capability


def test_device_model_prefers_active_and_does_not_change_regular_chat(device):
    models,row,selection,names,capability=device
    assert models.codex_provider()['model']=='gpt-selected'
    selection[:]=['another-provider','ordinary-chat']
    assert models.codex_provider()['model']=='gpt-a'
    names.reverse()
    assert models.codex_provider()['model']=='gpt-a'
    assert selection==['another-provider','ordinary-chat']
    names[:]=['gpt-image-1','gpt-audio','gpt-realtime','embedding-1']
    assert models.codex_provider() is None


@pytest.mark.parametrize('changes',[
    {'enabled':False},{'api_key':''},{'note':'manual provider'},
    {'base_url':'https://qeetoken.example/v1'},
    {'base_url':'http://127.0.0.1:8123/model-providers/other/v1'},
    {'base_url':'http://private:secret@127.0.0.1:8123/model-providers/qeetoken/v1'},
    {'base_url':'http://[invalid'},
])
def test_non_device_routes_and_disabled_credentials_are_never_injected(device,changes):
    models,row,*_=device
    for key,value in changes.items():setattr(row,key,value)
    assert models.codex_provider() is None


def test_reasoning_effort_comes_from_selected_model_metadata(device):
    models,row,selection,names,capability=device
    assert models.codex_provider()['reasoning_effort'] is None
    capability[row.name+'/gpt-selected']={'adapter':'openai_reasoning_effort','default_effort':'low','efforts':['low','medium']}
    assert models.codex_provider()['reasoning_effort']=='low'
    capability[row.name+'/gpt-selected']={'adapter':'status_only','default_effort':None,'efforts':[]}
    assert models.codex_provider()['reasoning_effort'] is None


@pytest.fixture
def managed(tmp_path,device):
    root=tmp_path/'source'
    binary=root/'node_modules'/'.bin'/('codex.cmd' if os.name=='nt' else 'codex')
    binary.parent.mkdir(parents=True)
    binary.write_text('bundled executable')
    binary.chmod(0o700)
    models,*_=device
    service=SimpleNamespace(project_root=root,store=SimpleNamespace(root=tmp_path/'studio'),model=models)
    return service,binary


def test_managed_codex_uses_bundled_binary_and_private_owner_state(managed,device,monkeypatch,tmp_path):
    service,binary=managed
    def no_ambient(*_):raise AssertionError('managed Codex must not read developer home or PATH')
    monkeypatch.setattr(Path,'home',no_ambient)
    monkeypatch.setattr('shutil.which',no_ambient)
    config=runtime_config('wanx_interview',service,'wanx:1')
    settings=json.loads(config['WANX_CODEX_CONFIG'])
    assert config['WANX_CODEX_PATH']==str(binary)
    assert config['WANX_CODEX_PROXY_TOKEN']=='local-proxy-token'
    assert settings['model']=='gpt-selected'
    route=settings['model_providers']['wanx_device']
    assert route['wire_api']=='responses' and route['requires_openai_auth'] is False
    assert route['supports_websockets'] is False
    assert route['env_key']=='WANX_CODEX_PROXY_TOKEN'
    assert 'local-proxy-token' not in config['WANX_CODEX_CONFIG']
    assert 'model_reasoning_effort' not in settings
    assert Path(config['CODEX_HOME']).is_dir()
    assert not (Path(config['CODEX_HOME'])/'auth.json').exists()
    assert runtime_config('wanx_task',service,'wanx:1')['CODEX_HOME']==config['CODEX_HOME']
    assert runtime_config('wanx_task',service,'wanx:2')['CODEX_HOME']!=config['CODEX_HOME']
    for path in (tmp_path/'studio').rglob('*'):
        if path.is_file():assert b'local-proxy-token' not in path.read_bytes()


def test_managed_missing_provider_binary_or_owner_never_uses_host_login(managed,device,monkeypatch):
    service,binary=managed
    monkeypatch.setattr('shutil.which',lambda _: '/host/codex')
    assert runtime_config(service=service) is None
    device[1].enabled=False
    assert runtime_config(service=service,owner='wanx:1') is None
    device[1].enabled=True
    binary.unlink()
    assert runtime_config(service=service,owner='wanx:1') is None


async def test_proxy_token_rotation_restarts_worker_without_plaintext_fingerprint(managed,device,monkeypatch):
    service,_=managed
    monkeypatch.setenv('OPENAI_API_KEY','ambient-upstream-key')
    folder=service.project_root/'codex';folder.mkdir()
    (folder/'echo.mjs').write_text("console.log(JSON.stringify({local:process.env.WANX_CODEX_PROXY_TOKEN,cloud:process.env.OPENAI_API_KEY}));process.stdin.resume()")
    pool=NativeCodex(service)
    try:
        config=runtime_config(service=service,owner='wanx:1')
        first=await pool.acquire(('wanx:1','project','build'),'echo.mjs',config)
        assert json.loads(await first.proc.stdout.readline())=={'local':'local-proxy-token'}
        assert first.fingerprint==config_fingerprint(config)
        assert 'local-proxy-token' not in first.fingerprint
        await pool.release(first,True)
        device[1].api_key='rotated-local-token'
        changed=runtime_config(service=service,owner='wanx:1')
        second=await pool.acquire(('wanx:1','project','build'),'echo.mjs',changed)
        assert json.loads(await second.proc.stdout.readline())=={'local':'rotated-local-token'}
        assert first.proc.returncode is not None and second.proc.pid!=first.proc.pid
        assert first.fingerprint!=second.fingerprint
        await pool.release(second,True)
    finally:
        await pool.close()


async def test_preflight_cache_is_bound_to_owner_and_current_device_configuration(managed,device,monkeypatch):
    service,_=managed
    calls=[]
    class Probe:
        async def communicate(self):return b'{"available":true,"modelCalls":0}',b''
    async def spawn(*args,**kwargs):calls.append(kwargs['env']);return Probe()
    async def stop(_):pass
    service.native_codex=SimpleNamespace(stop=stop)
    monkeypatch.setattr('asyncio.create_subprocess_exec',spawn)
    runner=Runner(service)
    assert (await runner.preflight(owner='wanx:1'))['available']
    assert (await runner.preflight(owner='wanx:1'))['available']
    assert len(calls)==1
    device[1].api_key='rotated-local-token'
    assert (await runner.preflight(owner='wanx:1'))['available']
    assert len(calls)==2 and calls[-1]['WANX_CODEX_PROXY_TOKEN']=='rotated-local-token'
    assert (await runner.preflight(owner='wanx:2'))['available']
    assert len(calls)==3 and calls[-1]['CODEX_HOME']!=calls[-2]['CODEX_HOME']
    device[1].enabled=False
    assert not (await runner.preflight(owner='wanx:2'))['available']
    assert len(calls)==3


def clear_device_environment(monkeypatch):
    for key in list(os.environ):
        if key.startswith(('WANX_MODEL_PROVIDERS_','WANX_RESOURCES_')) or key=='WANX_PLATFORM_DEVICE_ID':
            monkeypatch.delenv(key)


def test_personal_wanx_models_keep_existing_host_codex_configuration(managed,device,monkeypatch,tmp_path):
    clear_device_environment(monkeypatch)
    service,_=managed
    service.model=WanxModels(device[0].services)
    monkeypatch.setattr('shutil.which',lambda _: '/existing-host/codex')
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    assert service.model.device_managed is False
    config=runtime_config(service=service,owner='wanx:1')
    assert config['WANX_CODEX_PATH']=='/existing-host/codex'
    assert 'CODEX_HOME' not in config and 'WANX_CODEX_PROXY_TOKEN' not in config
    assert 'model_provider' not in json.loads(config['WANX_CODEX_CONFIG'])


@pytest.mark.parametrize('identity', ['WANX_PLATFORM_DEVICE_ID','WANX_MODEL_PROVIDERS_DEVICE_ID','WANX_RESOURCES_DEVICE_ID'])
def test_disabling_device_providers_cannot_fall_back_to_personal_login(managed,device,monkeypatch,identity):
    clear_device_environment(monkeypatch)
    monkeypatch.setenv(identity,'device-1')
    monkeypatch.setenv('WANX_MODEL_PROVIDERS_ENABLED','0')
    service,_=managed
    service.model=WanxModels(device[0].services)
    monkeypatch.setattr('shutil.which',lambda _: '/existing-host/codex')
    assert service.model.device_managed is True
    assert runtime_config(service=service,owner='wanx:1') is None


def test_bundled_runner_default_only_applies_to_configured_managed_devices(device):
    models,row,*_=device
    calls=[]
    settings=SimpleNamespace(load_runners=lambda uid,**kwargs:calls.append((uid,kwargs)) or {})
    models.codex_runners(settings,7)
    assert calls[-1]==(7,{'defaults':{'codex':{'command':'codex','args':['app-server'],'trusted':True,'enabled':True}}})
    row.enabled=False
    models.codex_runners(settings,7)
    assert calls[-1]==(7,{})
    row.enabled=True;models.device_managed=False
    models.codex_runners(settings,8)
    assert calls[-1]==(8,{})
