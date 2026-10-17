"""Current-user drive shared by authenticated WANX applications (v1)."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import sqlite3
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.personal_space.service import CHUNK_SIZE, PersonalSpace, SpaceError

router = APIRouter()


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FolderInput(Input):
    parent: str = Field(
        default="", max_length=32, description="Opaque parent folder id; empty is the user's root."
    )
    name: str = Field(min_length=1, max_length=240)


class UploadInput(FolderInput):
    id: str = Field(
        pattern=r"^[0-9a-f]{32}$", description="Client-generated idempotency id for this upload."
    )
    size: int = Field(ge=0, le=2**53 - 1)


class CompleteInput(Input):
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class Entry(BaseModel):
    id: str
    parent: str
    name: str
    kind: str
    size: int
    modified: float
    trashed: float | None = None
    digest: str | None = None
    version: int = 1
    previous_size: int = 0
    previous_digest: str | None = None


class Breadcrumb(BaseModel):
    id: str
    name: str


class Listing(BaseModel):
    items: list[Entry]
    breadcrumbs: list[Breadcrumb]
    parent: str


class UploadStatus(BaseModel):
    id: str
    parent: str
    name: str
    size: int
    offset: int
    state: str
    modified: float


class Volume(BaseModel):
    scope: str
    total: int
    used: int
    free: int


class Memory(BaseModel):
    scope: str
    total: int
    used: int
    percent: float


class CPU(BaseModel):
    scope: str
    percent: float


class Overview(BaseModel):
    protocolVersion: int
    chunkSize: int
    collectedAt: float
    filesBytes: int
    pendingBytes: int
    volume: Volume
    memory: Memory | None
    cpu: CPU | None
    container: bool


async def space(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> PersonalSpace:
    return await call(PersonalSpace, server.paths.root / ".wanx-personal-space", user.id)


async def call[T](operation: Callable[..., T], *args: Any) -> T:
    try:
        return await asyncio.to_thread(operation, *args)
    except SpaceError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code}) from exc
    except OSError as exc:
        code = (
            "SPACE_DISK_FULL"
            if exc.errno in {errno.ENOSPC, errno.EDQUOT}
            else "SPACE_STORAGE_UNAVAILABLE"
        )
        raise HTTPException(
            507 if code == "SPACE_DISK_FULL" else 503, detail={"code": code}
        ) from exc
    except sqlite3.Error as exc:
        raise HTTPException(503, detail={"code": "SPACE_STORAGE_UNAVAILABLE"}) from exc


@router.get(
    "/overview",
    response_model=Overview,
    summary="Personal space capability and measured storage resources",
)
async def overview(service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.overview)


@router.get("/files", response_model=Listing, summary="List your files or recycle bin")
async def files(
    parent: str = Query(default="", max_length=32),
    trash: bool = False,
    service: PersonalSpace = Depends(space),
) -> Any:
    return await call(service.listing, parent, trash)


@router.post(
    "/folders",
    response_model=Entry,
    summary="Create a private folder; preserve both names on conflict",
)
async def mkdir(body: FolderInput, service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.mkdir, body.parent, body.name)


@router.patch(
    "/files/{item_id}", response_model=Entry, summary="Move or rename your file or folder"
)
async def move(item_id: str, body: FolderInput, service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.move, item_id, body.parent, body.name)


@router.delete(
    "/files/{item_id}", status_code=204, summary="Move your file or folder into the recycle bin"
)
async def trash(item_id: str, service: PersonalSpace = Depends(space)) -> Response:
    await call(service.trash, item_id)
    return Response(status_code=204)


@router.post(
    "/trash/{item_id}/restore",
    response_model=Entry,
    summary="Restore a recycled item; preserve both names on conflict",
)
async def restore(item_id: str, service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.restore, item_id)


@router.delete("/trash/{item_id}", status_code=204, summary="Permanently remove your recycled item")
async def purge(item_id: str, service: PersonalSpace = Depends(space)) -> Response:
    await call(service.purge, item_id)
    return Response(status_code=204)


@router.post(
    "/uploads",
    response_model=UploadStatus,
    summary="Create or recover an upload; no visible file until commit",
)
async def upload(body: UploadInput, service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.upload_create, body.parent, body.name, body.size, body.id)


@router.get(
    "/uploads/{upload_id}", response_model=UploadStatus, summary="Read the durable upload offset"
)
async def upload_status(upload_id: str, service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.upload_status, upload_id)


@router.put("/uploads/{upload_id}", summary="Append one SHA-256 checked chunk, at most 4 MiB")
async def chunk(
    upload_id: str,
    request: Request,
    offset: int = Query(ge=0),
    service: PersonalSpace = Depends(space),
) -> dict[str, int]:
    data = bytearray()
    async for part in request.stream():
        if len(data) + len(part) > CHUNK_SIZE:
            raise HTTPException(413, detail={"code": "SPACE_CHUNK_TOO_LARGE"})
        data.extend(part)
    return await call(
        service.upload_chunk,
        upload_id,
        offset,
        bytes(data),
        request.headers.get("x-content-sha256", ""),
    )


@router.post(
    "/uploads/{upload_id}/complete",
    response_model=Entry,
    summary="Atomically publish a complete upload",
)
async def complete(
    upload_id: str, body: CompleteInput, service: PersonalSpace = Depends(space)
) -> Any:
    return await call(service.upload_complete, upload_id, body.digest)


@router.delete("/uploads/{upload_id}", status_code=204, summary="Discard an unfinished upload")
async def cancel(upload_id: str, service: PersonalSpace = Depends(space)) -> Response:
    await call(service.upload_cancel, upload_id)
    return Response(status_code=204)


@router.get(
    "/files/{item_id}/content",
    summary="Read a bounded file range after ownership verification",
    responses={200: {"content": {"application/octet-stream": {}}}},
)
async def content(
    item_id: str,
    offset: int = Query(default=0, ge=0),
    length: int = Query(default=CHUNK_SIZE, ge=1, le=CHUNK_SIZE),
    service: PersonalSpace = Depends(space),
) -> Response:
    data, row = await call(service.read_chunk, item_id, offset, length)
    return Response(
        data,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
            "ETag": row["digest"],
        },
    )


@router.get(
    "/files/{item_id}", response_model=Entry, summary="Read metadata of your own active file"
)
async def metadata(item_id: str, service: PersonalSpace = Depends(space)) -> Any:
    return await call(service.metadata, item_id)


class PreviousVersionInput(Input):
    expected: int = Field(ge=1)


@router.post(
    "/files/{item_id}/previous",
    response_model=Entry,
    summary="Restore the retained previous file version",
)
async def previous_version(
    item_id: str, body: PreviousVersionInput, service: PersonalSpace = Depends(space)
) -> Any:
    return await call(service.restore_version, item_id, body.expected)
