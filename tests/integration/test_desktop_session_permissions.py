"""Desktop viewers cannot inject input or maintain the host environment."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from starlette.websockets import WebSocketDisconnect

from octop.api.routers.desktop import stream
from tests.support.app import octop_client
from tests.support.auth import auth_header, bootstrap_admin, ensure_users
from tests.support.http import ws_connect


@pytest.fixture
async def desktop_env(tmp_octop_home: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Any]:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(
        stream,
        "desktop_status",
        lambda **k: SimpleNamespace(setup_state="ready", ok=True, display=None),
    )

    async def acquire(**kwargs: Any) -> Any:
        return SimpleNamespace(display=None)

    async def release(**kwargs: Any) -> None:
        pass

    async def frames(*args: Any, **kwargs: Any) -> None:
        await asyncio.Event().wait()

    async def inject(ws: Any, session: Any, msg: dict[str, Any], **kwargs: Any) -> None:
        calls.append(msg)
        await ws.send_json({"type": "action_result", "ok": True})

    monkeypatch.setattr(stream, "acquire_session", acquire)
    monkeypatch.setattr(stream, "release_session", release)
    monkeypatch.setattr(stream, "_stream_loop", frames)
    monkeypatch.setattr(stream, "_handle_input", inject)
    async with octop_client(tmp_octop_home) as (client, server):
        await bootstrap_admin(client, tmp_octop_home)
        admin = await auth_header(client)
        users = await ensure_users(client, admin, "viewer", "controller")
        await server.user_manager.set_permissions("viewer", ["desktop"])
        await server.user_manager.set_permissions("controller", ["desktop", "desktop_control"])
        yield client, server, users, calls


async def test_viewer_forged_input_and_maintenance_denied(desktop_env: Any) -> None:
    client, server, users, calls = desktop_env
    auth = users["viewer"]
    async with ws_connect(client._octop_app, "/api/desktop-stream/ws") as ws:
        await ws.send_json({"type": "start", "token": auth["Authorization"][7:]})
        assert await ws.receive_json() == {"type": "session", "mode": "view"}
        await ws.send_json({"type": "click", "x": 2, "y": 3})
        assert (await ws.receive_json())["code"] == "FORBIDDEN"
    assert not calls
    for path, body in [("install", {}), ("uninstall", {}), ("geometry", {"geometry": "800x600"})]:
        response = await client.post(f"/api/desktop/{path}", headers=auth, json=body)
        assert response.status_code == 403
    events = server.services.audit_repo.query(actor="viewer")
    assert {row.action for row in events} >= {"desktop.session.start", "desktop.session.end"}


async def test_control_requires_explicit_mode_and_fresh_permission(desktop_env: Any) -> None:
    client, server, users, calls = desktop_env
    auth = users["controller"]
    async with ws_connect(client._octop_app, "/api/desktop-stream/ws") as ws:
        await ws.send_json({"type": "start", "mode": "control", "token": auth["Authorization"][7:]})
        assert await ws.receive_json() == {"type": "session", "mode": "control"}
        await ws.send_json({"type": "click"})
        assert (await ws.receive_json())["ok"]
        await server.user_manager.set_permissions("controller", ["desktop"])
        await ws.send_json({"type": "click"})
        assert (await ws.receive_json())["code"] == "FORBIDDEN"
    assert len(calls) == 1


async def test_viewer_cannot_claim_control_mode(desktop_env: Any) -> None:
    client, _server, users, calls = desktop_env
    async with ws_connect(client._octop_app, "/api/desktop-stream/ws") as ws:
        await ws.send_json(
            {"type": "start", "mode": "control", "token": users["viewer"]["Authorization"][7:]}
        )
        with pytest.raises(WebSocketDisconnect) as error:
            await ws.receive_json()
        assert error.value.code == 4003
    assert not calls
