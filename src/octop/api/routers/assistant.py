"""First-party assistant binding; native chat remains the turn transport."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.i18n import tr
from octop.infra.agents.assistant_conversations import AssistantConversations, ConversationError
from octop.infra.agents.assistant_history import AssistantHistory
from octop.infra.agents.assistant_knowledge import (
    AssistantKnowledgeGrants,
    KnowledgeError,
    KnowledgeReader,
    KnowledgeSources,
)
from octop.infra.agents.assistant_profile import AssistantProfiles
from octop.infra.agents.assistant_space import AssistantSpaceGrants
from octop.infra.personal_space.service import SpaceError
from octop.infra.semantica.client import SemanticaError

router = APIRouter()


def conversations(request: Request, server: Any) -> AssistantConversations:
    service = getattr(request.app.state, "assistant_conversations", None)
    if service is None:
        service = AssistantConversations(server)
        request.app.state.assistant_conversations = service
    return service


class ConversationSpace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    selection: dict[str, str] | None = None
    label: str | None = None


class ConversationKnowledge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    warehouses: list[dict[str, str]] = Field(default_factory=list, max_length=100)
    data_scope: Literal["personal", "team"] = "team"


class ConversationContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    space: ConversationSpace = Field(default_factory=ConversationSpace)
    knowledge: ConversationKnowledge = Field(default_factory=ConversationKnowledge)


class ConversationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    context: ConversationContext | None = None
    active_thread_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")


class ConversationVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0)
    source_thread_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    message_id: str = Field(min_length=1, max_length=256)
    kind: Literal["edit", "regenerate"]
    text: str | None = Field(default=None, max_length=32000)


class ConversationVersionInfo(BaseModel):
    thread_id: str
    parent_thread_id: str | None = None
    target_message_id: str | None = None
    kind: Literal["original", "edit", "regenerate"]


class ConversationResponse(BaseModel):
    id: str
    active_thread_id: str
    revision: int
    context: ConversationContext
    versions: list[ConversationVersionInfo]
    validation_errors: list[dict[str, str]]


class ConversationVersionResponse(ConversationResponse):
    prepared_content: list[dict[str, Any]]


def conversation_error(exc: ConversationError, user: Any) -> HTTPException:
    return HTTPException(
        exc.status,
        detail={"code": exc.code, "message": tr("assistant.conversation_error", user.locale)},
    )


@router.post(
    "/assistant/context/validate",
    summary="Validate assistant draft source choices without granting access",
)
async def assistant_context_validate(
    body: ConversationContext,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    if user.application_id != "wanx" or getattr(user, "disabled", False):
        raise HTTPException(403)
    try:
        context, _ = await conversations(request, server).validate_context(
            user, body.model_dump(exclude_none=True), strict=True
        )
        return {"context": context}
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


@router.get(
    "/assistant/context/defaults",
    summary="Read last explicitly selected sources for a new conversation",
    description="Account and box scoped, separated by data scope. Revalidates selections without creating access grants. Existing conversations are unaffected.",
)
async def assistant_context_defaults_get(
    request: Request,
    data_scope: Literal["personal", "team"] = "team",
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    if user.application_id != "wanx" or getattr(user, "disabled", False):
        raise HTTPException(403)
    return await conversations(request, server).source_defaults(user, data_scope)


@router.patch(
    "/assistant/context/defaults",
    summary="Remember explicitly selected sources for future new conversations",
    description="Validates scope and stores a selection template only. Does not grant MCP access or change any existing conversation.",
)
async def assistant_context_defaults_patch(
    body: ConversationContext,
    request: Request,
    data_scope: Literal["personal", "team"] = "team",
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    if user.application_id != "wanx" or getattr(user, "disabled", False):
        raise HTTPException(403)
    try:
        return await conversations(request, server).source_defaults(
            user, data_scope, body.model_dump(exclude_none=True)
        )
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


@router.get(
    "/assistant/conversations",
    summary="List logical assistant conversations",
    description="Owner and box scoped. Includes native channel conversations and their channel_type without copying history. Internal answer-version threads are grouped under the original conversation.",
)
async def assistant_conversations_list(
    request: Request, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    try:
        return await conversations(request, server).listing(user)
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


@router.get(
    "/assistant/conversations/{conversation_id}",
    response_model=ConversationResponse,
    summary="Read assistant conversation sources and versions",
    description="Restores saved source choices without granting MCP access. Revalidates available sources; unavailable choices are retained with explicit validation_errors.",
)
async def assistant_conversation_get(
    conversation_id: str,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    try:
        return await conversations(request, server).get(user, conversation_id)
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


@router.post(
    "/assistant/conversations/{conversation_id}/open",
    response_model=ConversationResponse,
    summary="Remember the most recently opened assistant conversation",
    description="Records navigation for the current account on this box after validating conversation ownership. Does not change source selections, versions or grants.",
)
async def assistant_conversation_open(
    conversation_id: str,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    try:
        return await conversations(request, server).opened(user, conversation_id)
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


@router.patch(
    "/assistant/conversations/{conversation_id}",
    response_model=ConversationResponse,
    summary="Update conversation sources or selected answer version",
    description="Uses revision compare-and-swap. Source preferences are separate from two-hour grants. Disabling access revokes all capabilities for this conversation, including connected MCP reads. New access and version switches are blocked while a turn or confirmation is pending.",
)
async def assistant_conversation_patch(
    conversation_id: str,
    body: ConversationPatch,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    try:
        return await conversations(request, server).patch(
            user,
            conversation_id,
            body.revision,
            body.context.model_dump(exclude_none=True) if body.context else None,
            body.active_thread_id,
        )
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


@router.post(
    "/assistant/conversations/{conversation_id}/versions",
    response_model=ConversationVersionResponse,
    summary="Create an edit or regenerate version without deleting history",
    description="Clones only the history before the target request; no tool execution is replayed. Stable message IDs and ownership are required. Returns prepared_content only to the authenticated trusted client for the next native turn; this route does not invoke a model.",
)
async def assistant_conversation_version(
    conversation_id: str,
    body: ConversationVersion,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    try:
        if body.kind == "edit" and body.text is None:
            raise ConversationError("ASSISTANT_INVALID_INPUT", 422)
        return await conversations(request, server).version(
            user, conversation_id, body.model_dump()
        )
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc


class AssistantProfileResponse(BaseModel):
    agent_id: str = Field(description="Current user's private general-expert instance.")
    template_id: str = Field(description="Bundled expert template; always default.")
    default_model: str | None = Field(description="Expert default; turns may override it.")


@router.post(
    "/assistant/profile",
    summary="Ensure the current user's private general assistant",
    description=(
        "WANX accounts only. Reuses an owned private default-template expert, or creates "
        "one using the user's existing workspace/resource policies. Repeated and concurrent "
        "calls share the same binding. Does not generate a chat turn or change model settings."
    ),
    response_model=AssistantProfileResponse,
)
async def ensure_assistant(
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    service: AssistantProfiles | None = getattr(request.app.state, "assistant_profiles", None)
    if service is None:
        service = AssistantProfiles(server)
        request.app.state.assistant_profiles = service
    return await service.ensure(user)


class AssistantHistoryEntry(BaseModel):
    title: str | None = None
    pinned: bool | None = None
    status: Literal["active", "archived", "trash"] = "active"
    previous_status: Literal["active", "archived"] | None = None
    deleted_at: int | None = None
    updated_at: int | None = None


class AssistantHistoryResponse(BaseModel):
    revision: int
    entries: dict[str, AssistantHistoryEntry]


class AssistantHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["thread", "legacy"]
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")


class AssistantHistoryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["rename", "pin", "unpin", "archive", "unarchive", "trash", "restore"]
    items: list[AssistantHistoryItem] = Field(min_length=1, max_length=100)
    title: str | None = Field(default=None, min_length=1, max_length=100)


@router.get(
    "/assistant/history",
    summary="Read this user's assistant history organization",
    description="Account and box scoped names, pins, archives and recoverable trash. Source conversations are retained.",
    response_model=AssistantHistoryResponse,
)
async def assistant_history(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return await AssistantHistory(server).get(user)


@router.post(
    "/assistant/history",
    summary="Organize assistant history, including batch operations",
    description="Validates ownership of all selected conversations before an atomic update. Trash is reversible; no messages or checkpoints are deleted.",
    response_model=AssistantHistoryResponse,
)
async def update_assistant_history(
    body: AssistantHistoryUpdate,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return await AssistantHistory(server).update(
        user, body.operation, [item.model_dump() for item in body.items], body.title
    )


class AssistantSpaceSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["all", "space", "folder"]
    space_id: str | None = Field(default=None, pattern=r"^(personal|[0-9a-f]{32})$")
    folder_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


class AssistantSpaceGrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    grant_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    selection: AssistantSpaceSelection | None = None
    thread_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")


class AssistantSpaceGrantResponse(BaseModel):
    enabled: bool
    grant_id: str | None = None
    mcp_server: str | None = None
    selection: AssistantSpaceSelection | None = None
    label: str | None = None


@router.post(
    "/assistant/space-grant",
    summary="Choose or revoke an assistant's read-only space scope",
    description="Off by default. Explicitly select all owned spaces, one space, or one folder subtree. Grants are owner-bound, thread-bound on first send, expire after two hours without renewal, and are checked on every MCP read. Revocation stops subsequent reads including an ongoing turn.",
    response_model=AssistantSpaceGrantResponse,
)
async def assistant_space_grant(
    body: AssistantSpaceGrantBody,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    service = getattr(request.app.state, "assistant_space_grants", None)
    if service is None:
        service = AssistantSpaceGrants(server)
        request.app.state.assistant_space_grants = service
    try:
        async with conversations(request, server).grant_scope(
            user,
            body.thread_id,
            "space",
            body.enabled,
            body.selection.model_dump(exclude_none=True) if body.selection else None,
        ):
            return await service.update(
                user,
                enabled=body.enabled,
                grant_id=body.grant_id,
                selection=body.selection.model_dump(exclude_none=True) if body.selection else None,
                thread_id=body.thread_id,
            )
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc
    except SpaceError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc


class KnowledgeWarehouse(BaseModel):
    id: str
    name: str
    available: bool = True
    code: str | None = None


class KnowledgeWarehousesResponse(BaseModel):
    items: list[KnowledgeWarehouse]


def knowledge_scope(
    x_wanx_data_context: Literal["personal", "team"] = Header(default="team"),
) -> str:
    return x_wanx_data_context


class KnowledgeAccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    audience: Literal["none", "all", "selected"]
    members: list[int] = Field(default_factory=list, max_length=1000)
    revision: int = Field(ge=0)


class KnowledgeMember(BaseModel):
    role: str
    id: int
    name: str
    disabled: bool


class KnowledgeAccessResponse(KnowledgeAccessUpdate):
    warehouse: KnowledgeWarehouse
    updated_by: int | None = None
    updated_at: int | None = None
    users: list[KnowledgeMember]


class KnowledgeGrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    grant_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    warehouses: list[str] | None = Field(default=None, min_length=1, max_length=100)
    thread_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{1,128}$")


class KnowledgeGrantResponse(BaseModel):
    enabled: bool
    grant_id: str | None = None
    mcp_server: str | None = None
    warehouses: list[KnowledgeWarehouse] = Field(default_factory=list)


class KnowledgeSourcesResponse(BaseModel):
    sources: list[dict[str, Any]]


@router.get(
    "/assistant/knowledge/sources/{thread_id}",
    summary="Read previously retrieved source references in an owned assistant conversation",
    response_model=KnowledgeSourcesResponse,
)
async def knowledge_sources(
    thread_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    def read() -> dict[str, Any]:
        if user.application_id != "wanx":
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        row = server.app_runtime.gateway.thread_registry.get_thread(thread_id)
        profile = AssistantProfiles(server)._existing(user.id)
        if not row or not profile or row.user_id != user.id or row.agent_id != profile.agent_id:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        return {"sources": KnowledgeSources(server.paths.root, user.id).list(thread_id)}

    try:
        return await asyncio.to_thread(read)
    except SemanticaError as exc:
        raise knowledge_error(exc, user) from exc


class KnowledgeEvidenceBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    grant_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    warehouse_id: str
    evidence_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    thread_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")


class KnowledgeReadResponse(BaseModel):
    warehouse: KnowledgeWarehouse
    result: dict[str, Any]
    assistant_knowledge_sources: list[dict[str, Any]]


def knowledge_error(exc: SemanticaError, user: Any) -> HTTPException:
    key = (
        exc.code
        if exc.code.startswith("ASSISTANT_KNOWLEDGE_")
        else "ASSISTANT_KNOWLEDGE_UNAVAILABLE"
    )
    return HTTPException(
        exc.status,
        detail={"code": key, "message": tr("assistant.knowledge_errors." + key, user.locale)},
    )


@router.get(
    "/assistant/knowledge/warehouses",
    summary="List owned personal or authorized team knowledge warehouses",
    response_model=KnowledgeWarehousesResponse,
)
async def knowledge_warehouses(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
    data_scope: str = Depends(knowledge_scope),
) -> dict[str, Any]:
    try:
        return {
            "items": await KnowledgeReader(
                server.paths.root,
                server.services.db,
                user.id,
                application_id=user.application_id,
                data_scope=data_scope,
            ).catalog()
        }
    except SemanticaError as exc:
        raise knowledge_error(exc, user) from exc


@router.get(
    "/assistant/knowledge/access/{warehouse_id}",
    summary="Read warehouse assistant access and team members (admin)",
    response_model=KnowledgeAccessResponse,
)
async def knowledge_access(
    warehouse_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    try:
        return await KnowledgeReader(
            server.paths.root, server.services.db, user.id, application_id=user.application_id
        ).access(warehouse_id)
    except SemanticaError as exc:
        raise knowledge_error(exc, user) from exc


@router.put(
    "/assistant/knowledge/access/{warehouse_id}",
    summary="Authorize all or selected team members for assistant knowledge (admin)",
    description="Transactional, revision-checked warehouse ACL. New members inherit all-member rules; selected rules require explicit membership. Revocation applies to ongoing MCP calls.",
    response_model=KnowledgeAccessResponse,
)
async def update_knowledge_access(
    warehouse_id: str,
    body: KnowledgeAccessUpdate,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    try:
        return await KnowledgeReader(
            server.paths.root, server.services.db, user.id, application_id=user.application_id
        ).access(warehouse_id, body.model_dump())
    except SemanticaError as exc:
        raise knowledge_error(exc, user) from exc


@router.post(
    "/assistant/knowledge-grant",
    summary="Choose or revoke this conversation's read-only Starlink warehouses",
    description="Off until explicitly configured. Owner and box bound, one thread, two-hour expiry renewed on send. Does not modify expert defaults or Starlink documents.",
    response_model=KnowledgeGrantResponse,
)
async def knowledge_grant(
    body: KnowledgeGrantBody,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
    data_scope: str = Depends(knowledge_scope),
) -> dict[str, Any]:
    service = getattr(request.app.state, "assistant_knowledge_grants", None)
    if service is None:
        service = AssistantKnowledgeGrants(server)
        request.app.state.assistant_knowledge_grants = service
    try:
        async with conversations(request, server).grant_scope(
            user, body.thread_id, "knowledge", body.enabled, body.warehouses, data_scope
        ):
            return await service.update(user, data_scope=data_scope, **body.model_dump())
    except ConversationError as exc:
        raise conversation_error(exc, user) from exc
    except SemanticaError as exc:
        raise knowledge_error(exc, user) from exc


@router.post(
    "/assistant/knowledge/evidence",
    summary="Preview protected evidence from a currently selected warehouse",
    response_model=KnowledgeReadResponse,
)
async def knowledge_evidence(
    body: KnowledgeEvidenceBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
    data_scope: str = Depends(knowledge_scope),
) -> dict[str, Any]:
    try:
        reader = KnowledgeReader(
            server.paths.root,
            server.services.db,
            user.id,
            body.grant_id,
            application_id=user.application_id,
            data_scope=data_scope,
        )
        grant = await asyncio.to_thread(reader.store.get, body.grant_id)
        if grant.get("thread_id") != body.thread_id:
            raise KnowledgeError("ASSISTANT_KNOWLEDGE_DENIED", 403)
        return await reader.read("evidence", body.warehouse_id, evidence_id=body.evidence_id)
    except SemanticaError as exc:
        raise knowledge_error(exc, user) from exc
