"""Existing sockets must not survive application or account authorization changes."""

from __future__ import annotations

import asyncio
import gc
import threading
from typing import Any

import pytest
from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect
from tests.support.http import ws_connect

from octop.api.middleware import application_sessions
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.identity import User


@pytest.fixture
def guarded_app(monkeypatch: pytest.MonkeyPatch) -> tuple[FastAPI, dict[str, Any]]:
    app = FastAPI()
    state: dict[str, Any] = {"revoked": False, "cleaned": False, "inputs": []}
    user = User(id=3, username="operator", role="user", display_name=None)

    def resolve(_server: Any, _token: str) -> User:
        if state["revoked"]:
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        return user

    monkeypatch.setattr(application_sessions, "resolve_user_from_token", resolve)
    monkeypatch.setattr(application_sessions, "assert_application_request", lambda *a, **k: None)
    monkeypatch.setattr(application_sessions, "_RECHECK_SECONDS", 0.01)
    app.add_middleware(application_sessions.ApplicationSessionMiddleware, server=object())

    @app.websocket("/api/sample/ws")
    async def socket(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                value = await ws.receive_json()
                state["inputs"].append(value)
                await ws.send_json({"ok": True})
        except WebSocketDisconnect:
            pass
        finally:
            state["cleaned"] = True

    return app, state


async def test_revocation_rejects_next_input_before_side_effect(guarded_app: Any) -> None:
    app, state = guarded_app
    async with ws_connect(app, "/api/sample/ws?token=synthetic") as ws:
        await ws.send_json({"first": True})
        assert await ws.receive_json() == {"ok": True}
        state["revoked"] = True
        await ws.send_json({"forbidden": True})
        with pytest.raises(WebSocketDisconnect):
            await ws.receive_json()
    assert state["inputs"] == [{"first": True}]
    assert state["cleaned"]


async def test_revocation_closes_idle_connection_and_cleans_handler(guarded_app: Any) -> None:
    app, state = guarded_app
    async with ws_connect(app, "/api/sample/ws?token=synthetic") as ws:
        await ws.send_json({"first": True})
        await ws.receive_json()
        state["revoked"] = True
        with pytest.raises(WebSocketDisconnect):
            await ws.receive_json(timeout=1)
        await asyncio.sleep(0)
    assert state["cleaned"]


async def test_start_frame_credentials_are_guarded_too(guarded_app: Any) -> None:
    app, state = guarded_app
    async with ws_connect(app, "/api/sample/ws") as ws:
        await ws.send_json({"type": "start", "token": "synthetic"})
        assert await ws.receive_json() == {"ok": True}
        state["revoked"] = True
        with pytest.raises(WebSocketDisconnect):
            await ws.receive_json(timeout=1)
    assert state["cleaned"]


async def test_concurrent_revocation_closes_once_and_reaps_both_tasks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stream send and the idle guard can fail authorization simultaneously."""
    barrier = threading.Barrier(2)
    state: dict[str, Any] = {"revoked": False, "closed": 0, "cleaned": False}
    user = User(id=3, username="operator", role="user", display_name=None)

    def resolve(_server: Any, _token: str) -> User:
        if state["revoked"]:
            barrier.wait(timeout=2)
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        return user

    monkeypatch.setattr(application_sessions, "resolve_user_from_token", resolve)
    monkeypatch.setattr(application_sessions, "assert_application_request", lambda *a, **k: None)
    monkeypatch.setattr(application_sessions, "_RECHECK_SECONDS", 0.001)

    async def endpoint(_scope: Any, _receive: Any, send: Any) -> None:
        try:
            await send({"type": "websocket.accept"})
            state["revoked"] = True
            await send({"type": "websocket.send", "text": "must not reach the client"})
        finally:
            state["cleaned"] = True

    async def receive() -> dict[str, Any]:
        return {"type": "websocket.connect"}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "websocket.close":
            state["closed"] += 1
            if state["closed"] > 1:
                raise RuntimeError("ASGI websocket.close after socket already closed")
        assert message["type"] != "websocket.send"

    loop = asyncio.get_running_loop()
    original_handler = loop.get_exception_handler()
    unhandled: list[dict[str, Any]] = []
    loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
    try:
        middleware = application_sessions.ApplicationSessionMiddleware(endpoint, server=object())
        await asyncio.wait_for(
            middleware(
                {"type": "websocket", "path": "/api/sample/ws", "query_string": b"token=synthetic"},
                receive,
                send,
            ),
            timeout=3,
        )
        gc.collect()
        await asyncio.sleep(0)
        assert state["closed"] == 1
        assert state["cleaned"]
        assert not unhandled
    finally:
        loop.set_exception_handler(original_handler)


@pytest.mark.parametrize("revocation_trigger", ["input", "idle"])
async def test_terminal_permission_revocation_closes_existing_session(
    monkeypatch: pytest.MonkeyPatch, revocation_trigger: str
) -> None:
    """A still-valid WANX login cannot retain a revoked native module grant."""
    app = FastAPI()
    state: dict[str, Any] = {"revoked": False, "cleaned": False, "inputs": []}
    identities: list[User] = []

    def resolve(_server: Any, _token: str) -> User:
        user = User(
            id=3,
            username="operator",
            role="user",
            display_name=None,
            application_id="wanx",
            permissions=[] if state["revoked"] else ["terminal"],
        )
        identities.append(user)
        return user

    monkeypatch.setattr(application_sessions, "resolve_user_from_token", resolve)
    monkeypatch.setattr(application_sessions, "assert_application_request", lambda *a, **k: None)
    monkeypatch.setattr(application_sessions, "_RECHECK_SECONDS", 0.01)
    app.add_middleware(application_sessions.ApplicationSessionMiddleware, server=object())

    @app.websocket("/api/agents/agent-one/terminal/ws")
    async def terminal(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                value = await ws.receive_json()
                state["inputs"].append(value)
                await ws.send_json({"ok": True})
        except WebSocketDisconnect:
            pass
        finally:
            state["cleaned"] = True

    async with ws_connect(app, "/api/agents/agent-one/terminal/ws?token=synthetic") as ws:
        await ws.send_json({"type": "input", "data": "allowed-before-revocation"})
        assert await ws.receive_json() == {"ok": True}
        state["revoked"] = True
        if revocation_trigger == "input":
            await ws.send_json({"type": "input", "data": "forbidden-after-revocation"})
        with pytest.raises(WebSocketDisconnect):
            await ws.receive_json(timeout=1)
        await asyncio.sleep(0)

    assert state["inputs"] == [{"type": "input", "data": "allowed-before-revocation"}]
    assert state["cleaned"]
    assert identities[0].permissions == ["terminal"]
    assert identities[-1].permissions == []
    assert identities[-1] is not identities[0]
