import asyncio
import json
import base64
from pathlib import Path
from uuid import uuid4

import pytest
from httpx import ASGITransport,AsyncClient

from wanx_studio.contracts import StudioError
from wanx_studio.local import build_local
from wanx_studio.runner import Runner
from wanx_studio.service import StudioService
from wanx_studio.store import Store
from wanx_studio.codex_config import runtime_config

ROOT=Path(__file__).resolve().parents[2]


async def test_complete_history_survives_summary_window_restart_and_owner_boundary(tmp_path):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    p=svc.store.create('alice','完整开发记录','目标',uuid4().hex)
    task_id=uuid4().hex
    with svc.store.transaction():
        p=svc.store.get('alice',p['id']);p['tasks'].append({'id':task_id,'state':'completed','events':[]});svc.store.save(p)
    for n in range(321):
        svc.runner.event('alice',p['id'],task_id,{'type':'activity','text':str(n),'rawOutput':{'text':'x'*10000}})
    assert len(svc.store.get('alice',p['id'])['tasks'][0]['events'])==300
    await svc.close()
    restored=Store(tmp_path)
    try:
        all_events=[];cursor=0
        while True:
            page=restored.task_events('alice',p['id'],task_id,cursor,100)
            all_events.extend(page['items']);cursor=page['nextCursor']
            if not page['hasMore']:break
        assert len(all_events)==321 and all_events[0]['text']=='0' and all_events[-1]['text']=='320'
        assert len(all_events[0]['rawOutput']['text'])==10000
        with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):
            restored.task_events('bob',p['id'],task_id)
        with pytest.raises(StudioError,match='TASK_NOT_FOUND'):
            restored.task_events('alice',p['id'],'other-task')
    finally:restored.close()


async def test_development_is_readonly_and_has_no_live_answer_endpoint(tmp_path):
    app=build_local(tmp_path);svc=app.state.studio
    try:
        p=svc.store.create('synthetic-local-user','只读开发','目标',uuid4().hex)
        with svc.store.transaction():
            p=svc.store.get('synthetic-local-user',p['id']);p['tasks'].append({'id':'task','state':'running','events':[]});svc.store.save(p)
        with pytest.raises(StudioError,match='BUILD_ACTIVE'):
            svc.confirm('synthetic-local-user',p['id'],{'operationId':uuid4().hex,'solutionHash':'anything'})
        with pytest.raises(StudioError,match='BUILD_ACTIVE'):
            svc.accept('synthetic-local-user',p['id'],{'operationId':uuid4().hex,'artifactHash':'anything'})
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as client:
            await client.get('/api/app-studio/session')
            assert (await client.post(f'/api/app-studio/projects/{p["id"]}/tasks/task/answer',json={})).status_code==404
            response=await client.get(f'/api/app-studio/projects/{p["id"]}/tasks/task/events')
            assert response.status_code==200
            for operation in ['input','paste','key','signal','exec']:
                response=await client.post(f'/api/app-studio/projects/{p["id"]}/tasks/task/terminal/{operation}',json={'data':'rm -rf /'})
                assert response.status_code==403 and response.json()['code']=='TERMINAL_READ_ONLY'
            assert (await client.post(f'/api/app-studio/projects/{p["id"]}/tasks/other/terminal/input',json={})).status_code==404
    finally:await svc.close()


async def test_terminal_recording_replays_identical_bytes_after_restart_without_evicting_progress(tmp_path):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    p=svc.store.create('alice','原生终端记录','目标',uuid4().hex)
    with svc.store.transaction():
        p=svc.store.get('alice',p['id']);p['tasks'].append({'id':'terminal','state':'completed','events':[]});svc.store.save(p)
    expected=b''
    svc.runner.event('alice',p['id'],'terminal',{'type':'status','text':'真实开发步骤'})
    for n in range(321):
        chunk=b'\x1b[2K\r'+('Codex 开发 '+str(n)).encode()+b'\r\n';expected+=chunk
        svc.runner.event('alice',p['id'],'terminal',{'type':'terminal','data':base64.b64encode(chunk).decode()})
    assert len(svc.store.get('alice',p['id'])['tasks'][0]['events'])==1
    await svc.close();restored=Store(tmp_path)
    try:
        actual=b'';cursor=0
        while True:
            page=restored.task_events('alice',p['id'],'terminal',cursor,25)
            for event in page['items']:
                if event['type']=='terminal':actual+=base64.b64decode(event['data'])
            cursor=page['nextCursor']
            if not page['hasMore']:break
        assert actual==expected
    finally:restored.close()


def test_codex_config_disables_ambient_tools_without_reading_credentials(tmp_path,monkeypatch):
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setattr('shutil.which',lambda _: '/synthetic/codex')
    (tmp_path/'.codex').mkdir()
    (tmp_path/'.codex/config.toml').write_text('[mcp_servers.private_server]\ncommand="private-command"\n[mcp_servers.private_server.env]\nSECRET="must-not-propagate"\n')
    config=runtime_config();value=json.loads(config['WANX_CODEX_CONFIG'])
    assert value['features']['shell_tool'] is False and value['features']['plugins'] is False
    assert value['mcp_servers']['private_server']=={'enabled':False}
    assert 'must-not-propagate' not in json.dumps(config)


async def test_codex_startup_failure_is_persisted_in_process_history(tmp_path,monkeypatch):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    p=svc.store.create('alice','启动失败可恢复','目标',uuid4().hex)
    with svc.store.transaction():
        p=svc.store.get('alice',p['id'])
        p['tasks'].append({'id':'startup','state':'running','events':[]});svc.store.save(p)
    monkeypatch.setattr('wanx_studio.runner.runtime_config',lambda:None)
    try:
        await svc.runner.run('alice',p,'startup','开发')
        task=svc.store.get('alice',p['id'])['tasks'][-1]
        assert task['state']=='failed' and task['error']=='CODEX_NOT_CONFIGURED'
        assert svc.store.task_events('alice',p['id'],'startup')['items'][-1]['text']=='开发未完成：CODEX_NOT_CONFIGURED'
        assert not svc.processes and not svc.runner.jobs
    finally:await svc.close()


async def test_slow_preflight_returns_saved_task_immediately_and_retry_does_not_duplicate(tmp_path,monkeypatch):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    try:
        p=svc.store.create('alice','启动检查较慢','目标',uuid4().hex)
        p=await svc.runner.example('alice',p['id'],uuid4().hex)
        other=svc.store.create('alice','另一个项目','目标',uuid4().hex)
        other=await svc.runner.example('alice',other['id'],uuid4().hex)
        entered=asyncio.Event();release=asyncio.Event();executed=[]
        async def preflight(**kwargs):
            entered.set();await release.wait();return {'available':True}
        async def execute(*args):executed.append(args)
        monkeypatch.setattr(svc.runner,'preflight',preflight)
        monkeypatch.setattr(svc.runner,'execute',execute)
        body={'operationId':uuid4().hex,'solutionHash':p['solutionHash'],'instruction':''}
        result=await asyncio.wait_for(svc.runner.start('alice',p['id'],body),.5)
        task_id=result['tasks'][-1]['id']
        assert result['tasks'][-1]['state']=='queued' and result['stage']=='building'
        await asyncio.wait_for(entered.wait(),.5)
        again=await svc.runner.start('alice',p['id'],body)
        assert len(again['tasks'])==len(result['tasks']) and again['tasks'][-1]['id']==task_id
        assert '检查' in svc.store.task_events('alice',p['id'],task_id)['items'][0]['text']
        with pytest.raises(StudioError,match='BUILD_CONCURRENCY_LIMIT'):
            await svc.runner.start('alice',other['id'],{'operationId':uuid4().hex,'solutionHash':other['solutionHash'],'instruction':''})
        release.set();await svc.runner.jobs[task_id]
        assert len(executed)==1
        assert svc.store.get('alice',p['id'])['tasks'][-1]['state']=='running'
    finally:await svc.close()


@pytest.mark.parametrize('wait_for_probe',[True,False])
async def test_cancel_during_preflight_never_starts_codex(tmp_path,monkeypatch,wait_for_probe):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    try:
        p=svc.store.create('alice','检查时停止','目标',uuid4().hex)
        p=await svc.runner.example('alice',p['id'],uuid4().hex)
        entered=asyncio.Event();stopped=asyncio.Event();executed=[]
        async def preflight(**kwargs):
            entered.set()
            try:await asyncio.Event().wait()
            finally:stopped.set()
        async def execute(*args):executed.append(args)
        monkeypatch.setattr(svc.runner,'preflight',preflight)
        monkeypatch.setattr(svc.runner,'execute',execute)
        result=await svc.runner.start('alice',p['id'],{'operationId':uuid4().hex,'solutionHash':p['solutionHash'],'instruction':''})
        task_id=result['tasks'][-1]['id']
        if wait_for_probe:await entered.wait()
        await svc.runner.cancel('alice',p['id'],task_id,uuid4().hex)
        assert (not wait_for_probe or stopped.is_set()) and not executed and not svc.runner.jobs
        assert svc.store.get('alice',p['id'])['tasks'][-1]['state']=='cancelled'
    finally:await svc.close()


async def test_expired_workbench_during_preflight_never_starts_codex(tmp_path,monkeypatch):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    try:
        p=svc.store.create('alice','检查时断开','目标',uuid4().hex)
        p=await svc.runner.example('alice',p['id'],uuid4().hex)
        executed=[]
        async def preflight(**kwargs):
            svc.runner.leases[('alice',p['id'])]=0
            return {'available':True}
        async def execute(*args):executed.append(args)
        monkeypatch.setattr(svc.runner,'preflight',preflight)
        monkeypatch.setattr(svc.runner,'execute',execute)
        result=await svc.runner.start('alice',p['id'],{'operationId':uuid4().hex,'solutionHash':p['solutionHash'],'instruction':''})
        await svc.runner.jobs[result['tasks'][-1]['id']]
        task=svc.store.get('alice',p['id'])['tasks'][-1]
        assert task['state']=='failed' and task['error']=='WORKBENCH_SESSION_EXPIRED' and not executed
    finally:await svc.close()


async def test_cancelled_preflight_reaps_probe_process(tmp_path,monkeypatch):
    root=tmp_path/'source';(root/'tools').mkdir(parents=True)
    (root/'tools/probe-codex.mjs').write_text('setInterval(()=>{},10000)')
    svc=StudioService(tmp_path/'data',root);svc.runner=Runner(svc)
    entered=asyncio.Event();processes=[]
    original=asyncio.create_subprocess_exec
    async def spawn(*args,**kwargs):
        proc=await original(*args,**kwargs)
        processes.append(proc);entered.set();return proc
    monkeypatch.setattr('wanx_studio.runner.runtime_config',lambda:{'WANX_CODEX_PATH':'synthetic'})
    monkeypatch.setattr('asyncio.create_subprocess_exec',spawn)
    try:
        task=asyncio.create_task(svc.runner.preflight());await entered.wait();task.cancel()
        with pytest.raises(asyncio.CancelledError):await task
        assert processes and all(p.returncode is not None for p in processes)
    finally:await svc.close()


async def test_modification_keeps_successful_sources_instead_of_older_failed_draft(tmp_path,monkeypatch):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    from wanx_studio.contracts import digest
    try:
        p=svc.store.create('alice','超时恢复后继续修改','目标',uuid4().hex)
        h=digest(p['solution'])
        p['tasks']=[{'id':'old-failed','state':'failed','solutionHash':h},{'id':'success','state':'completed','solutionHash':h},{'id':'new','state':'queued','solutionHash':h}]
        p['artifacts']=[{'taskId':'success','files':{'src/app.js':'complete','src/app.css':'styles'}}]
        old=tmp_path/'tasks/old-failed';old.mkdir(parents=True);(old/'sources.json').write_text(json.dumps({'src/app.js':'incomplete'}))
        monkeypatch.setattr(svc.runner,'event',lambda *args:None)
        assert svc.runner.source_files('alice',p,'new')==p['artifacts'][0]['files']
        newer=tmp_path/'tasks/newer-failed';newer.mkdir();(newer/'sources.json').write_text(json.dumps({'src/app.js':'newer progress','src/app.css':'styles'}))
        p['tasks'].insert(-1,{'id':'newer-failed','state':'failed','solutionHash':h})
        assert svc.runner.source_files('alice',p,'new')['src/app.js']=='newer progress'
        p['tasks'][-2]['solutionHash']='obsolete-requirement'
        assert svc.runner.source_files('alice',p,'new')==p['artifacts'][0]['files']
    finally:await svc.close()


def test_product_manager_disables_ambient_development_server(tmp_path,monkeypatch):
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setattr('shutil.which',lambda _: '/synthetic/codex')
    (tmp_path/'.codex').mkdir()
    (tmp_path/'.codex/config.toml').write_text('[mcp_servers.wanx_task]\ncommand="development-only"\n[mcp_servers.wanx_interview]\ncommand="session-tool"\n')
    settings=json.loads(runtime_config('wanx_interview')['WANX_CODEX_CONFIG'])
    assert settings['mcp_servers']['wanx_task']=={'enabled':False}
    assert 'wanx_interview' not in settings['mcp_servers']
    assert 'development-only' not in json.dumps(settings)
