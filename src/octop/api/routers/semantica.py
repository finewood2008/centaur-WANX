"""Authenticated WANX transport for a user's independent knowledge space."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from octop.api.deps import current_user, get_server, require_permission
from octop.infra.agents.application import application_id
from octop.infra.semantica.client import SemanticaClient, SemanticaError

router = APIRouter(prefix="/semantica", tags=["semantica"])


@router.get("/open/v1/{path:path}", operation_id="xingtu_open_read")
@router.post("/open/v1/{path:path}", operation_id="xingtu_open_search")
async def xingtu_open_request(
    path: str,
    request: Request,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> JSONResponse:
    try:
        service = SemanticaClient.from_file(
            server.services.paths.root / "semantica.json", user.id, application_id(user)
        )
        payload = None
        if request.method == "POST":
            data = await request.body()
            if len(data) > 128 * 1024:
                raise SemanticaError("SEMANTICA_REQUEST_TOO_LARGE", 413)
            try:
                payload = json.loads(data)
                if not isinstance(payload, dict):
                    raise ValueError("invalid payload")
            except ValueError:
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from None
        result = await service.public_read(
            request.method,
            "/" + path,
            request.headers.get("x-xingtu-key", ""),
            payload=payload,
            query=dict(request.query_params),
        )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except SemanticaError as exc:
        return JSONResponse(
            {"code": exc.code, "message": exc.message},
            status_code=exc.status,
            headers={"Cache-Control": "no-store"},
        )


@router.get(
    "/{path:path}",
    operation_id="semantica_read",
    summary="Read Semantica materials, jobs, knowledge or evidence",
)
@router.post(
    "/{path:path}",
    operation_id="semantica_create_or_search",
    summary="Import materials or retrieve evidence in your knowledge space",
)
@router.put(
    "/{path:path}",
    operation_id="semantica_update",
    summary="Update your Semantica protection settings",
)
@router.patch(
    "/{path:path}",
    operation_id="semantica_patch",
    summary="Apply an allowed Semantica workspace operation",
)
async def semantica_request(
    path: str,
    request: Request,
    user: Any = Depends(require_permission("knowledge_bases")),
    server: Any = Depends(get_server),
) -> JSONResponse:
    try:
        if application_id(user) not in {"wanx", "semantica", "centaurai.wanx.semantica"}:
            raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
        service = SemanticaClient.from_file(
            server.services.paths.root / "semantica.json", user.id, application_id(user)
        )
        payload = None
        if request.method != "GET":
            data = await request.body()
            if len(data) > 2 * 1024 * 1024:
                raise SemanticaError("SEMANTICA_REQUEST_TOO_LARGE", 413)
            try:
                payload = json.loads(data)
                if not isinstance(payload, dict):
                    raise ValueError("invalid payload")
            except ValueError:
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422) from None
        if path == "search" and request.method == "POST":
            result = await service.search(payload or {})
        else:
            result = await service.request(
                request.method, "/" + path, payload=payload, query=dict(request.query_params)
            )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except SemanticaError as exc:
        return JSONResponse(
            {"code": exc.code, "message": exc.message},
            status_code=exc.status,
            headers={"Cache-Control": "no-store"},
        )
