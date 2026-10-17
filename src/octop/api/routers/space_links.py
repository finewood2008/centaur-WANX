"""Authenticated owner management and scoped agent operations."""

from __future__ import annotations

import base64
import binascii
import hashlib
from functools import partial
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import Field

from octop.api.routers.personal_space import Input, call, space
from octop.infra.personal_space.links import SpaceLinks
from octop.infra.personal_space.service import CHUNK_SIZE, PersonalSpace

router = APIRouter()


async def links(service: PersonalSpace = Depends(space)) -> SpaceLinks:
    return await call(SpaceLinks, service.root.parent, int(service.root.name))


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
