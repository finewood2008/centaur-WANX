"""Private WANX management surface; the independent MCP transport lives at /mcp/space."""

from __future__ import annotations

from functools import partial
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS
from pydantic import Field

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import Input, call
from octop.infra.personal_space.mcp_access import SpaceMcp, memory_import_prompt

router = APIRouter(include_in_schema=False)
Domain = Literal["personal", "company"]


async def authority(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SpaceMcp:
    if getattr(user, "application_id", "wanx") != "wanx":
        raise HTTPException(403, detail="MCP_ACCESS_DENIED")
    return await call(
        partial(
            SpaceMcp,
            server.paths.root,
            user.id,
            user.display_name or user.username,
            admin=user.role == "admin",
        )
    )


class Issue(Input):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    credential: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    name: str = Field(min_length=1, max_length=80)
    destination: Domain = "personal"
    expires: float | None = Field(default=None, allow_inf_nan=False)


class Authorization(Input):
    domain: Domain
    root: str = Field(pattern=r"^[a-f0-9]{32}$")
    purpose: Literal["reference", "output", "memory"] = "reference"


class TextWrite(Input):
    grant_id: str = Field(default="", pattern=r"^([a-f0-9]{32})?$")
    operation_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_:-]+$")
    text: str = Field(max_length=1024 * 1024)
    target: str = Field(default="", pattern=r"^([a-f0-9]{32})?$")
    name: str = Field(default="", max_length=240)
    expected: int | None = Field(default=None, ge=1)


class MemorySection(Input):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=300000)


class MemoryArchive(Input):
    grant_id: str = Field(default="", pattern=r"^([a-f0-9]{32})?$")
    operation_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_:-]+$")
    title: str = Field(min_length=1, max_length=100)
    source: str = Field(min_length=1, max_length=500)
    coverage: str = Field(min_length=1, max_length=10000)
    sections: list[MemorySection] = Field(min_length=1, max_length=40)


@router.get("")
async def overview(
    destination: Domain = "personal",
    service: SpaceMcp = Depends(authority),
    server: Any = Depends(get_server),
) -> Any:
    def read() -> dict[str, Any]:
        return {
            "connections": service.connections(),
            "drives": service.drives(),
            "archives": sorted(
                service.archives_list(destination)
                + (service.archives_list("personal") if destination == "company" else []),
                key=lambda item: item["created"],
                reverse=True,
            )[:100],
            "destination": destination,
            "admin": service.admin,
            "activity": service.activity(),
            "endpointPath": "/mcp/space",
            "transport": "streamable-http",
            "protocolVersions": SUPPORTED_PROTOCOL_VERSIONS,
            "serverHosted": True,
            "timeZone": server.services.config.default_timezone,
        }

    return await call(read)


@router.post("/connections")
async def issue(body: Issue, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.issue, body.model_dump())


@router.delete("/connections/{aid}")
async def revoke_connection(aid: str, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.revoke_connection, aid)


@router.post("/connections/{aid}/grants")
async def grant(aid: str, body: Authorization, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.authorize, aid, body.domain, body.root, body.purpose)


@router.delete("/connections/{aid}/grants/{gid}")
async def revoke_grant(aid: str, gid: str, service: SpaceMcp = Depends(authority)) -> Any:
    await call(service.connection, aid)
    return await call(service.revoke, aid, gid)


@router.get("/connections/{aid}/prompt")
async def prompt(aid: str, service: SpaceMcp = Depends(authority)) -> Any:
    def read() -> dict[str, Any]:
        with service.db() as db:
            service.drive(db, aid, write=True)
            value = service.drive(db, aid)
        return {"prompt": memory_import_prompt(value), "drive": value}

    return await call(read)


class DriveAction(Input):
    action: Literal["pause", "resume", "rename"]
    name: str = Field(default="", max_length=80)


class Rotate(Input):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    credential: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class FileParams(Input):
    id: str = Field(default="", pattern=r"^([a-f0-9]{32})?$")
    parent: str = Field(default="", pattern=r"^([a-f0-9]{32})?$")
    space_id: str = Field(default="", max_length=40)
    name: str = Field(default="", max_length=240)
    size: int = Field(default=0, ge=0, le=2**53 - 1)
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=1024 * 1024, ge=1, le=4 * 1024 * 1024)
    expected: int = Field(default=1, ge=1)
    digest: str = Field(default="", pattern=r"^([a-f0-9]{64})?$")
    data: str = Field(default="", max_length=5592408)
    trash: bool = False


class DriveFiles(Input):
    action: Literal[
        "list",
        "stat",
        "read",
        "mkdir",
        "move",
        "trash",
        "restore",
        "purge",
        "previous",
        "upload-create",
        "upload-status",
        "upload-chunk",
        "upload-complete",
        "upload-cancel",
    ]
    params: FileParams = Field(default_factory=FileParams)


@router.get("/drives")
async def drives(service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.drives)


@router.post("/drives/{aid}/files")
async def drive_files(aid: str, body: DriveFiles, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.drive_files, aid, body.action, body.params.model_dump())


@router.post("/connections/{aid}/manage")
async def manage(aid: str, body: DriveAction, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.manage_drive, aid, body.action, body.name)


@router.post("/connections/{aid}/rotate")
async def rotate(aid: str, body: Rotate, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.rotate, aid, body.model_dump())


@router.get("/folders")
async def folders(
    domain: Domain = "personal", parent: str = "", service: SpaceMcp = Depends(authority)
) -> Any:
    return await call(service.browse, domain, parent)


@router.get("/archives/{archive_id}")
async def archive(archive_id: str, service: SpaceMcp = Depends(authority)) -> Any:
    return await call(service.archive_preview, archive_id)
