"""Reviewed publications and visitor-scoped consultation on the local host."""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query

from octop.api.deps import current_user, get_server
from octop.api.routers.zhijun import _require_zhijun
from octop.infra.agents import digital_self as service
from octop.infra.agents.digital_self_types import (
    AccessCommand,
    DiscoveryPage,
    HistoryCommand,
    HistoryPage,
    PreviewTurn,
    PublishedEntry,
    SelfCard,
    SelfCommand,
    SelfReply,
    SelfState,
    SourcePage,
    VisitorRequest,
    VisitorTurn,
)

router = APIRouter()


def _registry(user: Any, server: Any) -> Any:
    _require_zhijun(user)
    return server.app_runtime.agent_registry


@router.get(
    "/me",
    response_model=SelfState,
    summary="Read my digital self draft, publication, access and usage",
)
async def read_self(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SelfState:
    return await service.read_self(_registry(user, server), user.id)


@router.put(
    "/me",
    response_model=SelfState,
    summary="Save, draft, publish, pause or withdraw my digital self",
    description="Owner-only optimistic version check and readback. Saving private content never publishes it. Publishing requires explicit recognition of every selected entry. AI drafting consumes the owner's model and sends only selected excerpts.",
)
async def update_self(
    body: SelfCommand, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SelfState:
    return await service.update_self(_registry(user, server), user.id, body)


@router.get(
    "/me/sources",
    response_model=SourcePage,
    summary="Select current owner sources for a publication draft",
)
async def source_page(
    kind: Literal["ontology", "memory", "episode", "knowledge"] = "ontology",
    offset: int = Query(0, ge=0),
    kb_id: str = "",
    document_id: str = "",
    start: int = Query(0, ge=0),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> SourcePage:
    return await service.source_page(
        _registry(user, server), user.id, kind, offset, kb_id, document_id, start
    )


@router.post(
    "/me/preview",
    response_model=SelfReply,
    summary="Try a saved draft without creating visitor memory",
    description="Runs the isolated publication model with no private harness prompts or tools. This consumes the owner's configured model.",
)
async def preview(
    body: PreviewTurn, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SelfReply:
    return await service.preview_self(_registry(user, server), user.id, body)


@router.post(
    "/me/access",
    response_model=SelfState,
    summary="Review access, revoke a visitor or decide a real-person contact request",
)
async def access(
    body: AccessCommand, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SelfState:
    return await service.review_access(_registry(user, server), user.id, body)


@router.get(
    "/me/visitors/{visitor_id}",
    response_model=HistoryPage,
    summary="Read a visitor's complete conversation and relationship memory",
)
async def visitor_history(
    visitor_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(40, ge=1, le=100),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> HistoryPage:
    registry = _registry(user, server)
    state = await service.read_self(registry, user.id)
    return await service.history_page(
        registry, user.id, state.id, offset, limit, visitor_id=visitor_id
    )


@router.get(
    "",
    response_model=DiscoveryPage,
    summary="Discover voluntarily published digital selves on this host",
    description="Only reviewed discovery metadata is returned. Cross-device public discovery remains gated on the WANX SDK restricted visitor contract; network_status indicates that prerequisite.",
)
async def discover(
    q: str = Query("", max_length=100),
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> DiscoveryPage:
    return await service.discover(_registry(user, server), user.id, q, offset, limit)


@router.get(
    "/{self_id}",
    response_model=SelfCard,
    summary="Read a published profile and actual local availability",
)
async def card(
    self_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SelfCard:
    return await service.public_card(_registry(user, server), user.id, self_id)


@router.post(
    "/{self_id}/access",
    response_model=SelfCard,
    summary="Request access or submit an introduction to the owner",
)
async def request_access(
    self_id: str,
    body: VisitorRequest,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> SelfCard:
    return await service.request_access(_registry(user, server), user.id, self_id, body)


@router.get(
    "/{self_id}/sources/{entry_id}",
    response_model=PublishedEntry,
    summary="Read a cited current published excerpt",
    description="Requires access. Returns only reviewed publication text, never private source IDs, paths or workspace files. Withdrawn or stale sources are unavailable.",
)
async def entry(
    self_id: str,
    entry_id: str,
    expected_version: str = Query("", max_length=100),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> PublishedEntry:
    return await service.published_entry(
        _registry(user, server), user.id, self_id, entry_id, expected_version
    )


@router.get(
    "/{self_id}/conversation",
    response_model=HistoryPage,
    summary="Read my own digital-self conversation and pending request state",
)
async def history(
    self_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(40, ge=1, le=100),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> HistoryPage:
    return await service.history_page(_registry(user, server), user.id, self_id, offset, limit)


@router.post(
    "/{self_id}/conversation",
    response_model=HistoryPage,
    summary="Ask an authorized digital self a question",
    description="Owner-visible, idempotent request ID, checked history and publication versions. One concurrent visitor; daily quotas use server timezone. Only current published excerpts and this visitor's history enter inference. Unknown requests are not automatically resent.",
)
async def turn(
    self_id: str,
    body: VisitorTurn,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> HistoryPage:
    return await service.visitor_turn(_registry(user, server), user.id, self_id, body)


@router.delete(
    "/{self_id}/conversation",
    response_model=HistoryPage,
    summary="Clear my consultation history and relationship memory",
    description="Checked revision and readback; removes both parties' application view and future context. Cannot retract copies already seen or saved outside the application.",
)
async def clear(
    self_id: str,
    body: HistoryCommand,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> HistoryPage:
    return await service.clear_history(_registry(user, server), user.id, self_id, body)
