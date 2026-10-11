"""Public WANX boundary; the unmodified upstream is reachable only on loopback.

No upstream implementation modules, database files, or signing secrets are used here.
Only the adapter holds an ordinary upstream login session. Public callers use an
opaque bridge token whose authority is checked for the entire request/stream.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

import anyio
import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.datastructures import Headers, QueryParams
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake

from .assets import DashboardAssets, installed_dashboard
from .config import BridgeAuthError
from .upstream import BridgeUpstreamError

_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
    }
)
_SECRET_RESPONSE = frozenset({"set-cookie", "x-octop-access-token", "authorization"})
_TOKEN_PARAMS = frozenset({"token", "access_token"})
_PUBLIC = frozenset({"/api/health"})
_PROFILE = frozenset(
    {
        ("GET", "/api/auth/me"),
        ("PATCH", "/api/auth/me"),
        ("POST", "/api/auth/me/avatar"),
        ("DELETE", "/api/auth/me/avatar"),
    }
)


def _field(session: Any, name: str) -> Any:
    return session[name] if isinstance(session, Mapping) else getattr(session, name)


async def _call(fn: Any, *args: Any) -> Any:
    result = fn(*args)
    return await result if inspect.isawaitable(result) else result


def _error(code: str, status: int = 401) -> BridgeAuthError:
    return BridgeAuthError(code, status)


def _credentials(headers: Headers, query: QueryParams, *, required: bool) -> str | None:
    """Reject ambiguous credentials instead of selecting an attacker-controlled one."""
    values = []
    for header in headers.getlist("authorization"):
        scheme, _, value = header.partition(" ")
        if scheme.lower() != "bearer" or not value or value.strip() != value:
            raise _error("BOX_PLATFORM_AUTH_REQUIRED")
        values.append(value)
    values.extend(v for k, v in query.multi_items() if k in _TOKEN_PARAMS)
    if any(not v for v in values) or len(set(values)) > 1:
        raise _error("BOX_PLATFORM_AUTH_CONFLICT")
    if not values:
        if required:
            raise _error("BOX_PLATFORM_AUTH_REQUIRED")
        return None
    return values[0]


def _allowed(path: str, method: str) -> bool:
    # Match decoded ASGI paths, reject traversal and slash aliases before httpx
    # normalizes them. Never forward public /docs or /.well-known provider routes.
    if "\\" in path or "//" in path or any(p in {".", ".."} for p in path.split("/")):
        return False
    if path in {"/docs", "/redoc", "/openapi.json"} or path.startswith(
        ("/.well-known", "/oidc", "/internal")
    ):
        return False
    if path.startswith("/api/auth"):
        return (method, path) in _PROFILE
    # Dashboard boot probes setup before /auth/me. This read-only exception
    # still requires the current platform session in proxy(), unlike /api/health.
    if path == "/api/setup/status" and method == "GET":
        return True
    if path.startswith(("/api/setup", "/api/config", "/api/internal")):
        return False
    # The platform owns identities and role authority. Even a current Owner
    # must not persistently promote a different platform member in upstream DB.
    if path.startswith("/api/users") and method not in {"GET", "HEAD"}:
        return False
    # Metadata is safe to inspect with a live session and upstream backup
    # permission. Archives contain JWT/OIDC secrets; transfer and restoration
    # remain local-administration operations.
    if path.startswith("/api/admin/backup"):
        return method == "GET" and path in {
            "/api/admin/backup/list",
            "/api/admin/backup/status",
            "/api/admin/backup/auto",
        }
    return True


def _headers(headers: Any, token: str | None, *, websocket: bool = False) -> list[tuple[str, str]]:
    connection = {v.strip().lower() for v in headers.get("connection", "").split(",")}
    blocked = _HOP | connection | {"authorization", "cookie", "forwarded"}
    output = [
        (k, v)
        for k, v in headers.items()
        if k.lower() not in blocked and not k.lower().startswith(("x-forwarded-", "sec-websocket-"))
    ]
    if token:
        output.append(("authorization", f"Bearer {token}"))
    if websocket:
        output = [(k, v) for k, v in output if k.lower() not in {"origin", "content-length"}]
    return output


def _target(origin: str, path: str, query: Any, token: str | None) -> str:
    params = [
        (k, token if k in _TOKEN_PARAMS and token else v)
        for k, v in query.multi_items()
        if k not in _TOKEN_PARAMS or token
    ]
    suffix = urlencode(params)
    return origin + quote(path, safe="/") + ("?" + suffix if suffix else "")


def _response_headers(response: httpx.Response, origin: str) -> dict[str, str]:
    connection = {v.strip().lower() for v in response.headers.get("connection", "").split(",")}
    blocked = _HOP | _SECRET_RESPONSE | connection
    output = {k: v for k, v in response.headers.items() if k.lower() not in blocked}
    if "location" in output:
        location = urlsplit(output["location"])
        # Never hand an upstream JWT, OAuth code, or external credential redirect
        # to a renderer. Relative ordinary app redirects remain supported.
        if location.fragment or any(
            k.lower() in _TOKEN_PARAMS | {"code", "id_token"} for k, _ in parse_qsl(location.query)
        ):
            raise _error("BOX_PLATFORM_UPSTREAM_REDIRECT", 502)
        if location.netloc:
            base = urlsplit(origin)
            if (location.scheme, location.netloc) != (base.scheme, base.netloc):
                raise _error("BOX_PLATFORM_UPSTREAM_REDIRECT", 502)
            output["location"] = location.path + ("?" + location.query if location.query else "")
    return output


async def _body(request: Request, limit: int = 16384) -> dict[str, Any]:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise _error("BOX_PLATFORM_BODY_TOO_LARGE", 413)
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise _error("BOX_PLATFORM_INVALID_REQUEST", 400) from None
    if not isinstance(value, dict):
        raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
    return value


def create_app(
    auth: Any,
    adapter: Any,
    *,
    upstream_url: str = "http://127.0.0.1:18088",
    http_transport: Any = None,
    lease_check_interval: float = 0.25,
    dashboard_dir: Path | None = None,
) -> FastAPI:
    parsed = urlsplit(upstream_url)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("upstream_url must be a loopback HTTP origin")
    assets = DashboardAssets(dashboard_dir or installed_dashboard())
    origin = upstream_url.rstrip("/")
    client = httpx.AsyncClient(
        transport=http_transport,
        follow_redirects=False,
        trust_env=False,
        timeout=httpx.Timeout(connect=10, read=None, write=60, pool=10),
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await client.aclose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.exception_handler(BridgeAuthError)
    @app.exception_handler(BridgeUpstreamError)
    async def auth_error(_: Request, exc: BridgeAuthError | BridgeUpstreamError) -> JSONResponse:
        return JSONResponse({"code": exc.code, "detail": exc.code}, status_code=exc.status)

    @app.exception_handler(httpx.HTTPError)
    async def upstream_error(_: Request, exc: httpx.HTTPError) -> JSONResponse:
        # Exception URLs may contain the upstream token; never return them.
        return JSONResponse({"code": "BOX_PLATFORM_UPSTREAM_UNAVAILABLE"}, status_code=502)

    async def watch(session: Any) -> None:
        while True:
            await _call(auth.assert_live, session)
            await asyncio.sleep(lease_check_interval)

    @app.post("/api/auth/platform/challenge")
    async def challenge(request: Request) -> JSONResponse:
        body = await _body(request)
        values = [body.get(key) for key in ("accountId", "clientId", "networkSessionId")]
        if any(not isinstance(value, str) or not value for value in values):
            raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
        return JSONResponse(
            await _call(auth.challenge, *values), headers={"Cache-Control": "no-store"}
        )

    @app.post("/api/auth/platform/exchange")
    async def exchange(request: Request) -> JSONResponse:
        body = await _body(request)
        grant = body.get("grant")
        if not isinstance(grant, str) or not grant:
            raise _error("BOX_PLATFORM_INVALID_REQUEST", 400)
        return JSONResponse(
            await _call(auth.exchange, grant, adapter), headers={"Cache-Control": "no-store"}
        )

    @app.get("/api/platform/assets/manifest")
    async def asset_manifest(request: Request) -> JSONResponse:
        marker = _credentials(request.headers, request.query_params, required=True)
        session = await _call(auth.authorize, marker)
        manifest = await assets.manifest()
        await _call(auth.assert_live, session)
        return JSONResponse(manifest, headers={"Cache-Control": "no-store"})

    @app.api_route(
        "/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    )
    async def proxy(request: Request, path: str) -> Response:
        path = "/" + path
        if not _allowed(path, request.method):
            raise _error("BOX_PLATFORM_ROUTE_FORBIDDEN", 403)
        protected = path == "/api" or path.startswith("/api/") and path not in _PUBLIC
        marker = _credentials(request.headers, request.query_params, required=protected)
        session = await _call(auth.authorize, marker) if marker else None
        token = _field(session, "upstream_token") if session else None
        if path.startswith("/assets/"):
            asset_response = await assets.response(request, path)
            if asset_response is not None:
                if session:
                    await _call(auth.assert_live, session)
                return asset_response
        guard = asyncio.create_task(watch(session)) if session else None
        upstream = None
        pending = None
        try:
            req = client.build_request(
                request.method,
                _target(origin, path, request.query_params, token),
                headers=_headers(request.headers, token),
                content=request.stream(),
            )
            # AsyncClient keeps a shared response cookie jar. Never let a prior
            # upstream response attach another user's cookies to this request.
            req.headers.pop("cookie", None)
            pending = asyncio.create_task(client.send(req, stream=True))
            if guard:
                done, _ = await asyncio.wait({pending, guard}, return_when=asyncio.FIRST_COMPLETED)
                if guard in done:
                    await guard
            upstream = await pending
            headers = _response_headers(upstream, origin)
        except BaseException:
            if pending and not pending.done():
                pending.cancel()
                with contextlib.suppress(BaseException):
                    await pending
            elif pending and upstream is None:
                with contextlib.suppress(BaseException):
                    upstream = pending.result()
            if upstream:
                await upstream.aclose()
            if guard:
                guard.cancel()
                with contextlib.suppress(BaseException):
                    await guard
            raise

        async def stream() -> AsyncIterator[bytes]:
            iterator = upstream.aiter_raw().__aiter__()
            chunk_task: asyncio.Task[bytes] | None = None

            async def next_chunk() -> bytes:
                return await anext(iterator)

            try:
                while True:
                    chunk_task = asyncio.create_task(next_chunk())
                    if guard:
                        done, _ = await asyncio.wait(
                            {chunk_task, guard}, return_when=asyncio.FIRST_COMPLETED
                        )
                        if guard in done:
                            # Headers may already be sent. Close the stream, never
                            # continue delivering bytes after lease revocation.
                            with contextlib.suppress(BridgeAuthError):
                                await guard
                            return
                    try:
                        yield await chunk_task
                    except StopAsyncIteration:
                        return
            finally:
                # StreamingResponse cancels its task group on disconnect. Shield
                # cleanup so the HTTP pool never retains an orphaned SSE socket.
                with anyio.CancelScope(shield=True):
                    if chunk_task and not chunk_task.done():
                        chunk_task.cancel()
                        with contextlib.suppress(BaseException):
                            await chunk_task
                    if guard:
                        guard.cancel()
                        with contextlib.suppress(BaseException):
                            await guard
                    await upstream.aclose()

        return StreamingResponse(stream(), status_code=upstream.status_code, headers=headers)

    @app.websocket("/{path:path}")
    async def websocket_proxy(websocket: WebSocket, path: str) -> None:
        path = "/" + path
        tasks = []
        try:
            if not path.startswith("/api/") or not _allowed(path, "WEBSOCKET"):
                raise _error("BOX_PLATFORM_ROUTE_FORBIDDEN", 403)
            marker = _credentials(websocket.headers, websocket.query_params, required=True)
            session = await _call(auth.authorize, marker)
            await _call(auth.assert_live, session)
            # One snapshot for both query and desktop start message. Renewals
            # update authority, but must not switch an established WS identity.
            token = _field(session, "upstream_token")
            target = _target(origin, path, websocket.query_params, token)
            target = ("wss" if parsed.scheme == "https" else "ws") + target[target.index(":") :]
            async with ws_connect(
                target,
                additional_headers=_headers(websocket.headers, token, websocket=True),
                max_size=None,
                max_queue=16,
                open_timeout=10,
                close_timeout=2,
                proxy=None,
            ) as upstream:
                await _call(auth.assert_live, session)
                await websocket.accept()

                async def incoming() -> None:
                    while True:
                        message = await websocket.receive()
                        if message["type"] == "websocket.disconnect":
                            return
                        await _call(auth.assert_live, session)
                        payload = message.get("bytes")
                        if payload is None:
                            payload = message.get("text", "")
                            if path.endswith("/desktop-stream/ws") or path.endswith(
                                "/mobile-stream/ws"
                            ):
                                try:
                                    value = json.loads(payload)
                                except ValueError:
                                    value = None
                                if isinstance(value, dict) and value.get("type") == "start":
                                    if value.get("token") is not None and value["token"] != marker:
                                        raise _error("BOX_PLATFORM_AUTH_CONFLICT")
                                    value["token"] = token
                                    payload = json.dumps(value)
                        await upstream.send(payload)

                async def outgoing() -> None:
                    async for message in upstream:
                        await _call(auth.assert_live, session)
                        if isinstance(message, bytes):
                            await websocket.send_bytes(message)
                        else:
                            await websocket.send_text(message)

                tasks = [
                    asyncio.create_task(incoming()),
                    asyncio.create_task(outgoing()),
                    asyncio.create_task(watch(session)),
                ]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    await task
        except BridgeAuthError:
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close(code=4401, reason="BOX_PLATFORM_SESSION_ENDED")
        except (ConnectionClosed, WebSocketDisconnect):
            pass
        except (OSError, TimeoutError, InvalidHandshake):
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close(code=1011, reason="BOX_PLATFORM_UPSTREAM_UNAVAILABLE")
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close()

    return app
