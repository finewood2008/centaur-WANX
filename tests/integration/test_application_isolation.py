"""Two application tokens for one owner cannot cross native resource boundaries."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from starlette.websockets import WebSocketDisconnect

from octop.api.deps import resolve_user_from_token
from octop.api.routers.chat.models import ChatTurnBody
from octop.api.routers.chat.turn import build_dashboard_inbound, prepare_dashboard_turn
from octop.infra.agents.manager import AgentCreateSpec
from octop.infra.errors import OctopError
from tests.support.app import octop_client
from tests.support.auth import (
    auth_header,
    bearer,
    bootstrap_admin,
    create_agent,
    seed_openai_provider,
)
from tests.support.http import chat_ws_path, ws_connect, ws_token


@pytest.fixture
async def isolated(tmp_octop_home: Path) -> AsyncIterator[Any]:
    async with octop_client(tmp_octop_home) as (client, server):
        await bootstrap_admin(client, tmp_octop_home)
        wanx_auth = await auth_header(client)
        await seed_openai_provider(client, wanx_auth)
        wanx_id = await create_agent(client, wanx_auth, name="WANX fixture")
        owner = server.user_manager.get("admin")
        profile = await server.app_runtime.agent_registry.create(
            AgentCreateSpec(
                name="知君",
                user_id=owner.id,
                application_id="zhijun",
                default_model="openai/gpt-4o",
            )
        )
        login = await client.post(
            "/api/auth/login",
            json={
                "username": "admin",
                "password": "TestPass12",
                "application_id": "zhijun",
            },
        )
        assert login.status_code == 200
        assert login.json()["user"]["application_id"] == "zhijun"
        zhijun_auth = bearer(login.json()["access_token"])
        yield client, server, wanx_auth, zhijun_auth, wanx_id, profile.agent_id


async def test_owner_list_and_overview_hide_other_application(isolated: Any) -> None:
    client, server, wanx, zhijun, wanx_id, profile_id = isolated
    listing = await client.get("/api/agents?scope=all", headers=wanx)
    assert listing.status_code == 200
    assert wanx_id in {row["agent_id"] for row in listing.json()}
    assert profile_id not in {row["agent_id"] for row in listing.json()}
    overview = await client.get("/api/admin/overview", headers=wanx)
    assert profile_id not in {row["agent_id"] for row in overview.json()["agents"]}
    assert (await client.get("/api/agents", headers=zhijun)).status_code == 404
    audit = await client.get("/api/admin/audit-log", headers=wanx)
    assert profile_id not in {row["target"] for row in audit.json()}
    assert (await client.get("/api/admin/metrics", headers=wanx)).status_code == 404
    assert (await client.get("/api/auth/me", headers=zhijun)).json()["application_id"] == "zhijun"
    assert server.user_manager.get("admin").application_id == "wanx"


@pytest.mark.parametrize(
    ("method", "suffix", "body"),
    [
        ("GET", "", None),
        ("GET", "/status", None),
        ("GET", "/threads", None),
        ("GET", "/workspace/tree", None),
        ("POST", "/memory/episodes/list", {}),
        ("POST", "/memory/atoms/a:deprecate", {}),
        ("PATCH", "", {"name": "cross"}),
        ("POST", "/read", None),
        ("GET", "/channels", None),
        ("GET", "/cron", None),
    ],
)
async def test_http_cross_application_hidden_even_for_admin(
    isolated: Any, method: str, suffix: str, body: Any
) -> None:
    client, _server, wanx, zhijun, wanx_id, profile_id = isolated
    for auth, other_id in [(wanx, profile_id), (zhijun, wanx_id)]:
        result = await client.request(
            method, f"/api/agents/{other_id}{suffix}", headers=auth, json=body
        )
        assert result.status_code == 404


async def test_legacy_header_and_global_surfaces_cannot_bypass_scope(isolated: Any) -> None:
    client, _server, wanx, zhijun, wanx_id, profile_id = isolated
    assert (await client.get("/api/zhijun/profile", headers=wanx)).status_code == 404
    result = await client.get("/api/mbti", headers={**wanx, "X-Octop-Agent-Id": profile_id})
    assert result.status_code == 404
    assert (
        await client.get(f"/api/usage/summary?agent_id={profile_id}", headers=wanx)
    ).status_code == 404
    for path, body in [
        ("/api/agents", {"name": "extra"}),
        (f"/api/agents/{profile_id}/workspace/file", {"path": "AGENTS.md", "content": "changed"}),
        (f"/api/agents/{profile_id}", {"config": {"backend": {"root_dir": wanx_id}}}),
    ]:
        method = "PUT" if "workspace" in path else "PATCH" if path.endswith(profile_id) else "POST"
        assert (await client.request(method, path, headers=zhijun, json=body)).status_code == 404
    assert (await client.get("/api/admin/backup/list", headers=wanx)).status_code == 404


async def test_websocket_scope_and_subscribe_are_isolated(isolated: Any) -> None:
    client, _server, wanx, zhijun, wanx_id, profile_id = isolated
    for auth, other_id in [(wanx, profile_id), (zhijun, wanx_id)]:
        with pytest.raises(WebSocketDisconnect) as error:
            async with ws_connect(client._octop_app, chat_ws_path(other_id, auth)):
                pass
        assert error.value.code == 4404
    with pytest.raises(WebSocketDisconnect):
        async with ws_connect(
            client._octop_app, f"/api/browser-stream/ws?token={ws_token(zhijun)}"
        ):
            pass
    thread = (await client.post(f"/api/agents/{wanx_id}/threads", headers=wanx)).json()["thread_id"]
    async with ws_connect(client._octop_app, chat_ws_path(profile_id, zhijun)) as socket:
        await socket.send_json({"type": "subscribe", "thread_id": thread})
        assert (await socket.receive_json())["type"] == "error"


async def test_notification_pushes_filtered_by_application(isolated: Any) -> None:
    client, server, wanx, zhijun, wanx_id, profile_id = isolated
    owner = server.user_manager.get("admin")
    async with (
        ws_connect(client._octop_app, f"/api/notifications/ws?token={ws_token(wanx)}") as wsocket,
        ws_connect(client._octop_app, f"/api/notifications/ws?token={ws_token(zhijun)}") as zsocket,
    ):
        hub = server.app_runtime.gateway.ws_hub
        await hub.push_to_user(
            owner.id, {"type": "dashboard_push", "agent_id": wanx_id, "text": "wanx-only"}
        )
        await hub.push_to_user(
            owner.id, {"type": "dashboard_push", "agent_id": profile_id, "text": "zhijun-only"}
        )
        assert (await wsocket.receive_json())["text"] == "wanx-only"
        assert (await zsocket.receive_json())["text"] == "zhijun-only"
        for socket in [wsocket, zsocket]:
            await socket.send_json({"type": "ping"})
            assert await socket.receive_json() == {"type": "pong"}


async def test_chat_turn_disables_external_context_and_validates_session(isolated: Any) -> None:
    _client, server, _wanx, zhijun, wanx_id, profile_id = isolated
    user = resolve_user_from_token(server, ws_token(zhijun))
    turn = ChatTurnBody(text="合成资料")
    prepared = await prepare_dashboard_turn(server, agent_id=profile_id, user=user, turn=turn)
    inbound = build_dashboard_inbound(
        agent_id=profile_id, user_id=user.id, prepared=prepared, turn=turn, ws_connection_id="test"
    )
    for key in ["skills", "mcp_servers"]:
        assert inbound.metadata[key] == []
    assert "knowledge_base_ids" not in inbound.metadata
    for turn in [
        ChatTurnBody(text="test", target_agent_ids=[wanx_id]),
        ChatTurnBody(text=f"/agent {wanx_id}"),
        ChatTurnBody(text="test", mcp_servers=["private"]),
        ChatTurnBody(text="test", knowledge_base_ids=["private"]),
        ChatTurnBody(text="test", skills=["private"]),
        ChatTurnBody(text="test", session_key=f"{wanx_id}:dashboard:{user.id}:dm"),
    ]:
        with pytest.raises(OctopError):
            await prepare_dashboard_turn(server, agent_id=profile_id, user=user, turn=turn)


async def test_duplicate_query_token_uses_endpoint_token(isolated: Any) -> None:
    client, _server, wanx, zhijun, _wanx_id, _profile_id = isolated
    with pytest.raises(WebSocketDisconnect) as error:
        async with ws_connect(
            client._octop_app,
            f"/api/browser-stream/ws?token={ws_token(wanx)}&token={ws_token(zhijun)}",
        ):
            pass
    assert error.value.code == 4404


@pytest.mark.parametrize("surface", ["desktop", "mobile"])
async def test_stream_start_frame_token_cannot_bypass_scope(
    isolated: Any, monkeypatch: Any, surface: str
) -> None:
    from octop.api.routers.desktop import stream as desktop
    from octop.api.routers.mobile import stream as mobile

    client, _server, wanx, zhijun, _wanx_id, _profile_id = isolated
    module = desktop if surface == "desktop" else mobile
    monkeypatch.setattr(
        module,
        f"{surface}_status",
        lambda *args, **kwargs: SimpleNamespace(setup_state="ready", ok=True),
    )
    if surface == "mobile":
        client._octop_app.include_router(mobile.router, prefix="/api")
    async with ws_connect(
        client._octop_app, f"/api/{surface}-stream/ws?token={ws_token(wanx)}"
    ) as socket:
        await socket.send_json({"type": "start", "token": ws_token(zhijun)})
        with pytest.raises(WebSocketDisconnect) as error:
            await socket.receive_json()
        assert error.value.code == 4404
