"""Start the actual WANX source in a new data root for local integration QA.

Only the model catalog can be borrowed read-only. Real project, conversation,
file, account and Agent databases are never copied into this instance.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import secrets
from pathlib import Path


async def main(args):
    import uvicorn
    from octop.config import load_config,DatabaseConfig
    from octop.infra.db.rebind import persist_database_config
    from octop.infra.server import OctopServer
    from octop.api.app import build_app
    from .wanx import mount_wanx
    from .readonly_catalog import catalog

    root=Path(args.root).resolve()
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    marker=root/'.studio-isolated-instance'
    if any(root.iterdir()) and not marker.exists():
        raise RuntimeError('REFUSE_EXISTING_UNMARKED_DATA_ROOT')
    marker.write_text('WANX Studio isolated synthetic QA data\n')
    config=root/'config.json'
    load_config(config)
    data=json.loads(config.read_text())
    data.update({'require_setup_password':False,'enable_dashboard':False,'enable_api_docs':True,'bind_host':'127.0.0.1','port':args.port})
    config.write_text(json.dumps(data))
    persist_database_config(config,DatabaseConfig())
    server=OctopServer(home=root)
    await server.start()
    await server.bind_control_plane()
    try:
        if server.user_manager.count()==0:
            await server.user_manager.create(username='studio-validation',password=secrets.token_urlsafe(24)+'A9',role='admin',display_name='工作台隔离验证用户')
        app=build_app(server)
        project=Path(__file__).resolve().parents[2]
        service=mount_wanx(app,server,project,catalog_services=catalog(Path(args.catalog)) if args.catalog else None)
        if args.seed_build_engine:
            # Only this disposable QA instance; never copy or edit a real ACP config.
            u=server.user_manager.get('studio-validation')
            server.app_runtime.agent_registry.acp_settings.save_runners(u.id,{'codex':{'enabled':True,'trusted':True,'command':'npx','args':['-y','@agentclientprotocol/codex-acp'],'env':{}},'claude_code':{'enabled':True,'trusted':True,'command':'claude','args':['acp'],'env':{}}})
        # Synthetic local session only. The random token stays in the launcher
        # and Electron main process; it is never displayed or put in a URL.
        from octop.api.deps import sign_token
        user=server.user_manager.get('studio-validation')
        token=sign_token(server.services.secret_repo.get('jwt'),sub=user.id,uname=user.username,role=user.role,ttl_seconds=7200,application_id='wanx')
        # Authentication bootstrapping is supplied through a private inherited
        # pipe when an Electron harness is requested, not a disk or command arg.
        workspace_fixture_id=None
        if args.seed_workspace:
            from uuid import uuid4
            value=json.loads((project/'examples/prd-interview-fixture.json').read_text())
            p=service.store.create('wanx:'+str(user.id),'【独立体验】完整 PRD','固定软件验证样例：以业务事项台账演示七部分完整 PRD，不代表真实项目或业务数据。',uuid4().hex)
            service.update_solution('wanx:'+str(user.id),p['id'],{'operationId':uuid4().hex,'expectedHash':p['solutionHash'],'solution':value['solution']})
            def interview(p):
                p['discoveryStarted']=True
                p['messages'].append({'id':uuid4().hex,'role':'assistant','text':'这是一道固定界面验证题，没有调用模型。你可以先浏览完整 PRD，再决定优先核对的内容；提交后才会调用当前 WANX 模型继续访谈。','question':{'focus':'review','text':'你最想先核对哪一部分？','why':'从最熟悉的部分开始检查方案。','options':['先核对使用流程','先看页面草图','先确认数据和规则']},'options':['先核对使用流程','先看页面草图','先确认数据和规则']})
            service.store.mutate('wanx:'+str(user.id),p['id'],uuid4().hex,{'action':'seed-software-interview-fixture'},interview)
            workspace_fixture_id=p['id']
        if args.seed_versions:
            from .version_fixture import seed_versions
            workspace_fixture_id=await seed_versions(service,'wanx:'+str(user.id))
        fixture_id=None
        if args.seed_fixture:
            from uuid import uuid4
            from octop.infra.personal_space.service import PersonalSpace
            from hashlib import sha256
            owner='wanx:'+str(user.id)
            fixture=service.store.create(owner,'安装生命周期自动验证样例','仅供软件验证的固定台账，不代表本人业务验收',uuid4().hex)
            fixture=await service.runner.example(owner,fixture['id'],uuid4().hex)
            fixture_id=fixture['id']
            from .contracts import digest
            files=dict(service.store.get(owner,fixture_id)['artifacts'][0]['files'])
            manifest=json.loads(files['miniapp.manifest.json'])
            manifest['collections']['items']['priority']='string'
            files['miniapp.manifest.json']=json.dumps(manifest,ensure_ascii=False)
            def add_upgrade(project):
                project['tasks'].append({'id':'fixture-upgrade','executor':'fixed-example','version':'1','state':'running','solutionHash':digest(project['solution']),'createdAt':0,'events':[],'question':None})
            service.store.mutate(owner,fixture_id,uuid4().hex,{'action':'synthetic-upgrade'},add_upgrade)
            await service.add_artifact(owner,fixture_id,'fixture-upgrade',files)
            storage=PersonalSpace(server.paths.root/'.wanx-personal-space',user.id)
            data='隔离验证资料：本周先处理客户回访。'.encode()
            file_id=uuid4().hex
            storage.upload_create('','验证参考.md',len(data),file_id)
            storage.upload_chunk(file_id,0,data,sha256(data).hexdigest())
            storage.upload_complete(file_id,sha256(data).hexdigest())
        if args.seed_background:
            from octop.infra.personal_space.service import PersonalSpace
            from uuid import uuid4
            from hashlib import sha256
            storage=PersonalSpace(server.paths.root/'.wanx-personal-space',user.id)
            if not any(x['name']=='【合成资料】会议工作背景.md' for x in storage.listing()['items']):
                text='这是独立联调的合成背景，不代表用户真实情况。\n每周小组例会后，主持人手动整理文字纪要，核对负责人和截止日期。首版只本人使用，数据保存在 WANX，不自动发送消息、不自动召集会议。缺少负责人和期限可以先标为待补，AI结果需核对后保存。'
                data=text.encode();file_id=uuid4().hex
                storage.upload_create('','【合成资料】会议工作背景.md',len(data),file_id)
                storage.upload_chunk(file_id,0,data,sha256(data).hexdigest());storage.upload_complete(file_id,sha256(data).hexdigest())
        if args.control_fd is not None:
            import os
            with os.fdopen(args.control_fd,'w') as pipe:
                pipe.write(json.dumps({'baseURL':f'http://127.0.0.1:{args.port}','token':token,'workspaceFixtureId':workspace_fixture_id,'fixtureId':fixture_id}))
        print(json.dumps({'ready':True,'port':args.port,'instance':'studio-isolated','modelAvailable':service.model is not None}),flush=True)
        await uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=args.port,log_level='warning',access_log=False)).serve()
    finally:
        if 'service' in locals():
            await service.close()
        await server.stop()


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--seed-build-engine',action='store_true')
    parser.add_argument('--seed-versions',action='store_true')
    parser.add_argument('--seed-background',action='store_true')
    parser.add_argument('--root',required=True)
    parser.add_argument('--port',type=int,default=5189)
    parser.add_argument('--catalog')
    parser.add_argument('--control-fd',type=int)
    parser.add_argument('--seed-workspace',action='store_true')
    parser.add_argument('--seed-fixture',action='store_true')
    asyncio.run(main(parser.parse_args()))
