"""Authenticated, per-user business actions for the SDK box-management host."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user
from octop.infra.boxes.management import BoxManagementError, BoxManagementService
from octop.infra.users.identity import User

router = APIRouter()
ManagementAction = Literal[
    "state",
    "account.sendSMS",
    "account.login",
    "account.logout",
    "devices.list",
    "ota.status",
    "ota.request",
    "transfers.list",
    "transfers.create",
    "transfers.accept",
    "support.list",
    "support.create",
    "support.revoke",
    "clients.list",
    "clients.revoke",
    "factory.reset",
]


class ManagementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: ManagementAction
    input: dict[str, Any] = Field(default_factory=dict)


@router.post("/action", summary="Run a box management SDK business action")
async def management_action(
    body: ManagementRequest, request: Request, user: User = Depends(current_user)
) -> Any:
    if user.application_id != "wanx":
        raise HTTPException(status_code=403, detail="WANX_REQUIRED")
    service: BoxManagementService = request.app.state.box_management
    try:
        return await service.action(user.id, body.action, body.input)
    except BoxManagementError as error:
        code = str(error)
        raise HTTPException(
            status_code=503 if code == "SDK_HOST_UNAVAILABLE" else 400, detail=code
        ) from None


def mount_box_management(app: FastAPI) -> None:
    service = BoxManagementService()
    app.state.box_management = service
    app.include_router(router, prefix="/api/box-management", tags=["boxes"])
    previous = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[Any]:
        async with previous(application) as state:
            try:
                yield state
            finally:
                await service.close()

    app.router.lifespan_context = lifespan
