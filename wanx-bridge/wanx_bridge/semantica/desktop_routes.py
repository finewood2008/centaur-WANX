"""Authenticated desktop HTTP adapter; permission authority remains WANX."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.requests import ClientDisconnect

from .desktop import APPS, DesktopConfig, DesktopError, prepare, request_json, resolve, strict_json


def field(session: Any, key: str) -> Any:
    return session[key] if isinstance(session, Mapping) else getattr(session, key)


async def bounded_body(request: Request, limit: int) -> bytes:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            raise DesktopError("SEMANTICA_REQUEST_TOO_LARGE", 413)
    return bytes(raw)


async def live_request(
    request: Request, work: Awaitable, watch: Awaitable, drained: asyncio.Event
) -> Any:
    async def disconnect():
        await drained.wait()
        while True:
            if (await request.receive())["type"] == "http.disconnect":
                raise ClientDisconnect()

    tasks = [
        asyncio.create_task(work),
        asyncio.create_task(watch),
        asyncio.create_task(disconnect()),
    ]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in tasks[1:]:
            if task in done:
                await task
        return await tasks[0]
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def identity(client: httpx.AsyncClient, origin: str, session: Any, *, public: bool) -> dict:
    request = client.build_request(
        "GET",
        origin + "/api/auth/me",
        headers={"authorization": "Bearer " + field(session, "upstream_token")},
        timeout=10,
    )
    request.headers.pop("cookie", None)
    try:
        response = await client.send(request)
        if response.status_code != 200:
            raise DesktopError(
                "SEMANTICA_IDENTITY_UNAVAILABLE", 403 if response.status_code in {401, 403} else 503
            )
        profile = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise DesktopError("SEMANTICA_IDENTITY_UNAVAILABLE") from exc
    if not isinstance(profile, dict) or profile.get("id") != field(session, "user").get("id"):
        raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
    if type(profile.get("id")) is not int or profile["id"] < 1:
        raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
    if not public and (
        profile.get("application_id", "wanx") not in APPS
        or (
            profile.get("role") != "admin"
            and "knowledge_bases" not in (profile.get("permissions") or [])
        )
    ):
        raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
    return profile


def create_desktop_router(
    *,
    config_file: Path,
    service_url: str | None,
    box_id: str | None = None,
    octop_url: str,
    client: httpx.AsyncClient,
    authorize: Callable,
    forward: Callable,
    watch: Callable,
    assert_live: Callable,
) -> APIRouter:
    router = APIRouter(prefix="/api/semantica", tags=["semantica-desktop"])

    @router.api_route(
        "",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    @router.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        summary="Call the STARLINK desktop API through WANX",
        description="WANX authorizes the current user and supplies the warehouse context to the private Semantica service. JSON results and errors retain the desktop format.",
    )
    async def desktop(request: Request, path: str = "") -> Response:
        session = await authorize(request)
        if request.headers.get("x-wanx-data-context", "personal") != "personal":
            # Core owns team administrator checks and stores issued warehouse keys
            # for Builder. Do not turn a team request into a personal grant here.
            try:
                resolve(request.method, "/" + path)
            except DesktopError as exc:
                return JSONResponse(
                    {"code": exc.code, "message": exc.message},
                    status_code=exc.status,
                    headers={"Cache-Control": "no-store"},
                )
            return await forward(
                request,
                path="/api/semantica" + ("/" + path if path else ""),
                target_origin=octop_url,
                session=session,
                token=field(session, "upstream_token"),
                guard_resources=False,
            )
        drained = asyncio.Event()

        async def execute():
            operation = resolve(request.method, "/" + path)
            async with asyncio.timeout(30):
                raw = await bounded_body(request, operation.body_limit)
            drained.set()
            body = None
            if request.method != "GET":
                if (
                    request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    != "application/json"
                ):
                    raise DesktopError("SEMANTICA_INVALID_REQUEST", 422)
                try:
                    body = strict_json(raw)
                    if not isinstance(body, dict):
                        raise ValueError()
                except (ValueError, UnicodeError) as exc:
                    raise DesktopError("SEMANTICA_INVALID_REQUEST", 422) from exc
            elif raw:
                raise DesktopError("SEMANTICA_INVALID_REQUEST", 422)
            query = {}
            for key, value in request.query_params.multi_items():
                if key in {"token", "access_token"}:
                    continue
                if key in query:
                    raise DesktopError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
                query[key] = value
            body, op = prepare(operation, request.method, body, query)
            profile = await identity(client, octop_url, session, public=operation.public)
            config = await asyncio.to_thread(DesktopConfig.load, config_file, service_url, box_id)
            await assert_live(session)
            if operation.public:
                keys = request.headers.getlist("x-xingtu-key")
                if len(keys) != 1 or not re.fullmatch(r"xg_[A-Za-z0-9_-]{30,80}", keys[0]):
                    raise DesktopError("ACCESS_KEY_INVALID", 403)
                headers = {"authorization": "Bearer " + keys[0]}
                prefix = "/api/open/v1"
            else:
                headers = config.headers(
                    profile["id"],
                    profile.get("application_id", "wanx"),
                    op,
                    operation.warehouse,
                    owner_view=operation.path == "/owner/graph",
                    ttl=max(120, operation.timeout + 15),
                )
                prefix = "/api/integration"
            async with asyncio.timeout(operation.timeout):
                status, value = await request_json(
                    client,
                    request.method,
                    config.service_url + prefix + operation.path,
                    headers=headers,
                    payload=body,
                    query=query,
                    timeout=operation.timeout,
                    public=operation.public,
                )
            await assert_live(session)
            await identity(client, octop_url, session, public=operation.public)
            await assert_live(session)
            return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})

        try:
            return await live_request(request, execute(), watch(session), drained)
        except DesktopError as exc:
            return JSONResponse(
                {"code": exc.code, "message": exc.message},
                status_code=exc.status,
                headers={"Cache-Control": "no-store"},
            )
        except TimeoutError:
            return JSONResponse(
                {"code": "SEMANTICA_SERVICE_TIMEOUT", "message": None},
                status_code=504,
                headers={"Cache-Control": "no-store"},
            )
        except ClientDisconnect:
            return Response(status_code=499)

    @router.websocket("")
    @router.websocket("/{path:path}")
    async def unsupported(websocket: WebSocket):
        await websocket.close(code=4403)

    return router
