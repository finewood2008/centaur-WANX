from __future__ import annotations

import asyncio
from .local_authority import to_thread
import json
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import Field

from .contracts import Input, Operation, Solution, StudioError, digest, has_credentials
from .service import StudioService
from .store import public


class Create(Operation):
    name: str = Field(min_length=1,max_length=80)
    goal: str = Field(min_length=1,max_length=12000)
    intake: bool = False

class Metadata(Operation):
    action: Literal["rename","auto-name","delete","restore"]
    name: str = Field(default="",max_length=80)

class Chat(Operation):
    text: str = Field(min_length=1,max_length=8000)

class UpdateSolution(Operation):
    expectedHash: str
    solution: Solution

class Confirm(Operation):
    solutionHash: str
    reviewedSections: list[str] = Field(default_factory=list,max_length=7)

class Decision(Confirm):
    dependencyId: str
    choice: Literal['manual','defer','discuss']
    detail: str = Field(default='',max_length=4000)

class Build(Operation):
    solutionHash: str
    instruction: str = Field(default='',max_length=8000)

class Accept(Operation):
    artifactHash: str
    criteria: list[int]
    confirmedByUser: Literal[True]

class VersionOperation(Operation):
    expectedRevision: int = Field(ge=0)

class IterationOperation(VersionOperation):
    action: Literal['begin','abandon']
    baseHash: str | None = Field(default=None,pattern=r'^[a-f0-9]{64}$')
    goal: str = Field(default='',max_length=8000)

class Feedback(VersionOperation):
    text: str = Field(max_length=8000)

class Adopt(VersionOperation):
    artifactHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirmedByUser: Literal[True]

class RestoreVersion(Adopt):
    checkHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    comparisonHash: str | None = Field(default=None,pattern=r'^[a-f0-9]{64}$')

class Installed(Operation):
    artifactHash: str
    applicationId: str
    version: str

class Runtime(Input):
    artifactHash: str
    environment: Literal['preview','production'] = 'preview'

class Invoke(Input):
    method: str
    params: dict[str,Any] = Field(default_factory=dict)

class EngineSelection(Input):
    engineId: str = Field(pattern=r'^[a-z][a-z0-9_-]{0,63}$')

class EngineBinding(EngineSelection,Operation):
    expectedFingerprint: str | None = None

class IntakeText(Operation):
    text: str = Field(min_length=1,max_length=12000)

class InterviewTurn(Operation):
    text: str = Field(default='',max_length=12000)

class ContextSelection(Operation):
    expectedRevision: int
    references: list[dict[str,Any]]

class ContextRead(Input):
    ref: str
    offset: int = 0
    limit: int = 12000

class ContextSearch(Input):
    query: str = Field(min_length=1,max_length=1000)

class CapabilityCheck(Operation):
    capabilityIds: list[str] | None = None

class CapabilityDecision(Operation):
    gapId: str
    detail: str = Field(min_length=1,max_length=1000)

class Handoff(Operation):
    expectedRevision: int

class SelectFiles(Input):
    ids: list[str] = Field(max_length=10)


def create_router(svc: StudioService, identity, *, local_preview=False):
    router=APIRouter(prefix='/api/app-studio',tags=['Application studio'])
    from .iterative import mount
    mount(router,svc,identity)
    from .delivery import mount as mount_delivery
    mount_delivery(router, svc, identity)

    @router.get('/context',summary='Read authenticated studio context and capabilities')
    async def context(owner=Depends(identity)):
        return {'protocolVersion':2,'mode':'local-preview' if local_preview else 'wanx','scopeId':digest({'owner':owner,'instance':str(svc.store.root.resolve())}), 'ownerLabel':'隔离验证用户' if local_preview else '万象用户','modelAvailable':bool(svc.model),'filesAvailable':svc.files is not None,'capabilities':['data','model','files',*(['reports'] if getattr(svc,'team',None) else [])],'features':{'taskPreparation':1,'codexInterview':1,'productVersions':1,'continuousWorkspace':1,'engines':1,**({'teamPublishing':1} if getattr(svc,'team',None) else {})}}

    @router.get('/engines')
    async def engines(owner=Depends(identity)):
        return svc.engines.list(owner)

    @router.put('/engines/default')
    async def engine_default(body:EngineSelection,owner=Depends(identity)):
        return svc.engines.select(owner,body.engineId)

    @router.post('/engines/check')
    async def engine_check(body:EngineSelection,owner=Depends(identity)):
        return await svc.engines.check(owner,body.engineId)

    @router.put('/projects/{project_id}/engine')
    async def engine_bind(project_id:str,body:EngineBinding,owner=Depends(identity)):
        from .versions import idle
        def change(p):
            idle(p)
            if p.get('engine',{}).get('fingerprint')!=body.expectedFingerprint:raise StudioError('ENGINE_CONFIGURATION_CHANGED',409)
            svc.engines.bind(owner,p,body.engineId)
            if p.get('preparation'):p['preparation']['report']=None
        return svc.store.mutate(owner,project_id,body.operationId,body.model_dump(),change)

    @router.get('/preflight',summary='Check native Codex app-server connectivity without model calls')
    async def preflight(owner=Depends(identity)):
        return {**await svc.runner.preflight(owner=owner),'maxExecutionSeconds':svc.runner.TASK_TIMEOUT_SECONDS}

    @router.get('/capabilities',summary='Read the fixed versioned runtime capability catalog')
    async def capabilities(owner=Depends(identity)):
        from .preparation import CATALOG,CONTRACT_VERSION
        return {'version':CONTRACT_VERSION,'items':[{'id':key,**value} for key,value in CATALOG.items()]}

    @router.get('/context/sources',summary='Metadata only; no source content or model call')
    async def context_sources(kind:str,parent:str='',owner=Depends(identity)):
        return await svc.preparation.sources(owner,kind,parent)

    @router.get('/projects/{project_id}/intake')
    async def intake_state(project_id:str,owner=Depends(identity)):
        return svc.preparation.state(owner,project_id)

    @router.post('/projects/{project_id}/intake')
    async def intake_send(project_id:str,body:IntakeText,owner=Depends(identity)):
        return await svc.preparation.intake(owner,project_id,body.model_dump())

    @router.get('/projects/{project_id}/context')
    async def context_state(project_id:str,owner=Depends(identity)):
        x=svc.preparation.get(owner,project_id)['preparation']
        return {'references':x['references'],'revision':x['contextRevision']}

    @router.put('/projects/{project_id}/context')
    async def select_context(project_id:str,body:ContextSelection,owner=Depends(identity)):
        return await svc.preparation.set_context(owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/context/read')
    async def read_context(project_id:str,body:ContextRead,owner=Depends(identity)):
        return await svc.preparation.read_context(owner,project_id,body.ref,body.offset,body.limit)

    @router.post('/projects/{project_id}/context/search')
    async def search_context(project_id:str,body:ContextSearch,owner=Depends(identity)):
        return await svc.preparation.search_context(owner,project_id,body.query)

    @router.get('/projects/{project_id}/capabilities')
    async def capability_state(project_id:str,owner=Depends(identity)):
        p=svc.preparation.get(owner,project_id)
        return {'required':svc.preparation.required(p,development=p['preparation']['phase']=='acp'),'gaps':svc.preparation.gaps(p),'gapChoices':[{'id':digest(g),'requirement':g} for g in svc.preparation.gaps(p)],'report':p['preparation']['report'],'valid':svc.preparation.valid_report(owner,p,development=p['preparation']['phase']=='acp')}

    @router.post('/projects/{project_id}/capabilities/decisions')
    async def capability_decision(project_id:str,body:CapabilityDecision,owner=Depends(identity)):
        return svc.preparation.defer_gap(owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/capabilities/check')
    async def capability_check(project_id:str,body:CapabilityCheck,owner=Depends(identity)):
        return await svc.preparation.check(owner,project_id,body.model_dump(exclude_none=True))

    @router.post('/projects/{project_id}/intake/handoff')
    async def handoff(project_id:str,body:Handoff,owner=Depends(identity)):
        return await svc.preparation.handoff(owner,project_id,body.model_dump())

    @router.get('/projects/{project_id}/interview')
    async def interview_state(project_id:str,owner=Depends(identity)):
        return svc.preparation.state(owner,project_id)

    @router.post('/projects/{project_id}/interview/turns')
    async def interview_turn(project_id:str,body:InterviewTurn,owner=Depends(identity)):
        return await svc.preparation.pm.start(owner,project_id,body.model_dump())

    @router.get('/projects/{project_id}/interview/events')
    @router.get('/projects/{project_id}/intake/events')
    async def preparation_events(project_id:str,after:int=0,owner=Depends(identity)):
        return svc.preparation.events(owner,project_id,after)

    @router.get('/projects',summary='List your development projects')
    async def projects(includeDeleted:bool=False,owner=Depends(identity)):
        return {'projects':await to_thread(svc.list_projects,owner,includeDeleted)}

    @router.post('/projects',summary='Create a private project idempotently')
    async def create(body:Create,owner=Depends(identity)):
        if body.intake and has_credentials(body.goal):raise StudioError('INPUT_CREDENTIAL_DETECTED')
        p=await to_thread(svc.store.create,owner,body.name,body.goal,body.operationId)
        return svc.preparation.enable(owner,p['id']) if body.intake else p

    @router.put('/projects/{project_id}/metadata',summary='Rename or reversibly remove an owned project without changing its PRD')
    async def metadata(project_id:str,body:Metadata,owner=Depends(identity)):
        return await svc.change_project_metadata(owner,project_id,body.model_dump())

    @router.get('/projects/{project_id}',summary='Restore a project and its version-bound state')
    async def get(project_id:str,owner=Depends(identity)):
        result=await to_thread(svc.snapshot,owner,project_id)
        if not svc.edits.enabled(svc.store.get(owner,project_id)) or svc.edits.contexts.get((owner,project_id),('',''))[1].startswith('legacy:'):svc.runner.touch(owner,project_id)
        return result

    @router.post('/projects/{project_id}/chat',summary='Save a user fact and request the next interview turn')
    async def chat(project_id:str,body:Chat,owner=Depends(identity)):
        return await svc.chat(owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/interview/start',summary='Begin heuristic discovery without duplicating the original user goal')
    async def interview_start(project_id:str,body:Operation,owner=Depends(identity)):
        return await svc.start_discovery(owner,project_id,body.model_dump())

    @router.put('/projects/{project_id}/solution',summary='Save an explicit user revision; invalidate previous confirmation')
    async def solution(project_id:str,body:UpdateSolution,owner=Depends(identity)):
        return await to_thread(svc.update_solution,owner,project_id,body.model_dump(exclude_none=True))

    @router.post('/projects/{project_id}/decisions',summary='Record a user decision about one unsupported dependency')
    async def decision(project_id:str,body:Decision,owner=Depends(identity)):
        return await to_thread(svc.decide,owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/confirm',summary='Freeze the current solution after dependency decisions')
    async def confirm(project_id:str,body:Confirm,owner=Depends(identity)):
        await svc.preparation.guard_async(owner,svc.store.get(owner,project_id),development=True)
        return await to_thread(svc.confirm,owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/build',summary='Start Codex against the exact confirmed version')
    async def build(project_id:str,body:Build,owner=Depends(identity)):
        return await svc.runner.start(owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/tasks/{task_id}/cancel',summary='Cancel a task and revoke its proxy')
    async def cancel(project_id:str,task_id:str,body:Operation,owner=Depends(identity)):
        return await svc.runner.cancel(owner,project_id,task_id,body.operationId)

    @router.get('/projects/{project_id}/tasks/{task_id}/events',summary='Read the complete ordered development history, including earlier pages')
    async def task_events(project_id:str,task_id:str,after:int=0,limit:int=100,owner=Depends(identity)):
        return await to_thread(svc.store.task_events,owner,project_id,task_id,after,limit)

    @router.post('/projects/{project_id}/tasks/{task_id}/terminal/{operation}',summary='Reject terminal input, paste, keys and other control operations')
    async def readonly_terminal(project_id:str,task_id:str,operation:str,owner=Depends(identity)):
        await to_thread(svc.store.task_events,owner,project_id,task_id,0,1)
        raise StudioError('TERMINAL_READ_ONLY',403)

    @router.get('/projects/{project_id}/versions')
    async def versions(project_id:str,owner=Depends(identity)):
        return await to_thread(svc.versions.read,owner,project_id)

    @router.get('/projects/{project_id}/versions/{artifact_hash}')
    async def version(project_id:str,artifact_hash:str,owner=Depends(identity)):
        return await to_thread(svc.versions.read,owner,project_id,artifact_hash)

    @router.put('/projects/{project_id}/feedback')
    async def feedback(project_id:str,body:Feedback,owner=Depends(identity)):
        return await to_thread(svc.versions.feedback,owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/iterations')
    async def iteration(project_id:str,body:IterationOperation,owner=Depends(identity)):
        return await to_thread(svc.versions.iteration,owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/adopt')
    async def adopt(project_id:str,body:Adopt,owner=Depends(identity)):
        await svc.versions.authorize(owner,project_id,body.artifactHash)
        return await to_thread(svc.versions.adopt,owner,project_id,body.model_dump())

    @router.get('/projects/{project_id}/versions/{artifact_hash}/restore-check')
    async def restore_check(project_id:str,artifact_hash:str,comparisonHash:str | None=Query(default=None,pattern=r'^[a-f0-9]{64}$'),owner=Depends(identity)):
        await svc.versions.authorize(owner,project_id,artifact_hash)
        return await to_thread(svc.versions.restore_check,owner,project_id,artifact_hash,comparisonHash)

    @router.post('/projects/{project_id}/restore-version')
    async def restore_version(project_id:str,body:RestoreVersion,owner=Depends(identity)):
        await svc.versions.authorize(owner,project_id,body.artifactHash)
        return await to_thread(svc.versions.restore,owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/accept',summary='Record the owner acceptance for every criterion of this artifact')
    async def accept(project_id:str,body:Accept,owner=Depends(identity)):
        return await to_thread(svc.accept,owner,project_id,body.model_dump())

    @router.get('/projects/{project_id}/install/{artifact_hash}',summary='Obtain an accepted data-free artifact for the trusted Host installer')
    async def install(project_id:str,artifact_hash:str,owner=Depends(identity)):
        if not getattr(svc,'team',None) or svc.team.is_admin(owner):
            if 'versioning' in svc.store.get(owner,project_id):await svc.versions.authorize(owner,project_id,artifact_hash)
        return await to_thread(svc.install_payload,owner,project_id,artifact_hash)

    @router.post('/projects/{project_id}/installed',summary='Commit a matching Host installation receipt')
    async def installed(project_id:str,body:Installed,owner=Depends(identity)):
        return await to_thread(svc.installed,owner,project_id,body.model_dump())

    @router.post('/projects/{project_id}/runtime',summary='Create a short-lived runtime bound to your app and environment')
    async def runtime(project_id:str,body:Runtime,owner=Depends(identity)):
        return svc.open_runtime(owner,project_id,body.artifactHash,body.environment)

    @router.post('/runtime/{session}/invoke',summary='Invoke a declared capability in the bound app namespace')
    async def invoke(session:str,body:Invoke,owner=Depends(identity)):
        return await svc.invoke(owner,session,body.method,body.params)

    @router.post('/apps/{app_id}/runtime',summary='Open an installed app by its portable application identity')
    async def installed_runtime(app_id:str,body:Runtime,owner=Depends(identity)):
        return svc.open_installed_runtime(owner,app_id,body.artifactHash,body.environment)

    @router.get('/apps/{app_id}',summary='Read metadata for one currently authorized company application')
    async def published_application(app_id:str,owner=Depends(identity)):
        team=getattr(svc,'team',None)
        if team is None:raise StudioError('TEAM_APPLICATION_UNAVAILABLE',404)
        return {'project':team.summary(team.resolve(owner,app_id=app_id))}

    @router.get('/apps/{app_id}/install',summary='Read the sealed package for one authorized company application')
    async def published_install(app_id:str,owner=Depends(identity)):
        team=getattr(svc,'team',None)
        if team is None:raise StudioError('TEAM_APPLICATION_UNAVAILABLE',404)
        publication=team.resolve(owner,app_id=app_id)
        return team.payload(owner,publication['project'],publication['artifact'])

    @router.post('/runtime/{session}/files',summary='Explicitly select owner-controlled text files for this runtime')
    async def select(session:str,body:SelectFiles,owner=Depends(identity)):
        return await svc.select_files(owner,session,body.ids)

    @router.delete('/runtime/{session}',summary='Revoke this runtime session')
    async def revoke(session:str,owner=Depends(identity)):
        svc.runtime(owner,session)
        del svc.runtime_sessions[session]
        return {'revoked':True}

    @router.get('/projects/{project_id}/events',summary='Subscribe to state changes without replaying model calls')
    async def events(project_id:str,request:Request,owner=Depends(identity)):
        svc.store.get(owner,project_id)
        async def stream():
            last=''
            while not await request.is_disconnected():
                p=svc.snapshot(owner,project_id)
                current=digest(p)
                if current!=last:
                    yield 'data: '+json.dumps(p,ensure_ascii=False)+'\n\n'
                    last=current
                await asyncio.sleep(1)
        return StreamingResponse(stream(),media_type='text/event-stream',headers={'Cache-Control':'no-store'})

    if local_preview:
        @router.post('/projects/{project_id}/example',summary='Load the explicitly labelled fixed ledger example; never claims a DSH build')
        async def example(project_id:str,body:Operation,owner=Depends(identity)):
            return await svc.runner.example(owner,project_id,body.operationId)
    from .client_launch import mount_client_launch
    mount_client_launch(router, svc, identity)
    from .edit_api import mount_edits
    mount_edits(router,svc,identity)
    return router
