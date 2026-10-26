"""Trusted integration, loaded in WANX only. Credentials never leave this process."""
from __future__ import annotations

import asyncio
from .local_authority import to_thread
import json
from dataclasses import replace
from pathlib import Path

from fastapi import Depends, Request
from fastapi.responses import JSONResponse

from .api import create_router
from .contracts import StudioError, TEXT_EXTENSIONS
from .runner import Runner
from .service import StudioService


def output_budget(body,model):
    # The interview needs room for a full seven-part PRD. Generated apps still
    # request 4096 and other callers retain the 8192 default.
    limit=model.max_output_tokens
    return min(body.get('max_tokens',8192),limit if limit>0 else 32768,32768)


class WanxModels:
    def __init__(self, services):
        self.services=services
        self.selection=services.settings_repo.get_active_model()
        self.info=self.resolve()

    def __bool__(self):
        # Default model configuration may be completed after server startup.
        return self.resolve() is not None

    def resolve(self):
        from octop.infra.agents.providers.store import ProviderStore
        self.selection=self.services.settings_repo.get_active_model()
        name,model_id=self.selection
        providers=ProviderStore(self.services.provider_repo).build_harness_configs()
        for provider in providers:
            if provider.id==name:
                for model in provider.models:
                    if model.id==model_id:
                        return provider,model
        return None

    def fingerprint(self):
        from .contracts import digest
        selected=self.resolve()
        if not selected:return 'unconfigured'
        provider,model=selected
        row=self.services.provider_repo.get_by_name(self.selection[0])
        return digest([self.selection,provider.id,getattr(provider,'base_url',None),model.id,model.max_output_tokens,getattr(row,'updated_at',None)])

    async def __call__(self, owner, body):
        from langchain_core.messages import SystemMessage,HumanMessage,AIMessage,ToolMessage
        from octop_harness.llm.factory import build_chat_model
        from octop_harness.llm.session_header import aclose_session_http_clients
        selected=await to_thread(self.resolve)
        if not selected:
            raise StudioError('MODEL_NOT_CONFIGURED',409)
        provider,model=selected
        if set(body)-{'messages','tools','max_tokens','tool_choice'} or len(json.dumps(body).encode())>200000:
            raise StudioError('MODEL_INPUT_INVALID',413)
        messages=[]
        for m in body.get('messages',[]):
            text=m.get('content') or ''
            if not isinstance(text,str):
                raise StudioError('MODEL_INPUT_INVALID')
            if m['role']=='system':
                messages.append(SystemMessage(content=text))
            elif m['role']=='user':
                messages.append(HumanMessage(content=text))
            elif m['role']=='tool':
                messages.append(ToolMessage(content=text,tool_call_id=m['tool_call_id']))
            elif m['role']=='assistant':
                calls=[{'id':t['id'],'name':t['function']['name'],'args':json.loads(t['function']['arguments'])} for t in m.get('tool_calls',[])]
                messages.append(AIMessage(content=text,tool_calls=calls,additional_kwargs={'reasoning_content':m['reasoning_content']} if m.get('reasoning_content') else {}))
            else:
                raise StudioError('MODEL_INPUT_INVALID')
        llm=build_chat_model(provider,replace(model,native_tool_search=False))
        try:
            # No implicit provider/SDK retry can consume an uncounted request.
            llm.max_retries=0
            for attribute in ('root_client','root_async_client','client','async_client'):
                client=getattr(llm,attribute,None)
                if client is not None and hasattr(client,'max_retries'):
                    client.max_retries=0
                underlying=getattr(client,'_client',None)
                if underlying is not None and hasattr(underlying,'max_retries'):
                    underlying.max_retries=0
            if body.get('tools'):
                allowed={'read_material','list_sources','read_source','write_source','validate_app','ask_product'}
                if any(t.get('function',{}).get('name') not in allowed for t in body['tools']):
                    raise StudioError('MODEL_TOOL_DENIED',403)
                runnable=llm.bind_tools(body['tools'])
            else:
                runnable=llm
            result=await asyncio.wait_for(runnable.ainvoke(messages,max_tokens=output_budget(body,model)),180)
            text=result.content if isinstance(result.content,str) else ''.join(str(c.get('text','')) for c in result.content if isinstance(c,dict))
            calls=[{'id':t['id'],'type':'function','function':{'name':t['name'],'arguments':json.dumps(t['args'],ensure_ascii=False)}} for t in result.tool_calls]
            message={'role':'assistant','content':text,**({'tool_calls':calls} if calls else {})}
            if result.additional_kwargs.get('reasoning_content'):
                message['reasoning_content']=result.additional_kwargs['reasoning_content']
            usage=result.usage_metadata
            return {'model':model.id,'choices':[{'message':message,'finish_reason':'tool_calls' if calls else result.response_metadata.get('finish_reason','stop')}],
                    'usage':{'prompt_tokens':usage.get('input_tokens',0),'completion_tokens':usage.get('output_tokens',0)} if usage else None}
        except StudioError:
            raise
        except Exception:
            # Upstream errors may contain keys, addresses or request bodies.
            raise StudioError('MODEL_UPSTREAM_FAILED',502) from None
        finally:
            await aclose_session_http_clients(llm)


def mount_wanx(app,server,project_root:Path,*,catalog_services=None):
    from octop.api.deps import current_user
    from octop.infra.personal_space.service import PersonalSpace
    models=WanxModels(catalog_services or server.services)
    def space(owner):
        return PersonalSpace(server.paths.root/'.wanx-personal-space',int(owner.removeprefix('wanx:')))

    async def files(owner,ids):
        await service.local_authority.resources(owner,[{'resourceId':'wanx','actions':['read']}])
        def read():
            storage=space(owner)
            result=[]
            for item_id in ids:
                meta=storage.metadata(item_id)
                if meta['kind']!='file' or Path(meta['name']).suffix.lower() not in TEXT_EXTENSIONS:
                    raise StudioError('FILE_TYPE_UNSUPPORTED')
                if meta['size']>262144:
                    raise StudioError('FILE_TOO_LARGE',413)
                data,_=storage.read_chunk(item_id,0,max(meta['size'],1))
                try:
                    text=data.decode('utf-8-sig')
                except UnicodeError:
                    raise StudioError('FILE_NOT_UTF8') from None
                result.append({'id':item_id,'name':meta['name'],'text':text})
            return result
        return await to_thread(read)

    service=getattr(server,'_wanx_studio_service',None)
    if service is None or getattr(service,'closing',False):
        service=StudioService(server.paths.root/'.wanx-app-studio',project_root,models,files)
        server._wanx_studio_service=service
    service.runner=Runner(service)
    service.engines.provider=lambda owner:server.app_runtime.agent_registry.acp_settings.load_runners(int(owner.split(":",1)[1]))
    from .context_sources import WanxContextSources
    from .team import TeamPublications
    from .local_authority import LocalStudioAuthority
    service.local_authority=LocalStudioAuthority(server.services,lambda:bool(getattr(app.state,'local_data_required',False)))
    service.context_provider=WanxContextSources(server,space,files,service.local_authority)
    service.team=TeamPublications(service,server.services,local_authority=service.local_authority)

    async def identity(request:Request,user=Depends(current_user)):
        import re
        if user.application_id!='wanx' and not (service.local_authority.required() and re.fullmatch(r'ai\.wanx\.selfmade\.[a-f0-9]{32}',user.application_id)):
            raise StudioError('STUDIO_IDENTITY_FORBIDDEN',403)
        owner='wanx:'+str(user.id)
        token=service.local_authority.enter(user)
        try:
            service.team.user(owner)
            if not service.team.is_admin(owner):
                import re
                path=request.url.path.removeprefix('/api/app-studio')
                allowed=(request.method=='GET' and (path in {'/context','/projects'} or re.fullmatch(r'/projects/[a-f0-9]{32}/install/[a-f0-9]{64}',path) or re.fullmatch(r'/apps/ai\.wanx\.selfmade\.[a-f0-9]{32}(?:/install)?',path))) or (request.method=='POST' and (re.fullmatch(r'/apps/[a-z][a-z0-9.-]*/runtime',path) or re.fullmatch(r'/runtime/[A-Za-z0-9_-]+/(invoke|files)',path))) or (request.method=='DELETE' and re.fullmatch(r'/runtime/[A-Za-z0-9_-]+',path))
                if not allowed:raise StudioError('STUDIO_ADMIN_REQUIRED',403)
                if service.local_authority.required() and request.method=='GET' and path in {'/context','/projects'}:
                    raise StudioError('STUDIO_ADMIN_REQUIRED',403)
            yield owner
        finally:
            service.local_authority.reset(token)

    router=create_router(service,identity)

    @router.get('/files',summary='List owner file metadata for the trusted text-file picker')
    async def list_files(parent:str='',owner=Depends(identity)):
        await service.local_authority.resources(owner,[{'resourceId':'wanx','actions':['read']}])
        return await to_thread(space(owner).listing,parent,False)

    @app.exception_handler(StudioError)
    async def failure(_request,error):
        return JSONResponse({'code':error.code},error.status)

    app.include_router(router)
    app.state.app_studio=service
    return service
