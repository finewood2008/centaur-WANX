"""The signed-in owner's sole, independently created Zhijun profile."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from octop.api.common.agent_runtime import AgentRuntimeFields
from octop.api.deps import current_user, get_server
from octop.api.routers.agents import _row_dict
from octop.infra.agents.application import application_id
from octop.infra.agents.decision_book import (
    DecisionBook,
    DecisionCreate,
    DecisionReview,
    create_decision,
    read_decisions,
    review_decision,
)
from octop.infra.agents.knowledge_understanding import (
    read_understanding,
    review_invitation,
    set_understanding_running,
    start_invitation_conversation,
    update_understanding,
)
from octop.infra.agents.memory_maintenance import (
    MaintenanceArchiveCommand,
    MaintenanceCommand,
    MaintenancePreview,
    MaintenanceRecord,
    MaintenanceState,
    MaintenanceTarget,
    maintain_archive,
    maintain_memory,
    preview_maintenance,
    read_maintenance,
)
from octop.infra.agents.notification_policy import (
    ChannelPolicy,
    ChannelPurpose,
    read_channel_policies,
    set_channel_purpose,
)
from octop.infra.agents.ontology_admission import (
    candidate_page,
    review_core,
    start_core_conversation,
)
from octop.infra.agents.ontology_graph import edit_context_node
from octop.infra.agents.ontology_runtime import read_context
from octop.infra.agents.ontology_types import (
    CoreCandidatePage,
    CoreCommand,
    CoreConversation,
    CoreConversationRequest,
    OntologyContext,
    OntologyContextEdit,
    OntologyRelationEdit,
)
from octop.infra.agents.personal_ontology import (
    OntologyEdit,
    OntologyResult,
    OntologyReview,
    PersonalOntology,
    edit_personal_ontology,
    generate_personal_ontology,
    read_personal_ontology,
    review_ontology_relation,
    review_personal_ontology,
)
from octop.infra.agents.response_options import ResponseOptionsResult, generate_response_options
from octop.infra.agents.understanding_types import (
    InvitationReview,
    UnderstandingConversation,
    UnderstandingPublicState,
    UnderstandingRevision,
    UnderstandingSettings,
    UnderstandingState,
)
from octop.infra.agents.zhijun import get_or_create_profile, get_profile
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter()


@router.get(
    "/notification-channels",
    response_model=list[ChannelPolicy],
    summary="Read my notification destination declarations",
    description="Owner-only policy over existing channels. Unmarked or rebound destinations default to work; credentials are never returned.",
)
async def notification_channels(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> list[ChannelPolicy]:
    _require_zhijun(user)
    return await read_channel_policies(
        server.app_runtime.agent_registry, user.id, server.app_runtime.gateway
    )


@router.put(
    "/notification-channels",
    response_model=ChannelPolicy,
    summary="Declare an owned destination private or work",
    description="Records notification authorization in the owned profile workspace, bound to current channel credentials. Does not modify or reconnect the channel.",
)
async def notification_channel_write(
    body: ChannelPurpose, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> ChannelPolicy:
    _require_zhijun(user)
    return await set_channel_purpose(
        server.app_runtime.agent_registry, user.id, server.app_runtime.gateway, body
    )


@router.get(
    "/decisions",
    response_model=DecisionBook,
    summary="Read my decisions, expectations and outcome reviews",
    description="Uses only the signed-in owner's isolated profile. Does not infer decisions from conversation or native memory.",
)
async def decisions(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> DecisionBook:
    _require_zhijun(user)
    return await read_decisions(server.app_runtime.agent_registry, user.id)


@router.post(
    "/decisions",
    response_model=DecisionBook,
    summary="Record a choice and an agreed revisit time",
    description="Version-checked explicit owner entry. Private by default; only the separately supplied approved summary can enter private-destination reminders. No model is invoked.",
)
async def decision_write(
    body: DecisionCreate, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> DecisionBook:
    _require_zhijun(user)
    return await create_decision(server.app_runtime.agent_registry, user.id, body)


@router.post(
    "/decisions/{decision_id}:review",
    response_model=DecisionBook,
    summary="Compare a decision's result with its original expectation",
    description="Owner/revision checked. Preserves the original expectation and source sensitivity; review cannot relabel a private source or authorize its disclosure.",
)
async def decision_review(
    decision_id: str,
    body: DecisionReview,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> DecisionBook:
    _require_zhijun(user)
    return await review_decision(server.app_runtime.agent_registry, user.id, decision_id, body)


@router.get(
    "/maintenance",
    response_model=MaintenanceState,
    summary="Read my archived memories and operation status",
)
async def get_maintenance(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> MaintenanceState:
    _require_zhijun(user)
    return await read_maintenance(server.app_runtime.agent_registry, user.id)


@router.post(
    "/maintenance:preview",
    response_model=MaintenancePreview,
    summary="Preview removal of a memory and its direct derivatives",
)
async def maintenance_preview(
    body: MaintenanceTarget, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> MaintenancePreview:
    _require_zhijun(user)
    return await preview_maintenance(server.app_runtime.agent_registry, user.id, body)


@router.post(
    "/maintenance",
    response_model=MaintenanceRecord,
    summary="Archive or permanently remove my selected memory",
    description="Owner operation only. Checks the preview version and archives before removal. Does not delete conversation messages, source files, or external backups. No model is invoked.",
)
async def maintenance_write(
    body: MaintenanceCommand, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> MaintenanceRecord:
    _require_zhijun(user)
    return await maintain_memory(server.app_runtime.agent_registry, user.id, body)


@router.post(
    "/maintenance:archive",
    response_model=MaintenanceRecord,
    summary="Restore or purge an archived memory",
    description="Restores original IDs without overwriting concurrent changes; purge removes the application's recovery copy. Archive identity is resolved within the signed-in owner's isolated profile.",
)
async def maintenance_archive(
    body: MaintenanceArchiveCommand,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> MaintenanceRecord:
    _require_zhijun(user)
    return await maintain_archive(server.app_runtime.agent_registry, user.id, body)


@router.get(
    "/understanding",
    response_model=UnderstandingPublicState,
    summary="Read my document-understanding scope, progress and invitations",
    description="Zhijun login only. Validates current source versions; never starts reading, inference or messages. Only the signed-in owner's isolated profile is used.",
)
async def get_understanding(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> UnderstandingState:
    _require_zhijun(user)
    return await read_understanding(server.app_runtime.agent_registry, user.id)


@router.put(
    "/understanding",
    response_model=UnderstandingPublicState,
    summary="Choose owned libraries and opt into ongoing understanding",
    description="Version-checked owner settings. Library attribution does not recognize its contents as the owner's beliefs. New libraries require selection; a model call is not made by this request.",
)
async def put_understanding(
    body: UnderstandingSettings,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> UnderstandingState:
    _require_zhijun(user)
    return await update_understanding(server.app_runtime.agent_registry, user.id, body)


@router.post(
    "/understanding:run",
    response_model=UnderstandingPublicState,
    summary="Start or resume bounded reading of my selected libraries",
    description="Schedules one serialized background job per profile using its configured conversation model. Returns persisted progress, not a promise of complete reading. Existing successful pages are retained across retries.",
)
async def run_understanding(
    body: UnderstandingRevision,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> UnderstandingState:
    _require_zhijun(user)
    return await set_understanding_running(
        server.app_runtime.agent_registry, user.id, body.revision, enabled=True
    )


@router.post(
    "/understanding:pause",
    response_model=UnderstandingPublicState,
    summary="Pause ongoing document understanding without deleting progress",
    description="Stops subsequent reading batches and reminder attempts. In-flight output cannot commit across the new settings revision. Keeps memory and owner edits.",
)
async def pause_understanding(
    body: UnderstandingRevision,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> UnderstandingState:
    _require_zhijun(user)
    return await set_understanding_running(
        server.app_runtime.agent_registry, user.id, body.revision, enabled=False
    )


@router.post(
    "/understanding/invitations/{invitation_id}:review",
    response_model=UnderstandingPublicState,
    summary="Accept, postpone or dismiss a source-grounded invitation",
    description="Checks owner, revision and current source. Acceptance binds background only; does not fabricate a human message or confirm a personal belief. Postponement lasts one day.",
)
async def understanding_invitation_review(
    invitation_id: str,
    body: InvitationReview,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> UnderstandingState:
    _require_zhijun(user)
    return await review_invitation(
        server.app_runtime.agent_registry, user.id, invitation_id, body.action, body.revision
    )


@router.post(
    "/understanding/invitations/{invitation_id}:conversation",
    response_model=UnderstandingConversation,
    summary="Open or resume an owned material invitation conversation",
    description="Validates source and profile ownership, then reuses a stable dedicated thread. Does not send messages, call a model or reset the current session. Reading and discussion never confirm a personal belief.",
)
async def understanding_invitation_conversation(
    invitation_id: str,
    body: UnderstandingRevision,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_zhijun(user)
    return await start_invitation_conversation(
        server.app_runtime.agent_registry,
        server.app_runtime.gateway.thread_registry,
        user.id,
        invitation_id,
        body.revision,
    )


class ZhijunProfile(AgentRuntimeFields):
    """Native Agent identity and lifecycle; no copied personal information."""

    id: int
    agent_id: str = Field(description="Use this ID for every chat and memory request.")
    application_id: Literal["zhijun"] = "zhijun"
    user_id: int
    name: str
    description: str | None = None
    persona_mbti: str | None = None
    default_model: str | None = None
    system_prompt: str | None = None
    state: str = Field(description="Native startup state; creation can survive a failed start.")
    last_error: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    template_name: str | None = None
    icon: str | None = None
    icon_name: str | None = None
    icon_url: str | None = None
    color: str | None = None
    knowledge_base_ids: list[str] = Field(default_factory=list)
    mcp_servers: list[str] = Field(default_factory=list)
    skill_package_ids: list[str] = Field(default_factory=list)
    is_owner: bool = True
    is_shared: bool = False
    kind: Literal["expert"] = "expert"
    bootstrap_pending: bool = False
    welcome_message: str | None = None


class ZhijunProfileResponse(BaseModel):
    profile: ZhijunProfile | None = Field(description="Null until the owner explicitly creates it.")


class CreateZhijunProfileBody(BaseModel):
    """Intentionally accepts no source Agent, workspace or memory path."""

    model_config = ConfigDict(extra="forbid")


class GenerateResponseOptionsBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    thread_id: str = Field(min_length=1, max_length=200, description="An owned Zhijun thread.")
    reply: str = Field(
        min_length=1,
        max_length=12000,
        description="The latest visible assistant reply; verified against native history.",
    )
    manual: bool = Field(
        default=False,
        description="Explicitly request choices even without a final follow-up question.",
    )


def _require_zhijun(user: Any) -> None:
    if application_id(user) != "zhijun":
        raise OctopError(ErrorCode.NOT_FOUND, "resource not found")


def _profile(row: Any, user: Any) -> ZhijunProfile:
    return ZhijunProfile.model_validate(_row_dict(row, viewer_user_id=user.id))


@router.get(
    "/profile",
    response_model=ZhijunProfileResponse,
    summary="Read my Zhijun profile",
    description="Requires a Zhijun-scoped login. Never creates a profile or lists WANX Agents.",
)
async def read_profile(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> ZhijunProfileResponse:
    _require_zhijun(user)
    row = get_profile(server.app_runtime.agent_registry, user.id)
    return ZhijunProfileResponse(profile=_profile(row, user) if row is not None else None)


@router.post(
    "/profile",
    response_model=ZhijunProfileResponse,
    summary="Create or recover my blank Zhijun profile",
    description=(
        "Idempotently returns the owner's unique profile. Only behavior rules are seeded; "
        "personal memory and conversation history start empty. No model conversation is run. "
        "A failed model start retains the same profile; retry attempts to start it again."
    ),
)
async def create_profile(
    body: CreateZhijunProfileBody | None = Body(default=None),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> ZhijunProfileResponse:
    _require_zhijun(user)
    row = await get_or_create_profile(server.app_runtime.agent_registry, user.id)
    return ZhijunProfileResponse(profile=_profile(row, user))


@router.post(
    "/response-options",
    response_model=ResponseOptionsResult,
    summary="Suggest possible responses to my latest Zhijun reply",
    description=(
        "Uses the profile's configured model and owned recent conversation. Only already-read "
        "sources participate; no tools run and no candidates are written to history or memory. "
        "A changed conversation returns stale. Model failure returns unavailable for explicit retry."
    ),
)
async def suggest_responses(
    body: GenerateResponseOptionsBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> ResponseOptionsResult:
    _require_zhijun(user)
    row = get_profile(server.app_runtime.agent_registry, user.id)
    if row is None:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return await generate_response_options(
        server.app_runtime.agent_registry,
        server.app_runtime.gateway.thread_registry,
        agent_id=row.agent_id,
        user_id=user.id,
        **body.model_dump(),
    )


class GenerateOntologyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(
        min_length=1,
        max_length=100,
        description="Last read ontology revision; stale requests never overwrite owner decisions.",
    )


@router.get(
    "/ontology",
    response_model=PersonalOntology,
    summary="Read my personal ontology and verify its sources",
    description="Zhijun login only. Reads the owner's sole profile; never runs a model. Native source changes invalidate affected understandings.",
)
async def read_ontology(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> PersonalOntology:
    _require_zhijun(user)
    return await read_personal_ontology(server.app_runtime.agent_registry, user.id)


@router.post(
    "/ontology:generate",
    response_model=OntologyResult,
    summary="Synthesize tentative life principles from my memory",
    description="Explicit request using this profile's configured model. Paginates all active memories, processing bounded incremental batches with saved coverage. Only verified owner quotations enter the prompt; repeated messages in one conversation/day are one support. Saves a local profile projection; never modifies native memory or confirms a principle. Failures preserve the previous ontology.",
)
async def generate_ontology(
    body: GenerateOntologyBody, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> OntologyResult:
    _require_zhijun(user)
    return await generate_personal_ontology(
        server.app_runtime.agent_registry, user.id, body.revision
    )


@router.post(
    "/ontology/{claim_id}:review",
    response_model=OntologyResult,
    summary="Review or withdraw an understanding of myself",
    description="An explicit owner decision on the last read revision. Confirmation requires current native evidence. Updates the application projection and reads back the saved result; does not change source memories.",
)
async def review_ontology(
    claim_id: str,
    body: OntologyReview,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> OntologyResult:
    _require_zhijun(user)
    return await review_personal_ontology(
        server.app_runtime.agent_registry, user.id, claim_id, body
    )


@router.post(
    "/ontology:nodes",
    response_model=OntologyResult,
    summary="Add my own statement to my personal ontology",
    description="An explicit self-declaration needs no inferred evidence. Revision check and persisted readback; adds no native memory facts.",
)
async def add_ontology_node(
    body: OntologyEdit, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> OntologyResult:
    _require_zhijun(user)
    return await edit_personal_ontology(server.app_runtime.agent_registry, user.id, None, body)


@router.post(
    "/ontology/{claim_id}:edit",
    response_model=OntologyResult,
    summary="Edit, disable or restore my understanding",
    description="Optimistic revision check. Keeps the previous version and sources; owner wording cannot be replaced by background synthesis. Restore creates a new revision rather than erasing history.",
)
async def edit_ontology_node(
    claim_id: str,
    body: OntologyEdit,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> OntologyResult:
    _require_zhijun(user)
    return await edit_personal_ontology(server.app_runtime.agent_registry, user.id, claim_id, body)


@router.post(
    "/ontology/context-nodes",
    response_model=OntologyResult,
    summary="Add my current fact, role, project or goal",
    description="Owner-declared personal context, saved through the profile workspace. No model call or source-memory rewrite. Includes version and persisted readback.",
)
async def add_context_node(
    body: OntologyContextEdit, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> OntologyResult:
    _require_zhijun(user)
    if body.action != "add":
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    return await edit_context_node(server.app_runtime.agent_registry, user.id, None, body)


@router.post(
    "/ontology/context-nodes/{node_id}:edit",
    response_model=OntologyResult,
    summary="Correct, scope, merge, stop using or restore my personal context",
    description="Target-version check; unrelated background progress does not conflict. Person/project merges require both target versions. Current context changes preserve historical source quotations. Purge removes this context and its links, retains native sources, and records a content-free suppression identity.",
)
async def update_context_node(
    node_id: str,
    body: OntologyContextEdit,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> OntologyResult:
    _require_zhijun(user)
    return await edit_context_node(server.app_runtime.agent_registry, user.id, node_id, body)


@router.get(
    "/ontology/context",
    response_model=OntologyContext,
    summary="See understandings actually supplied for my reply",
    description="An immutable context snapshot scoped to this owner's profile and thread. This records supplied inputs, not model reasoning. Historical snapshots remain historical after edits.",
)
async def ontology_context(
    thread_id: str = Query(min_length=1, max_length=200),
    reply: str = Query(min_length=1, max_length=20000),
    reply_id: str = Query(default="", max_length=300),
    latest: bool = Query(default=False),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> OntologyContext:
    _require_zhijun(user)
    row = get_profile(server.app_runtime.agent_registry, user.id)
    thread = server.app_runtime.gateway.thread_registry.get_thread(thread_id)
    if (
        row is None
        or thread is None
        or thread.agent_id != row.agent_id
        or thread.user_id != user.id
    ):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return await read_context(
        server.app_runtime.agent_registry,
        user.id,
        thread_id,
        reply,
        reply_id=reply_id,
        latest=latest,
    )


@router.post(
    "/ontology:relation",
    response_model=OntologyResult,
    summary="Review a relation between my understandings",
    description="Checks the target relation version and current endpoints for understanding and context links. Background progress does not conflict; changed endpoints require rechecking. Never treats a structural source link as a causal conclusion.",
)
async def review_relation(
    body: OntologyRelationEdit, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> OntologyResult:
    _require_zhijun(user)
    return await review_ontology_relation(server.app_runtime.agent_registry, user.id, body)


class AssistedReplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    thread_id: str = Field(min_length=1, max_length=200)
    offered: str = Field(min_length=1, max_length=500)
    submitted: str = Field(min_length=1, max_length=20000)


class AssistedReplyResult(BaseModel):
    recorded: bool


@router.post(
    "/response-origin",
    response_model=AssistedReplyResult,
    summary="Record the origin of an assisted reply",
    description="Records that the editable draft began with a verified AI suggestion. It is excluded as independent experience evidence; sends no chat message.",
)
async def assisted_reply(
    body: AssistedReplyBody, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> AssistedReplyResult:
    from octop.infra.agents.personal_ontology import record_assisted_reply

    _require_zhijun(user)
    row = get_profile(server.app_runtime.agent_registry, user.id)
    thread = server.app_runtime.gateway.thread_registry.get_thread(body.thread_id)
    if (
        row is None
        or thread is None
        or thread.agent_id != row.agent_id
        or thread.user_id != user.id
    ):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    await record_assisted_reply(
        server.app_runtime.agent_registry, user.id, body.thread_id, body.offered, body.submitted
    )
    return AssistedReplyResult(recorded=True)


@router.get(
    "/ontology/candidates",
    response_model=CoreCandidatePage,
    summary="Read my core-understanding confirmation queue",
    description="Owned, paginated candidates. Reading does not approve an understanding or call a model.",
)
async def core_candidates(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=10, ge=1, le=50),
    processed: bool = False,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> CoreCandidatePage:
    _require_zhijun(user)
    return await candidate_page(
        server.app_runtime.agent_registry, user.id, offset=offset, limit=limit, processed=processed
    )


@router.post(
    "/ontology/{claim_id}:admission",
    response_model=OntologyResult,
    summary="Confirm or adjust the exact understanding shown to its owner",
    description="Owner UI only. Checks item version and idempotency key. Models and legacy confirmation cannot grant core admission. Reads back saved state.",
)
async def core_admission(
    claim_id: str,
    body: CoreCommand,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> OntologyResult:
    _require_zhijun(user)
    return await review_core(server.app_runtime.agent_registry, user.id, claim_id, body)


@router.post(
    "/ontology/{claim_id}:conversation",
    response_model=CoreConversation,
    summary="Open an owned conversation about a candidate understanding",
    description="Binds the current candidate as system context to a dedicated owned thread. No human message is fabricated and no core admission is granted.",
)
async def core_conversation(
    claim_id: str,
    body: CoreConversationRequest,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> Any:
    _require_zhijun(user)
    return await start_core_conversation(
        server.app_runtime.agent_registry,
        server.app_runtime.gateway.thread_registry,
        user.id,
        claim_id,
        body.expected_version,
    )
