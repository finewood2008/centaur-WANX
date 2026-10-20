"""Owner clipboard operations. Agent access uses the credential-checked space bridge."""

import asyncio
import base64
import hashlib
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .service import ClipboardService
from .upstream import CHUNK_SIZE, WanxAPI
from .upstream import BusinessError as SpaceError


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


async def call(operation, *args):
    return await asyncio.to_thread(operation, *args)


async def service(request: Request):
    api = WanxAPI(request.app.state.wanx, request.headers.get("authorization", ""))
    request.state.wanx_api = api
    owner = await call(api.owner)
    return await call(ClipboardService, request.app.state.home, owner, api, request.app.state.locks)


Store = Annotated[ClipboardService, Depends(service)]

router = APIRouter()


class ItemInput(Input):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    kind: Literal["text", "image"]
    name: str = Field(min_length=1, max_length=240)
    mime: str = Field(default="application/octet-stream", max_length=100)
    size: int = Field(ge=0, le=20 * 1024 * 1024)
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    device: str = Field(max_length=100)


class BatchInput(Input):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    items: list[ItemInput] = Field(min_length=1, max_length=20)


class CompleteInput(Input):
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class Target(Input):
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    expected: int = Field(ge=1)


class ManageInput(Input):
    action: Literal["pin", "unpin", "rename", "trash", "restore", "purge", "cancel"]
    targets: list[Target] = Field(min_length=1, max_length=50)
    name: str = Field(default="", max_length=240)


class ExportInput(Input):
    expected: int = Field(ge=1)
    id: str = Field(pattern=r"^[0-9a-f]{32}$")
    parent: str = Field(default="", pattern=r"^([0-9a-f]{32})?$")
    space_id: str = Field(default="personal", max_length=32)


class ClipItem(ItemInput):
    # Historical attachments remain readable/exportable; new batches cannot create them.
    kind: Literal["text", "image", "file"]
    original_name: str
    created: float
    saved: float | None
    expires: float | None
    pinned: bool
    trashed: float | None
    version: int
    state: str
    preview: str
    offset: int | None = None


class Usage(Input):
    used: int
    reserved: int
    limit: int


class Listing(Input):
    revision: int
    usage: Usage
    items: list[ClipItem] | None = None
    next_offset: int | None = None
    unchanged: bool = False


class BatchResult(Input):
    items: list[ClipItem]
    usage: Usage


class ManageResult(Input):
    ok: bool


class NoteBlock(Input):
    type: Literal["text", "image"]
    text: str | None = None
    item: str | None = None


class NoteInput(Input):
    expected: int = Field(ge=0)
    operation: str = Field(pattern=r"^[a-f0-9]{32}$")
    blocks: list[NoteBlock] = Field(default_factory=list, max_length=2000)
    action: Literal["save", "clear", "restore"] = "save"


@router.get("/note", summary="Read the single shared note or poll its revision")
async def note_get(since: int | None = Query(default=None, ge=0), store: Store = None):
    return await call(store.note_get, since)


@router.put("/note", summary="Atomically save the shared note with conflict and replay protection")
async def note_save(body: NoteInput, store: Store = None):
    return await call(
        store.note_save,
        body.expected,
        body.operation,
        [b.model_dump(exclude_none=True) for b in body.blocks],
        body.action,
    )


@router.get("", response_model=Listing, summary="Search shared clipboard and poll its revision")
async def listing(
    kind: Literal["all", "text", "image", "file"] = "all",
    q: str = Query(default="", max_length=200),
    offset: int = Query(default=0, ge=0),
    trash: bool = False,
    since: int | None = Query(default=None, ge=0),
    store: Store = None,
) -> Any:
    return await call(store.clipboard_list, kind, q, offset, trash, since)


@router.post(
    "/batches",
    response_model=BatchResult,
    summary="Reserve a validated complete batch; repeated IDs are idempotent",
)
async def batch(body: BatchInput, store: Store = None) -> Any:
    return await call(store.clipboard_batch, body.id, [i.model_dump() for i in body.items])


@router.post(
    "/manage",
    response_model=ManageResult,
    summary="Version-checked pin, rename, recycle, restore or purge",
)
async def manage(body: ManageInput, store: Store = None) -> Any:
    return await call(
        store.clipboard_manage, body.action, [t.model_dump() for t in body.targets], body.name
    )


@router.get(
    "/{item_id}",
    response_model=ClipItem,
    summary="Inspect an active clipboard item or its upload offset",
)
async def stat(item_id: str, store: Store = None) -> Any:
    return await call(store.clipboard_stat, item_id)


@router.put(
    "/{item_id}/content", summary="Write a bounded verified chunk to a reserved clipboard item"
)
async def chunk(
    item_id: str,
    request: Request,
    checksum: str = Header(alias="X-Content-SHA256", max_length=64),
    offset: int = Query(ge=0),
    store: Store = None,
) -> Any:
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > CHUNK_SIZE:
            return await call(_too_large)
    return await call(store.clipboard_chunk, item_id, offset, bytes(data), checksum)


def _too_large() -> None:
    raise SpaceError("CLIPBOARD_LIMIT", 413)


@router.post(
    "/{item_id}/complete",
    response_model=ClipItem,
    summary="Verify complete content before making it visible on other devices",
)
async def complete(item_id: str, body: CompleteInput, store: Store = None) -> Any:
    return await call(store.clipboard_complete, item_id, body.digest)


@router.get(
    "/{item_id}/content", summary="Read a versioned clipboard chunk, never recycled content"
)
async def read(
    item_id: str,
    offset: int = Query(default=0, ge=0),
    length: int = Query(default=1048576, ge=1, le=CHUNK_SIZE),
    expected: int | None = Query(default=None, ge=1),
    store: Store = None,
) -> Response:
    content, item = await call(store.clipboard_read, item_id, offset, length, expected)
    return Response(
        content,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Content-SHA256": hashlib.sha256(content).hexdigest(),
            "X-File-SHA256": item["digest"],
            "ETag": str(item["version"]),
        },
    )


@router.post(
    "/{item_id}/export", summary="Create an independent verified file in a selected space directory"
)
async def export(item_id: str, body: ExportInput, store: Store = None) -> Any:
    return await call(
        store.clipboard_export, item_id, body.expected, body.id, body.parent, body.space_id
    )


class AgentInput(Input):
    action: Literal["clipboard-list", "clipboard-read"]
    target: str = Field(default="", max_length=32)
    clip_kind: Literal["all", "text", "image", "file"] = "all"
    query: str = Field(default="", max_length=200)
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=1048576, ge=1, le=1048576)
    expected: int | None = Field(default=None, ge=1)
    task_id: str = Field(default="", max_length=32)
    policy_revision: int | None = Field(default=None, ge=0)
    grant_id: str = Field(default="", max_length=32)


@router.post("/agent-access", summary="Read shared clipboard after live WANX Agent and task checks")
async def agent_access(body: AgentInput, request: Request, store: Store = None):
    token = request.headers.get("x-space-link", "")
    args = body.model_dump()
    outcome = "ok"
    try:
        await call(store.api.check_agent, token, args)
        if body.action == "clipboard-list":
            result = await call(store.clipboard_list, body.clip_kind, body.query, body.offset)
            result["note"] = await call(store.note_get)
        elif body.target == "note":
            result = await call(store.note_get)
            if body.expected is not None and body.expected != result["revision"]:
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            result["text"] = "\n".join(
                b["text"] if b["type"] == "text" else "[image:" + b["item"] + "]"
                for b in result["blocks"]
            )
        else:
            content, item = await call(
                store.clipboard_read, body.target, body.offset, body.length, body.expected
            )
            result = {
                "item": item,
                "offset": body.offset,
                "size": len(content),
                "digest": hashlib.sha256(content).hexdigest(),
                "data": base64.b64encode(content).decode(),
                "encoding": "base64",
            }
            if item["kind"] == "text" and body.offset == 0 and len(content) == item["size"]:
                result["text"] = content.decode("utf-8")
        # A revoke/pause/account change during content fetching must not release bytes.
        await call(store.api.check_agent, token, args)
        return result
    except SpaceError as exc:
        outcome = exc.code
        raise
    finally:
        await call(store.audit, token, body.action, body.target, outcome)
