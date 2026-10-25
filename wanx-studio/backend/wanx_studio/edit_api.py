"""Private conversation-edit protocol; legacy public contracts are unchanged."""
from fastapi import Depends, Query
from pydantic import Field
from .contracts import Operation
from .visual_review import VisualReview


class Submit(Operation):
    expectedRevision: int = Field(ge=0)
    baseHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    text: str = Field(min_length=1,max_length=8000)
    explicitBase: bool = False
    visualReview: VisualReview | None = None
    contextId: str = Field(default='',max_length=80)


class Context(Operation):
    contextId: str = Field(default='',max_length=80)


class Retry(Context):
    visualReview: VisualReview | None = None


class Answer(Context):
    text: str = Field(min_length=1,max_length=8000)
    questionHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    visualReview: VisualReview | None = None


def mount_edits(router,svc,identity):
    from .api import RestoreVersion

    @router.post('/_builder/projects/{pid}/restore-version',include_in_schema=False)
    async def restore_trial(pid:str,body:RestoreVersion,owner=Depends(identity)):
        svc.edits.get(owner,pid)
        return svc.versions.restore(owner,pid,body.model_dump(),trial=True)

    @router.get('/_builder/projects/{pid}/edits',include_in_schema=False)
    async def read(pid:str,contextId:str=Query(default='',max_length=80),owner=Depends(identity)):
        return await svc.edits.read(owner,pid,contextId)

    @router.post('/_builder/projects/{pid}/edits',include_in_schema=False)
    async def submit(pid:str,body:Submit,owner=Depends(identity)):
        return await svc.edits.submit(owner,pid,body.model_dump(exclude_none=True))

    @router.post('/_builder/projects/{pid}/edits/heartbeat',include_in_schema=False)
    async def heartbeat(pid:str,body:Context,owner=Depends(identity)):
        return svc.edits.heartbeat(owner,pid,body.contextId)

    @router.post('/_builder/projects/{pid}/edits/stop',include_in_schema=False)
    async def stop_context(pid:str,body:Context,owner=Depends(identity)):
        return await svc.edits.stop_context(owner,pid,body.contextId)

    @router.post('/_builder/projects/{pid}/edits/{eid}/answer',include_in_schema=False)
    async def answer(pid:str,eid:str,body:Answer,owner=Depends(identity)):
        return await svc.edits.answer(owner,pid,eid,body.model_dump())

    @router.post('/_builder/projects/{pid}/edits/{eid}/retry',include_in_schema=False)
    async def retry(pid:str,eid:str,body:Retry,owner=Depends(identity)):
        return await svc.edits.retry(owner,pid,eid,body.model_dump())

    @router.post('/_builder/projects/{pid}/edits/{eid}/stop',include_in_schema=False)
    async def stop(pid:str,eid:str,body:Context,owner=Depends(identity)):
        return await svc.edits.stop(owner,pid,eid,body.contextId or None)
