"""Private link management and session-independent HTTP file sharing."""

from __future__ import annotations

import html
import logging
import re
from collections.abc import AsyncIterator
from functools import partial
from typing import Any, Literal
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import Field

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import Input, call
from octop.infra.personal_space.service import CHUNK_SIZE
from octop.infra.personal_space.shares import SpaceShares

router = APIRouter(include_in_schema=False)
public_router = APIRouter(include_in_schema=False)


class RedactShareTokens(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = re.sub(r"/space-links/[^/?\s]+", "/space-links/[redacted]", str(record.msg))
        if isinstance(record.args, tuple):
            record.args = tuple(
                re.sub(r"/space-links/[^/?\s]+", "/space-links/[redacted]", value)
                if isinstance(value, str)
                else value
                for value in record.args
            )
        return True


def install_log_filter() -> None:
    for name in ("uvicorn.access", "octop.api.app"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactShareTokens) for f in logger.filters):
            logger.addFilter(RedactShareTokens())


def service(server: Any, user: Any = None) -> SpaceShares:
    return SpaceShares(
        server.paths.root,
        user.id if user else 0,
        (user.display_name or user.username) if user else "",
        admin=bool(user and user.role == "admin"),
        resolve_user=server.user_manager.get_by_id,
    )


async def authority(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> SpaceShares:
    if getattr(user, "application_id", "wanx") != "wanx":
        raise HTTPException(403, detail="SPACE_SHARE_DENIED")
    return await call(partial(service, server, user))


class Create(Input):
    operation_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    root: str = Field(pattern=r"^[a-f0-9]{32}$")
    space_id: str = Field(default="personal", max_length=32)
    domain: Literal["personal", "company"] = "personal"
    permission: Literal["read", "write"] = "read"
    days: Literal[0, 7, 30] = 0


class Operation(Input):
    action: str = Field(default="describe", max_length=40)
    target: str = Field(default="", max_length=32)
    parent: str | None = Field(default=None, max_length=32)
    name: str = Field(default="", max_length=240)
    expected: int | None = Field(default=None, ge=1)
    upload_id: str = Field(default="", max_length=32)
    size: int = Field(default=0, ge=0)
    offset: int = Field(default=0, ge=0)
    length: int | None = Field(default=None, ge=1, le=CHUNK_SIZE)
    digest: str = Field(default="", max_length=64)
    data: str = Field(default="", max_length=((CHUNK_SIZE + 2) // 3) * 4)


@router.post("")
async def create(body: Create, shares: SpaceShares = Depends(authority)) -> Any:
    return await call(
        partial(
            shares.create_share,
            body.operation_id,
            body.domain,
            body.root,
            body.space_id,
            body.permission,
            body.days,
        )
    )


@router.get("")
async def listing(shares: SpaceShares = Depends(authority)) -> Any:
    return await call(shares.list_shares)


@router.get("/{sid}")
async def details(sid: str, shares: SpaceShares = Depends(authority)) -> Any:
    return await call(partial(shares.manage_share, sid))


@router.delete("/{sid}")
async def revoke(sid: str, shares: SpaceShares = Depends(authority)) -> Any:
    return await call(partial(shares.manage_share, sid, revoke=True))


@router.post("/{sid}/dismiss")
async def dismiss(sid: str, shares: SpaceShares = Depends(authority)) -> Any:
    return await call(partial(shares.dismiss_share, sid))


HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
}


async def execute(server: Any, token: str, body: Operation) -> Any:
    shares = await call(partial(service, server))
    return await call(partial(shares.access, token, body.model_dump(exclude_none=True)))


@public_router.get("/{token}")
async def browse(
    token: str,
    request: Request,
    action: Literal["describe", "stat", "list", "read", "download", "write-status"] = "describe",
    target: str = Query(default="", max_length=32),
    offset: int = Query(default=0, ge=0),
    length: int | None = Query(default=None, ge=1, le=CHUNK_SIZE),
    expected: int | None = Query(default=None, ge=1),
    upload_id: str = Query(default="", max_length=32),
    server: Any = Depends(get_server),
) -> Response:
    if action == "download":
        shares = await call(partial(service, server))
        meta = await call(partial(shares.access, token, {"action": "stat", "target": target}))
        if meta["kind"] != "file":
            raise HTTPException(400, detail="SPACE_NOT_FILE")

        async def chunks() -> AsyncIterator[bytes]:
            position = 0
            while position < meta["size"]:
                raw, _ = await call(
                    partial(
                        shares.access,
                        token,
                        {
                            "action": "read",
                            "target": meta["id"],
                            "expected": meta["version"],
                            "offset": position,
                            "length": min(CHUNK_SIZE, meta["size"] - position),
                        },
                    )
                )
                if not raw:
                    raise RuntimeError("SPACE_DOWNLOAD_INCOMPLETE")
                position += len(raw)
                yield raw

        return StreamingResponse(
            chunks(),
            media_type="application/octet-stream",
            headers={
                **HEADERS,
                "Content-Length": str(meta["size"]),
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(meta["name"], safe=""),
                "X-Content-SHA256": meta["digest"] or "",
            },
        )
    body = Operation(
        action=action,
        target=target,
        offset=offset,
        length=length,
        expected=expected,
        upload_id=upload_id,
    )
    result = await execute(server, token, body)
    if action == "read":
        raw, meta = result
        return Response(
            raw,
            media_type="application/octet-stream",
            headers={
                **HEADERS,
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(meta["name"], safe=""),
                "X-Space-Version": str(meta["version"]),
                "X-Content-SHA256": meta["digest"] or "",
            },
        )
    wants_json = request.query_params.get(
        "format"
    ) == "json" or "application/json" in request.headers.get("accept", "")
    if wants_json or action not in {"describe", "list"}:
        return JSONResponse(result, headers=HEADERS)
    if action == "describe":
        meta = result["resource"]
        title = meta["name"]
        if meta["kind"] == "folder":
            entries = await execute(
                server, token, Operation(action="list", target=meta["id"], length=200)
            )
        else:
            entries = {"items": [meta], "next": None}
        mode = "只读" if result["permission"] == "read" else "成果回写 · 新建与版本化更新"
    else:
        meta = await execute(server, token, Operation(action="stat", target=target))
        title, mode, entries = meta["name"], "分享目录", result

    def href(**params: Any) -> str:
        return "?" + html.escape(urlencode(params), quote=True)

    rows = "".join(
        '<li><a href="'
        + href(action="list" if item["kind"] == "folder" else "download", target=item["id"])
        + '">'
        + ("📁 " if item["kind"] == "folder" else "📄 ")
        + html.escape(item["name"])
        + "</a><small>"
        + (str(item["size"]) + " B" if item["kind"] == "file" else "文件夹")
        + "</small></li>"
        for item in entries["items"]
    )
    more = (
        '<a href="'
        + href(action="list", target=meta["id"], offset=entries["next"])
        + '">下一页 →</a>'
        if entries["next"] is not None
        else ""
    )
    return HTMLResponse(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>万象空间分享</title><style>body{background:#faf8f4;color:#302d29;font:16px system-ui;margin:48px auto;padding:0 24px;max-width:760px}h1{font-size:26px}small,p{color:#8a8073}a{color:#a35d40;text-decoration:none}ul{padding:0;list-style:none;border-top:1px solid #ddd3c5}li{display:flex;justify-content:space-between;gap:16px;padding:18px 0;border-bottom:1px solid #ddd3c5}header{margin-bottom:32px}footer{margin-top:32px;font-size:14px}</style><header><p>万象空间 · 分享链接</p><h1>'
        + html.escape(title)
        + "</h1><p>"
        + mode
        + "</p></header><ul>"
        + (rows or "<li>暂无文件</li>")
        + "</ul>"
        + more
        + '<footer><a href="?format=json">Agent 接入说明（JSON）</a><p>持有链接即可访问获准资料。有效性由盒子端持续校验。</p></footer></html>',
        headers=HEADERS,
    )


@public_router.post("/{token}")
async def mutate(token: str, body: Operation, server: Any = Depends(get_server)) -> Response:
    if body.action in {"read", "describe", "list", "stat"}:
        raise HTTPException(405, detail="USE_GET_FOR_READS")
    result = await execute(server, token, body)
    return JSONResponse(result, headers=HEADERS)
