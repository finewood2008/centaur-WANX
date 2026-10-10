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
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter()


class Generate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=100)


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    excluded: list[str] = Field(default_factory=list, max_length=100)


def registry_for(server: Any, user: Any, agent_id: str) -> Any:
    registry = server.app_runtime.agent_registry
    row = registry.get_row(agent_id)
    if row is None or row.user_id != user.id or row.is_shared:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    assert_same_application(row, user)
    return registry


def owned_thread(server: Any, user: Any, agent_id: str, tid: str) -> None:
    thread = server.app_runtime.gateway.thread_registry.get_thread(tid)
    if thread is None or thread.agent_id != agent_id or thread.user_id != user.id:
        raise OctopError.localized(ErrorCode.NOT_FOUND)


@router.get("/{agent_id}/ontology", summary="Read the private role ontology")
async def get_ontology(
    agent_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> PersonalOntology:
    registry = registry_for(server, user, agent_id)
    with agent_scope(registry, user.id, agent_id):
        return await read_role_ontology(registry, user.id)


@router.post(
    "/{agent_id}/ontology/generate", summary="Generate ontology candidates from role memory"
)
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


@router.post("/{agent_id}/ontology/nodes/{node_id}", summary="Review or edit a role ontology node")
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


@router.get("/{agent_id}/ontology/facts", summary="List memory facts for owner confirmation")
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
    summary="Read or configure ontology context for a conversation",
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
    return dict(json.loads(raw)) if raw else {"claims": [], "supplied_at": ""}


@router.put(
    "/{agent_id}/ontology/context/{thread_id}",
    summary="Read or configure ontology context for a conversation",
)
async def preferences(
    agent_id: str,
    thread_id: str,
    body: Preferences,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, bool]:
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
