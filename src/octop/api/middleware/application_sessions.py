"""Revalidate scoped WebSocket sessions, including already-open connections."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any
from urllib.parse import parse_qs

from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect

from octop.api.common.application_access import assert_application_request
from octop.api.deps import resolve_user_from_token
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.permissions import user_has_permission

_RECHECK_SECONDS = 1.0


class ApplicationSessionMiddleware:
    """Check incoming/outgoing frames and close idle sessions after revocation."""

    def __init__(self, app: ASGIApp, *, server: Any) -> None:
        self.app = app
        self.server = server

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "websocket" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return

        query = parse_qs(scope.get("query_string", b"").decode("utf-8"))
        token = (query.get("token") or query.get("access_token") or [None])[-1]
        closed = False
        credentials_ready = asyncio.Event()
        if token:
            credentials_ready.set()

        def validate() -> None:
            if not token:
                return
            user = resolve_user_from_token(self.server, token)
            path = scope["path"]
            assert_application_request(self.server, user, path=path, method="WEBSOCKET")
            permission = {
                "/api/desktop-stream/ws": "desktop",
                "/api/mobile-stream/ws": "mobile",
                "/api/mobile/adb/shell/ws": "mobile",
            }.get(path)
            if path.startswith("/api/agents/") and path.endswith("/terminal/ws"):
                permission = "terminal"
            if permission and not user_has_permission(user, permission):
                raise OctopError.localized(ErrorCode.FORBIDDEN)

        async def check() -> None:
            nonlocal closed
            if closed:
                raise WebSocketDisconnect(code=4403)
            try:
                await asyncio.get_running_loop().run_in_executor(None, validate)
            except OctopError as exc:
                code = 4404 if exc.status == 404 else 4003
                if exc.code in {
                    ErrorCode.AUTH_FAILED,
                    ErrorCode.TOKEN_EXPIRED,
                    ErrorCode.USER_DISABLED,
                }:
                    code = 4001
                if not closed:
                    closed = True
                    await send({"type": "websocket.close", "code": code, "reason": exc.code.value})
                raise WebSocketDisconnect(code=code) from exc
            if closed:
                raise WebSocketDisconnect(code=4403)

        async def receive_checked() -> Message:
            nonlocal token
            message = await receive()
            if message["type"] == "websocket.disconnect":
                return message
            if message["type"] == "websocket.receive" and message.get("text"):
                try:
                    payload = json.loads(message["text"])
                except (json.JSONDecodeError, TypeError):
                    payload = None
                if isinstance(payload, dict) and payload.get("type") == "start":
                    presented = payload.get("token")
                    if isinstance(presented, str) and presented.strip():
                        # The signed identity cannot change within an open socket.
                        if token and token != presented.strip():
                            await send({"type": "websocket.close", "code": 4404})
                            raise WebSocketDisconnect(code=4404)
                        token = presented.strip()
                        credentials_ready.set()
            if token:
                await check()
            return message

        async def send_checked(message: Message) -> None:
            nonlocal closed
            if message["type"] == "websocket.close":
                if not closed:
                    closed = True
                    await send(message)
                return
            if token:
                await check()
            await send(message)

        async def watch() -> None:
            await credentials_ready.wait()
            while not closed:
                await asyncio.sleep(_RECHECK_SECONDS)
                await check()

        async def handle() -> None:
            await self.app(scope, receive_checked, send_checked)

        handler = asyncio.create_task(handle())
        guard = asyncio.create_task(watch())
        try:
            done, _ = await asyncio.wait({handler, guard}, return_when=asyncio.FIRST_COMPLETED)
            if guard in done:
                with contextlib.suppress(WebSocketDisconnect):
                    await guard
                handler.cancel()
                with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect):
                    await handler
            else:
                with contextlib.suppress(WebSocketDisconnect):
                    await handler
        finally:
            for task in (guard, handler):
                if not task.done():
                    task.cancel()
            await asyncio.gather(guard, handler, return_exceptions=True)
