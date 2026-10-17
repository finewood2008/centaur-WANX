"""Authenticated WANX multi-model dialogue. Transport adapters only."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.dialogue.contracts import DialogueError, event
from octop.infra.dialogue.service import DialogueService, Owner
from octop.infra.users.identity import User

router = APIRouter()


class Operation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{16,80}$")


class Question(Operation):
    prompt: str = Field(min_length=1, max_length=16000)
    models: list[str] = Field(min_length=1, max_length=3)


class AddModels(Operation):
    models: list[str] = Field(min_length=1, max_length=3)


class FollowUp(Operation):
    prompt: str = Field(min_length=1, max_length=16000)


def owner(user: User = Depends(current_user)) -> Owner:
    if user.application_id != "wanx":
        raise HTTPException(403, detail={"code": "FORBIDDEN"})
    return user.id, "dialogue"


def service(request: Request, server: Any = Depends(get_server)) -> DialogueService:
    value: DialogueService | None = getattr(request.app.state, "dialogue_service", None)
    if value is None:
        value = DialogueService(server.services)
        request.app.state.dialogue_service = value
    return value


Svc = Annotated[DialogueService, Depends(service)]
Who = Annotated[Owner, Depends(owner)]


@router.get("/models", summary="List public models available to this account")
async def models(svc: Svc, who: Who) -> dict[str, Any]:
    return {"models": await svc.models(who)}


@router.get("/quota", summary="Get platform-enforced budget and pending usage")
async def quota(svc: Svc, who: Who) -> dict[str, Any]:
    return await svc.remote(who, "/quota")


@router.get("/sessions", summary="List this account's dialogue history")
async def sessions(svc: Svc, who: Who) -> dict[str, Any]:
    return {"sessions": await svc.list_sessions(who)}


@router.post("/sessions", summary="Ask one question of one to three independent models")
async def create(body: Question, svc: Svc, who: Who) -> dict[str, Any]:
    if not body.prompt.strip():
        raise DialogueError("EMPTY_PROMPT")
    return await svc.create(who, body.request_id, body.prompt, body.models)


@router.get("/sessions/{session_id}", summary="Read a dialogue and its independent branches")
async def get(session_id: str, svc: Svc, who: Who) -> dict[str, Any]:
    return await svc.get(who, session_id)


@router.delete(
    "/sessions/{session_id}", summary="Stop active answers and delete local dialogue history"
)
async def delete(session_id: str, svc: Svc, who: Who) -> dict[str, bool]:
    await svc.delete(who, session_id)
    return {"deleted": True}


@router.post(
    "/sessions/{session_id}/groups/{group_id}/answers",
    summary="Add models using the original context snapshot",
)
async def add(
    session_id: str, group_id: str, body: AddModels, svc: Svc, who: Who
) -> dict[str, Any]:
    return await svc.mutate(
        who, session_id, body.request_id, "add", {"group_id": group_id, "models": body.models}
    )


@router.post(
    "/sessions/{session_id}/answers/{answer_id}/continue",
    summary="Continue only the selected answer's branch",
)
async def follow_up(
    session_id: str, answer_id: str, body: FollowUp, svc: Svc, who: Who
) -> dict[str, Any]:
    if not body.prompt.strip():
        raise DialogueError("EMPTY_PROMPT")
    return await svc.mutate(
        who,
        session_id,
        body.request_id,
        "continue",
        {"answer_id": answer_id, "prompt": body.prompt},
    )


@router.post(
    "/sessions/{session_id}/answers/{answer_id}/retry",
    summary="Explicitly generate a new answer; duplicate request ids do not dispatch twice",
)
async def retry(
    session_id: str, answer_id: str, body: Operation, svc: Svc, who: Who
) -> dict[str, Any]:
    return await svc.mutate(who, session_id, body.request_id, "retry", {"answer_id": answer_id})


@router.post(
    "/sessions/{session_id}/answers/{answer_id}/stop",
    summary="Stop this answer; usage already incurred may remain pending",
)
async def stop(session_id: str, answer_id: str, svc: Svc, who: Who) -> dict[str, Any]:
    return await svc.stop(who, session_id, answer_id)


@router.get(
    "/sessions/{session_id}/events",
    summary="Reconnectable snapshots; reading never generates or charges again",
)
async def events(session_id: str, svc: Svc, who: Who) -> StreamingResponse:
    await svc.get(who, session_id)

    async def stream() -> AsyncIterator[str]:
        async for snapshot in svc.events(who, session_id):
            yield event(snapshot)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
