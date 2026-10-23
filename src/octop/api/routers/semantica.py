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


internal_router = APIRouter(prefix="/internal/starklink", tags=["semantica"])


@internal_router.post("/models", include_in_schema=False)
async def model_internal(request: Request, server: Any = Depends(get_server)) -> JSONResponse:
    if not request.client or request.client.host not in {"127.0.0.1", "::1"}:
        return JSONResponse({"code": "MODEL_AUTH_REQUIRED"}, status_code=403)
    from octop.infra.semantica.models import internal

    try:
        data = await internal(
            await request.body(),
            request.headers,
            server.services,
            request.is_disconnected,
        )
        return JSONResponse(data, headers={"Cache-Control": "no-store"})
    except SemanticaError as exc:
        return JSONResponse(
            {"code": exc.code, "message": exc.message or exc.code},
            status_code=exc.status,
        )


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
        scope_mode = request.headers.get("x-wanx-data-context", "personal")
        if scope_mode not in {"personal", "team"}:
            raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
        team = scope_mode == "team"
        if team and (user.role != "admin" or application_id(user) != "wanx"):
            raise SemanticaError("SEMANTICA_ADMIN_REQUIRED", 403)
        if application_id(user) not in {
            "wanx",
            "semantica",
            "centaurai.wanx.semantica",
        }:
            raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
        service = SemanticaClient.from_file(
            server.services.paths.root / "semantica.json", user.id, application_id(user), team=team
        )
        payload = None
        if request.method != "GET":
            data = await request.body()
            if len(data) > (
                6 * 1024 * 1024 if path.endswith("/skills/import") else 2 * 1024 * 1024
            ):
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
                request.method,
                "/" + path,
                payload=payload,
                query=dict(request.query_params),
            )
        if (
            team
            and request.method == "POST"
            and __import__("re").fullmatch(r"warehouses/[a-f0-9-]{36}/keys", path)
            and result.get("token")
        ):
            # Capture a newly issued Key inside WANX; deployment inputs contain only its id.
            record = {
                "token": result["token"],
                "warehouse": path.split("/")[1],
                "box": service.config["box_id"],
            }
            server.services.secret_repo.get_or_create(
                "studio-team-data/key/" + result["key"]["id"], lambda: json.dumps(record).encode()
            )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except SemanticaError as exc:
        return JSONResponse(
            {"code": exc.code, "message": exc.message},
            status_code=exc.status,
            headers={"Cache-Control": "no-store"},
        )
