"""HTTP adapters for the native Loop service."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, cast

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile

from octop.api.deps import current_user, get_server
from octop.api.routers import knowledge_bases as native_knowledge
from octop.infra.agents.application import application_id
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.loops.models import (
    ApprovalBody,
    BindingChallengeView,
    BindingConfirmationView,
    BindingView,
    BuilderBody,
    BuilderReply,
    CapabilityView,
    ChannelBindingBody,
    ConnectorToolsBody,
    ConnectorToolsView,
    DraftBody,
    ExecutorView,
    JudgmentBody,
    JudgmentView,
    LoopDefinition,
    LoopView,
    OverviewResultView,
    ReviewBody,
    RoundView,
)
from octop.infra.loops.service import LoopService

router = APIRouter(prefix="/loops")


def service(server: Any = Depends(get_server), user: Any = Depends(current_user)) -> LoopService:
    if application_id(user) != "wanx":
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    runtime = server.app_runtime
    if runtime is None or runtime.loop_service is None:
        raise OctopError.localized(ErrorCode.INTERNAL_ERROR)
    return cast(LoopService, runtime.loop_service)


@router.get(
    "/capability", response_model=CapabilityView, summary="Loop protocol and server timezone"
)
async def capability(svc: LoopService = Depends(service)) -> CapabilityView:
    return CapabilityView(timezone=svc.timezone)


@router.post(
    "/executor",
    response_model=ExecutorView,
    summary="Prepare the current owner's dedicated CentaurLoop expert",
)
async def executor(user: Any = Depends(current_user), svc: LoopService = Depends(service)) -> Any:
    return await svc.executor.ensure(user.id)


@router.post(
    "/draft",
    response_model=LoopDefinition,
    summary="Generate a read-only editable Loop configuration",
)
async def draft(
    body: DraftBody, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> LoopDefinition:
    return await svc.draft(user.id, body.agent_id, body.text, current=body.current)


@router.post(
    "/connector-tools",
    response_model=ConnectorToolsView,
    summary="Discover tools from explicitly selected WANX connectors",
    description="Checks expert ownership and current connector access, connects to selected MCP services and lists tool metadata. Never invokes business tools or changes Loop configuration.",
)
async def connector_tools(
    body: ConnectorToolsBody,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.connector_tools(user.id, body.agent_id, body.mcp_servers)


@router.get("/knowledge-base", summary="Get the current owner's shared CentaurLoop library")
async def loop_knowledge_base(
    user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return asdict(await svc._db(svc.resources.knowledge_base, user.id))


@router.get("/knowledge-base/documents", summary="List only CentaurLoop library documents")
async def loop_knowledge_documents(
    request: Request,
    server: Any = Depends(get_server),
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    base = await svc._db(svc.resources.knowledge_base, user.id)
    return await native_knowledge.list_documents(
        base.id, request, prefix=None, server=server, user=user
    )


@router.post("/knowledge-base/documents/text", summary="Add text to the shared CentaurLoop library")
async def loop_knowledge_text(
    body: native_knowledge.CreateTextDocumentBody,
    request: Request,
    server: Any = Depends(get_server),
    user: Any = Depends(native_knowledge._knowledge_editor),
    svc: LoopService = Depends(service),
) -> Any:
    base = await svc._db(svc.resources.knowledge_base, user.id)
    return await native_knowledge.create_text_document(
        base.id, body, request, server=server, user=user
    )


@router.post("/knowledge-base/documents", summary="Upload into the shared CentaurLoop library")
async def loop_knowledge_upload(
    request: Request,
    upload: UploadFile = File(...),
    server: Any = Depends(get_server),
    user: Any = Depends(native_knowledge._knowledge_editor),
    svc: LoopService = Depends(service),
) -> Any:
    base = await svc._db(svc.resources.knowledge_base, user.id)
    return await native_knowledge.upload_document(
        base.id, request, upload=upload, path=None, server=server, user=user
    )


@router.post(
    "/builder",
    response_model=BuilderReply,
    summary="Ask one planning question and refine a visual Loop proposal",
    description="Read-only conversation: proposes sequential AI stages and human judgments without saving, running or enabling a Loop.",
)
async def builder(
    body: BuilderBody, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> BuilderReply:
    return await svc.build(user.id, body)


@router.get("", response_model=list[LoopView], summary="List the current user's loops")
async def list_loops(user: Any = Depends(current_user), svc: LoopService = Depends(service)) -> Any:
    return await svc.list_loops(user.id)


@router.get(
    "/overview",
    response_model=list[OverviewResultView],
    summary="Read the current owner's five latest successful results, including trials",
)
async def overview(user: Any = Depends(current_user), svc: LoopService = Depends(service)) -> Any:
    return await svc.overview(user.id)


@router.get("/deleted", response_model=list[LoopView], summary="List recoverable deleted tasks")
async def deleted_loops(
    user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.list_loops(user.id, deleted=True)


@router.delete("/{loop_id}", response_model=LoopView, summary="Stop a task and move it to trash")
async def delete_loop(
    loop_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.delete(loop_id, user.id)


@router.post(
    "",
    response_model=LoopView,
    status_code=201,
    summary="Save a Loop draft and optionally take over a native automation",
)
async def create(
    body: LoopDefinition, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.create(user.id, body)


@router.get(
    "/channel-bindings",
    response_model=list[BindingView],
    summary="List owner-verified channel bindings",
)
async def bindings(user: Any = Depends(current_user), svc: LoopService = Depends(service)) -> Any:
    return await svc.interactions.list_bindings(user.id)


@router.post(
    "/channel-bindings",
    response_model=BindingChallengeView | BindingConfirmationView,
    status_code=201,
    summary="Reuse a verified owner contact or request first-time identity binding",
)
async def binding_create(
    body: ChannelBindingBody, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.interactions.create_binding(
        user.id, body.agent_id, body.channel_id, body.owner_proof
    )


@router.post(
    "/channel-bindings/{binding_id}/confirm",
    response_model=BindingConfirmationView,
    summary="Confirm the received platform identity",
)
async def binding_confirm(
    binding_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.interactions.confirm_binding(user.id, binding_id)


@router.delete(
    "/channel-bindings/{binding_id}", status_code=204, summary="Revoke a personal channel binding"
)
async def binding_revoke(
    binding_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> None:
    await svc.interactions.revoke_binding(user.id, binding_id)


@router.get("/{loop_id}", response_model=LoopView, summary="Read a Loop and its current progress")
async def get(
    loop_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.get(loop_id, user.id)


@router.put(
    "/{loop_id}",
    response_model=LoopView,
    summary="Save an immutable configuration version while paused",
)
async def revise(
    loop_id: str,
    body: LoopDefinition,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.revise(loop_id, user.id, body)


@router.post(
    "/{loop_id}/trial",
    response_model=LoopView,
    summary="Run a confirmed trial; does not enable recurring execution",
)
async def trial(
    loop_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.start_round(loop_id, user.id, trial=True)


@router.post(
    "/{loop_id}/enable", response_model=LoopView, summary="Enable the tested configuration"
)
async def enable(
    loop_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.enable(loop_id, user.id)


@router.post(
    "/{loop_id}/control/{action}",
    response_model=LoopView,
    summary="Pause, resume, stop or release an automation",
)
async def control(
    loop_id: str,
    action: str,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    if action not in {"pause", "resume", "stop", "release", "resolve", "restore"}:
        raise OctopError.localized(ErrorCode.LOOP_INVALID)
    return await svc.control(loop_id, user.id, action)


@router.get(
    "/{loop_id}/rounds/{round_id}",
    response_model=RoundView,
    summary="Read an owned report by its recorded round identifier",
)
async def round_by_id(
    loop_id: str,
    round_id: str,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.round_by_id(loop_id, round_id, user.id)


@router.get(
    "/{loop_id}/rounds",
    response_model=list[RoundView],
    summary="Read recorded rounds and pending confirmations",
)
async def rounds(
    loop_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    before: str | None = Query(default=None, max_length=128),
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.rounds(loop_id, user.id, limit, before)


@router.post(
    "/{loop_id}/approval",
    response_model=LoopView,
    summary="Resume the same native checkpoint after tool confirmation",
)
async def approve(
    loop_id: str,
    body: ApprovalBody,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.approve(loop_id, user.id, body)


@router.post(
    "/{loop_id}/review",
    response_model=LoopView,
    summary="Legacy review endpoint (use a numbered judgment)",
    deprecated=True,
)
async def review(
    loop_id: str,
    body: ReviewBody,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.review(loop_id, user.id, body.accepted, body.feedback)


@router.get(
    "/{loop_id}/judgments",
    response_model=list[JudgmentView],
    summary="Read human judgments and decisions",
)
async def judgments(
    loop_id: str, user: Any = Depends(current_user), svc: LoopService = Depends(service)
) -> Any:
    return await svc.judgments(loop_id, user.id)


@router.post("/{loop_id}/judgments", response_model=LoopView, summary="Apply a human decision once")
async def judge(
    loop_id: str,
    body: JudgmentBody,
    user: Any = Depends(current_user),
    svc: LoopService = Depends(service),
) -> Any:
    return await svc.judge(loop_id, user.id, body)
