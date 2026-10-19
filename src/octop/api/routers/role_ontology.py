"""Private-agent ontology routes; no admin bypass or browser-supplied owner."""

import json
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.agents.application import assert_same_application
from octop.infra.agents.ontology_types import OntologyResult, PersonalOntology
from octop.infra.agents.personal_ontology import _digest, generate_personal_ontology
from octop.infra.agents.role_ontology import (
    RoleCommand,
    agent_scope,
    command,
    facts,
    read_role_ontology,
)
from octop.infra.agents.zhijun_changes import (
    ChangeCommand,
    ChangeResult,
    ChangeView,
    pending_changes,
    resolve_change,
)
from octop.infra.agents.zhijun_interview import (
    InterviewCommand,
    InterviewView,
    read_interview,
    update_interview,
)
from octop.infra.agents.zhijun_profile import primary
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter()


class Generate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=100)


class Prepare(BaseModel):
    model_config = ConfigDict(extra="forbid")
    retry: bool = False


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    excluded: list[str] = Field(default_factory=list, max_length=100)


def registry_for(server: Any, user: Any, agent_id: str) -> Any:
    registry = server.app_runtime.agent_registry
    row = registry.get_row(agent_id)
    if row is None or row.user_id != user.id or not primary(row):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    assert_same_application(row, user)
    return registry


def owned_thread(server: Any, user: Any, agent_id: str, tid: str) -> None:
    thread = server.app_runtime.gateway.thread_registry.get_thread(tid)
    if thread is None or thread.agent_id != agent_id or thread.user_id != user.id:
        raise OctopError.localized(ErrorCode.NOT_FOUND)


@router.get("/{agent_id}/ontology", summary="Read private role ontology")
async def get_ontology(
    agent_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> PersonalOntology:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        return await read_role_ontology(registry, user.id)


@router.post("/{agent_id}/ontology/prepare", summary="Prepare ontology candidates for owner review")
async def prepare(
    agent_id: str,
    body: Prepare,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> PersonalOntology:
    registry = registry_for(server, user, agent_id)
    from octop.infra.agents.role_ontology_flow import request_preparation

    await request_preparation(registry, user.id, agent_id, retry=body.retry)
    with agent_scope(registry, user.id, agent_id):
        return await read_role_ontology(registry, user.id)


@router.post("/{agent_id}/ontology/generate", summary="Generate private role ontology candidates")
async def generate(
    agent_id: str,
    body: Generate,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> OntologyResult:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        result = await generate_personal_ontology(registry, user.id, body.revision)
        result.ontology = await read_role_ontology(registry, user.id)
        return result


@router.post("/{agent_id}/ontology/nodes/{node_id}", summary="Apply owner ontology decision")
async def edit(
    agent_id: str,
    node_id: str,
    body: RoleCommand,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        return await command(registry, user.id, node_id, body)


@router.get("/{agent_id}/ontology/facts", summary="List current role evidence")
async def get_facts(
    agent_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        return await facts(registry, user.id, offset, limit)


@router.get(
    "/{agent_id}/ontology/context/{thread_id}",
    summary="Read ontology context used in a conversation",
)
async def context(
    agent_id: str,
    thread_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    registry = registry_for(server, user, agent_id)
    owned_thread(server, user, agent_id, thread_id)
    raw = await registry.get_agent(agent_id).workspace.aread_text(
        "zhijun/role-context/" + _digest(thread_id) + ".json"
    )
    data: dict[str, Any] = json.loads(raw) if raw else {"claims": [], "supplied_at": ""}
    from octop.infra.agents.ontology_admission import admitted, pending

    with agent_scope(registry, user.id, agent_id):
        doc = await read_role_ontology(registry, user.id)
    changes = pending_changes(doc)
    data["changes"] = changes
    changing = {c.proposed.id for c in changes}
    data["pending"] = [c for c in doc.claims if pending(c) and c.id not in changing][:4]
    data["flow"] = doc.flow
    # An old success receipt must not claim a withdrawn/edited item is still current.
    update = data.get("update") or {}
    if update.get("status") == "admitted" and not any(
        c.id == update.get("id") and admitted(c) and c.statement == update.get("statement")
        for c in doc.claims
    ):
        data["update"] = {
            "status": "changed",
            "message": "这次保存的理解后来已修改或停用，以理解中的当前状态为准。",
        }
    return data


@router.put(
    "/{agent_id}/ontology/context/{thread_id}",
    summary="Exclude ontology entries from conversation context",
)
async def preferences(
    agent_id: str,
    thread_id: str,
    body: Preferences,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    registry = registry_for(server, user, agent_id)
    owned_thread(server, user, agent_id, thread_id)
    with agent_scope(registry, user.id, agent_id):
        doc = await read_role_ontology(registry, user.id)
    if not set(body.excluded).issubset({c.id for c in doc.claims}):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    await registry.get_agent(agent_id).workspace.aupload_bytes(
        "zhijun/context-preferences/" + _digest(thread_id) + ".json",
        json.dumps({"excluded": body.excluded, "turn_id": ""}).encode(),
    )
    return {"ok": True}


@router.get("/{agent_id}/ontology/interview", summary="Read resumable Zhijun interview")
async def get_interview(
    agent_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> InterviewView:
    registry = registry_for(server, user, agent_id)
    return await read_interview(
        registry, server.app_runtime.gateway.thread_registry, user.id, agent_id
    )


@router.post(
    "/{agent_id}/ontology/interview", summary="Start, pause or continue an owner-led interview"
)
async def interview_action(
    agent_id: str,
    body: InterviewCommand,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> InterviewView:
    registry = registry_for(server, user, agent_id)
    return await update_interview(
        registry, server.app_runtime.gateway.thread_registry, user.id, agent_id, body
    )


@router.get(
    "/{agent_id}/ontology/changes", summary="Read source-bound changes awaiting owner review"
)
async def get_changes(
    agent_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> list[ChangeView]:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        return pending_changes(await read_role_ontology(registry, user.id))


@router.post(
    "/{agent_id}/ontology/changes/{relation_id}",
    summary="Confirm a change, scoped exception or mistaken interpretation",
    response_model=ChangeResult,
)
async def change_action(
    agent_id: str,
    relation_id: str,
    body: ChangeCommand,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        return await resolve_change(registry, user.id, relation_id, body)
