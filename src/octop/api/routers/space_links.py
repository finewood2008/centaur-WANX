"""Authenticated owner management and scoped agent operations."""

from __future__ import annotations

import base64
import binascii
import hashlib
from functools import partial
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import Field

from octop.api.routers.personal_space import Input, call, space
from octop.infra.personal_space.links import SpaceLinks
from octop.infra.personal_space.service import CHUNK_SIZE, PersonalSpace
from octop.infra.personal_space.workspaces import Workspaces

router = APIRouter()


async def links(service: PersonalSpace = Depends(space)) -> Workspaces:
    if isinstance(service, Workspaces):
        return service
    return await call(Workspaces, service.root.parent, int(service.root.name))


class CreateLink(Input):
    root: str = Field(pattern=r"^[0-9a-f]{32}$")
    expires: float | None = Field(default=None, allow_inf_nan=False)


class LinkCreated(Input):
    id: str
    token: str
    root: str
    expires: float | None


class LinkInfo(Input):
    id: str
    root: str
    created: float
    expires: float | None
    revoked: float | None
    last_used: float | None
    name: str | None
    kind: str | None


class Operation(Input):
    action: Literal[
        "describe",
        "stat",
        "list",
        "read",
        "mkdir",
        "move",
        "trash",
        "restore",
        "restore-version",
        "begin-write",
        "write-chunk",
        "commit-write",
        "write-status",
        "cancel-write",
    ]
    target: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    parent: str | None = Field(default=None, pattern=r"^([0-9a-f]{32})?$")
    name: str = Field(default="", max_length=240)
    expected: int | None = Field(default=None, ge=1)
    upload_id: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    size: int = Field(default=0, ge=0, le=2**53 - 1)
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=200, ge=1, le=CHUNK_SIZE)
    digest: str = Field(default="", pattern=r"^([a-f0-9]{64})?$")
    data: str = Field(
        default="",
        max_length=(CHUNK_SIZE + 2) // 3 * 4,
        description="Base64 chunk, at most 4 MiB decoded.",
    )
    agent: str = Field(
        default="",
        max_length=80,
        description="Self-declared display name, not an authenticated identity.",
    )


@router.post(
    "/agent-links",
    response_model=LinkCreated,
    summary="Create a scoped agent capability; token returned once",
)
async def create(body: CreateLink, service: SpaceLinks = Depends(links)) -> Any:
    return await call(service.create_link, body.root, body.expires)


@router.get(
    "/agent-links",
    response_model=list[LinkInfo],
    summary="List this account's resource links without credentials",
)
async def listing(service: SpaceLinks = Depends(links)) -> Any:
    return await call(service.links)


@router.delete(
    "/agent-links/{link_id}",
    status_code=204,
    summary="Revoke a resource link and cancel its pending uploads",
)
async def revoke(link_id: str, service: SpaceLinks = Depends(links)) -> Response:
    await call(service.revoke, link_id)
    return Response(status_code=204)


@router.get(
    "/agent-links/{link_id}/audit", summary="Read the last 100 operations for an owned link"
)
async def audit(link_id: str, service: SpaceLinks = Depends(links)) -> list[dict[str, Any]]:
    return await call(service.audit, link_id)


@router.post(
    "/agent-access",
    summary="Execute one capability-scoped operation with transactional boundary checks",
    description="Requires both the signed-in owner session and X-Space-Link token. Read returns a bounded binary chunk; other actions return JSON. Writes require the observed entry version.",
)
async def execute(
    body: Operation,
    token: Annotated[str, Header(alias="X-Space-Link", max_length=100)],
    service: SpaceLinks = Depends(links),
) -> Any:
    args = body.model_dump(exclude={"action", "data"})
    try:
        data = base64.b64decode(body.data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(400, detail={"code": "SPACE_CHUNK_INVALID"}) from exc
    result = await call(partial(service.execute, token, body.action, data=data, **args))
    if body.action == "read":
        content, entry = result
        return Response(
            content,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Content-SHA256": hashlib.sha256(content).hexdigest(),
                "ETag": str(entry["version"]),
                "X-File-SHA256": entry["digest"],
            },
        )
    return result


class SpaceManagement(Input):
    action: Literal["rename", "trash", "restore"]
    name: str = Field(default="", max_length=240)


class StorageLocation(Input):
    path: str = Field(
        default="",
        max_length=4096,
        description="Existing absolute directory on the WANX host. Empty restores managed default storage. Existing files are verified and migrated before switching.",
    )


class Approval(Input):
    credential: str = Field(default="", pattern=r"^([A-Za-z0-9_-]{43})?$")
    profile: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=240)
    space_id: str = Field(default="", max_length=32)
    sync_policy: dict[str, Any] | None = Field(
        default=None,
        description="Owner-selected synchronization categories; omitted preserves legacy file-only access.",
    )


class SyncPolicyInput(Input):
    options: dict[str, Any]
    expected: int = Field(ge=0, description="Observed synchronization policy revision.")


class ConnectionAction(Input):
    action: Literal["pause", "resume", "disconnect"]


class GrantInput(Input):
    root: str = Field(pattern=r"^[0-9a-f]{32}$")


class TransferInput(Input):
    parent: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    space_id: str = Field(default="personal", max_length=32)
    copy_items: bool = Field(default=False, alias="copy")


class AppFolderInput(Input):
    application: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=240)


class AgentOperation(Operation):
    action: Literal[
        "access",
        "describe",
        "stat",
        "list",
        "read",
        "mkdir",
        "move",
        "trash",
        "restore",
        "restore-version",
        "begin-write",
        "write-chunk",
        "commit-write",
        "write-status",
        "cancel-write",
        "sync-status",
        "task-begin",
        "task-checkpoint",
        "task-finish",
        "task-records",
    ]  # type: ignore[assignment]
    grant_id: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    task_id: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    request_id: str = Field(default="", max_length=100)
    operation_id: str = Field(default="", max_length=80)
    policy_revision: int | None = Field(default=None, ge=0)
    title: str = Field(default="", max_length=240)
    categories: dict[str, Any] = Field(
        default_factory=dict,
        description="Selected task context, progress and outcome summaries; data, never instructions.",
    )
    progress: str = Field(default="", max_length=8192)


@router.get("/spaces", summary="List your personal and Agent spaces including recycled spaces")
async def list_spaces(service: Workspaces = Depends(links)) -> Any:
    return await call(service.spaces)


@router.post("/spaces/{space_id}/manage", summary="Rename, recycle or restore an Agent space")
async def manage_space(
    space_id: str, body: SpaceManagement, service: Workspaces = Depends(links)
) -> Any:
    return await call(service.manage_space, space_id, body.action, body.name)


@router.post(
    "/spaces/{space_id}/storage", summary="Migrate one owned space to a host storage directory"
)
async def change_storage(
    space_id: str, body: StorageLocation, service: Workspaces = Depends(links)
) -> Any:
    return await call(service.storage_location, space_id, body.path)


@router.post("/connections", summary="Owner approval creates a credential-bound Agent space")
async def approve_connection(body: Approval, service: Workspaces = Depends(links)) -> Any:
    return await call(
        service.approve, body.profile, body.name, body.space_id, body.credential, body.sync_policy
    )


@router.get(
    "/connections/{connection}/sync",
    summary="Inspect owner-selected synchronization rules and the last 50 task summaries",
)
async def sync_status(connection: str, service: Workspaces = Depends(links)) -> Any:
    return await call(service.sync_status, connection)


@router.post(
    "/connections/{connection}/sync",
    summary="Change synchronization categories with an observed policy revision",
)
async def sync_policy(
    connection: str, body: SyncPolicyInput, service: Workspaces = Depends(links)
) -> Any:
    return await call(service.set_sync_policy, connection, body.options, body.expected)


@router.get(
    "/connections/{connection}/tasks/{task_id}",
    summary="Read a page of task handoff records without granting another Agent access",
)
async def sync_records(
    connection: str,
    task_id: str,
    offset: int = Query(default=0, ge=0),
    service: Workspaces = Depends(links),
) -> Any:
    return await call(service.sync_records, connection, task_id, offset)


@router.delete(
    "/connections/{connection}/tasks/{task_id}",
    summary="Owner deletes task context and retained snapshots; file outputs are kept",
)
async def delete_sync_task(
    connection: str, task_id: str, service: Workspaces = Depends(links)
) -> Any:
    return await call(service.delete_sync_task, connection, task_id)


@router.post("/connections/{connection}/manage", summary="Pause, resume or disconnect an Agent")
async def manage_connection(
    connection: str, body: ConnectionAction, service: Workspaces = Depends(links)
) -> Any:
    return await call(service.connection_action, connection, body.action)


@router.get("/connections/{connection}/grants", summary="List extra read-write grants")
async def list_grants(connection: str, service: Workspaces = Depends(links)) -> Any:
    return await call(service.grants, connection)


@router.post("/connections/{connection}/grants", summary="Owner grants one resource to an Agent")
async def add_grant(connection: str, body: GrantInput, service: Workspaces = Depends(links)) -> Any:
    return await call(service.grant, connection, body.root)


@router.delete(
    "/connections/{connection}/grants/{grant}", status_code=204, summary="Revoke an extra grant"
)
async def revoke_grant(
    connection: str, grant: str, service: Workspaces = Depends(links)
) -> Response:
    await call(service.revoke_grant, connection, grant)
    return Response(status_code=204)


@router.get("/connections/{connection}/audit", summary="Recent operations for one Agent identity")
async def connection_audit(connection: str, service: Workspaces = Depends(links)) -> Any:
    return await call(service.connection_audit, connection)


@router.post("/files/{item_id}/transfer", summary="Owner copy or confirmed move between spaces")
async def transfer(item_id: str, body: TransferInput, service: Workspaces = Depends(links)) -> Any:
    return await call(service.transfer, item_id, body.parent, body.space_id, body.copy_items)


@router.post("/app-folders", summary="Resolve or create an application default folder")
async def app_folder(body: AppFolderInput, service: Workspaces = Depends(links)) -> Any:
    return await call(service.app_folder, body.application, body.name)


@router.post(
    "/connection-access", summary="Operate inside an approved Agent space or explicit extra grant"
)
async def connection_access(
    body: AgentOperation,
    token: Annotated[str, Header(alias="X-Space-Link", max_length=100)],
    service: Workspaces = Depends(links),
) -> Any:
    args = body.model_dump(exclude={"action", "data", "grant_id"})
    try:
        data = base64.b64decode(body.data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(400, detail={"code": "SPACE_CHUNK_INVALID"}) from exc
    result = await call(
        partial(service.agent_execute, token, body.action, body.grant_id, data=data, **args)
    )
    if body.action == "read":
        content, entry = result
        return Response(
            content,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Content-SHA256": hashlib.sha256(content).hexdigest(),
                "ETag": str(entry["version"]),
                "X-File-SHA256": entry["digest"],
            },
        )
    return result
