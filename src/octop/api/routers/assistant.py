"""Owner-private native assistant bootstrap and history organization."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.agents.assistant_history import AssistantHistory
from octop.infra.agents.assistant_profile import AssistantProfiles

router = APIRouter()


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
