"""Merged native assistant through signed HTTPS, gateway, UDS and local principals."""

# Shared protocol fixtures live with the independently packaged gateway.
# ruff: noqa: E402
from __future__ import annotations

import asyncio
import json
import os
import ssl
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "wanx-bridge"))
sys.path.insert(0, str(ROOT / "wanx-bridge/tests"))

from centuarai_local_data_gate.native_policy import check_octop_request
from test_local_data_gateway import network as network
from test_local_data_gateway import proof
from test_local_data_sessions import nonce

from octop.api.common.local_data import _check_configuration, _check_private_resources, _resolve
from octop.infra.agents.assistant_profile import AssistantProfiles
from octop.infra.agents.middleware.local_data import local_data_live_check

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Requires Unix local data broker")


@pytest.mark.parametrize("team_session", [False, True])
async def test_native_assistant_local_owner_isolation_and_no_cloud_fallback(
    env_with_provider, network, team_session
):
    client, server, admin = env_with_provider
    app = client._octop_app
    app.state.local_data_required = True
    identities = []
    if team_session:
        h = network.h
        h.view["team"] = {
            "schemaVersion": 1,
            "boxId": h.view["boxId"],
            "ownershipEpoch": h.view["ownershipEpoch"],
            "principalId": h.view["principalId"],
            "membershipId": nonce(33),
            "membershipRevision": 1,
            "roleId": "manager",
            "permissions": ["applications.manage", "members.read", "resources.manage"],
        }
        h.view["authorizationVersion"] += 1
        await h.service.invalidate_authority()
        h.session = h.response(
            await h.service.create_session(await h.session_proof("centaurai.wanx.dialogue")),
            "session",
        )

    async def authorize(scope, context):
        check_octop_request(scope, context.claims)
        user = await asyncio.to_thread(_resolve, server, context)
        await _check_configuration(scope, context, server, user)
        await asyncio.to_thread(_check_private_resources, server, scope, context, user)
        scope.setdefault("state", {})["octop_user"] = user
        local_data_live_check.set(context.require_live)
        identities.append((user, context))

    network.native.authorize = authorize
    network.native.app = app
    counter = 100

    def sign(path, **kwargs):
        payload, _ = proof(network, path, **kwargs)
        payload["applicationId"] = network.h.session["applicationId"]
        return network.h.signed(payload)

    async def request(path, method="GET", body=None, data_context=None):
        nonlocal counter
        counter += 1
        data = b"" if body is None else json.dumps(body).encode()
        selectors = {} if body is None else {"contentType": "application/json"}
        if data_context is not None:
            selectors["dataContext"] = data_context
        headers = {
            "x-centuarai-data-proof": sign(
                path, method=method, data=data, n=counter, selectors=selectors
            )
        }
        if body is not None:
            headers["content-type"] = "application/json"
        if data_context is not None:
            headers["x-wanx-data-context"] = data_context
        return await network.client.request(method, path, content=data, headers=headers)

    response = await request("/api/assistant/profile", "POST")
    assert response.status_code == 200, response.text
    aid = response.json()["agent_id"]
    owner, context = identities[-1]
    assert owner.local_data and not owner.is_admin
    if team_session:
        assert owner.local_team["membershipId"] == nonce(33)
        assert owner.local_team_context is context
    assert server.services.agent_repo.get(aid).user_id == owner.id
    assert (await request("/api/assistant/profile", "POST")).json()["agent_id"] == aid
    for path in (
        "/api/providers/resolved",
        "/api/providers/active-model",
        "/api/preferences",
        "/api/settings/timezone",
        "/api/assistant/conversations",
        "/api/assistant/history",
    ):
        response = await request(path)
        assert response.status_code == 200, (path, response.text)
        assert "api_key" not in response.text

    response = await request(f"/api/agents/{aid}/threads", "POST")
    assert response.status_code == 201, response.text
    tid = response.json()["thread_id"]
    response = await request(f"/api/assistant/conversations/{tid}")
    assert response.status_code == 200, response.text
    revision = response.json()["revision"]
    response = await request(
        f"/api/assistant/conversations/{tid}",
        "PATCH",
        {
            "revision": revision,
            "context": {
                "space": {"enabled": False},
                "knowledge": {"enabled": False, "data_scope": "personal"},
            },
        },
    )
    assert response.status_code == 200, response.text
    assert (
        await request(f"/api/agents/{aid}/threads/{tid}/history?limit=25&offset=0")
    ).status_code == 200
    assert (await request("/api/assistant/conversations")).json()["items"][0]["thread_id"] == tid

    # Match the desktop native assistant's subscription and user_turn frames.
    server.app_runtime.agent_registry.get_agent(aid).chunks = [
        {"type": "token", "content": "local synthetic answer"}
    ]
    ws_path = f"/api/agents/{aid}/chat/ws"
    ws_nonce = 200

    class SignedConnection(ClientConnection):
        async def handshake(self, additional_headers=None, user_agent_header=None):
            nonlocal ws_nonce
            ws_nonce += 1
            handshake = self.protocol.connect()
            signed = sign(
                ws_path,
                n=ws_nonce,
                transport="websocket",
                selectors={"webSocketKey": handshake.headers["Sec-WebSocket-Key"]},
            )
            await super().handshake({"x-centuarai-data-proof": signed})

    async with connect(
        "wss" + network.url[5:] + ws_path,
        ssl=ssl._create_unverified_context(),
        proxy=None,
        compression=None,
        create_connection=SignedConnection,
        close_timeout=0.5,
    ) as websocket:
        await websocket.send(json.dumps({"type": "subscribe", "thread_id": tid}))
        await websocket.send(
            json.dumps(
                {
                    "type": "user_turn",
                    "thread_id": tid,
                    "model": "openai/gpt-4o",
                    "mcp_servers": [],
                    "conversation_mode": "craft",
                    "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
                }
            )
        )
        frames = []
        async with asyncio.timeout(5):
            while True:
                frame = json.loads(await websocket.recv())
                frames.append(frame)
                if frame.get("type") in {"done", "error"}:
                    break
        assert any(frame.get("type") == "token" for frame in frames), frames
        assert frames[-1]["type"] == "done", frames

    other_claims = dict(context.claims)
    other_claims["principalId"] = "other-local-owner"
    other = await asyncio.to_thread(
        _resolve,
        server,
        SimpleNamespace(
            claims=other_claims,
            principal_namespace="b" * 43,
        ),
    )
    other_profile = await AssistantProfiles(server).ensure(other)
    other_agent = other_profile["agent_id"]
    assert other.id != owner.id
    assert (await request(f"/api/agents/{other_agent}/threads")).status_code == 403
    # A real conversation owned by the second principal remains private too.
    other_thread = server.app_runtime.gateway.thread_registry.create_thread(
        agent_id=other_agent,
        user_id=other.id,
        channel_type="dashboard",
        session_key="other-local",
    )
    assert (await request(f"/api/assistant/conversations/{other_thread}")).status_code == 404
    assert (
        await request(
            "/api/assistant/history",
            "POST",
            {
                "operation": "trash",
                "items": [{"kind": "thread", "id": other_thread}],
            },
        )
    ).status_code == 404

    for path, method in (
        ("/api/providers", "GET"),
        ("/api/providers/active-model", "PUT"),
        ("/api/admin/providers", "GET"),
        ("/api/assistant/knowledge/warehouses", "GET"),
        ("/api/assistant/knowledge-grant", "POST"),
        ("/api/assistant/space-grant", "POST"),
        ("/api/_client/space-mcp/connections", "POST"),
    ):
        assert (await request(path, method)).status_code == 403, path
    for family in ("space", "knowledge"):
        selected = {family: {"enabled": True}}
        assert (
            await request("/api/assistant/context/validate", "POST", selected)
        ).status_code == 403
        assert (
            await request(
                f"/api/assistant/conversations/{tid}",
                "PATCH",
                {"revision": revision, "context": selected},
            )
        ).status_code == 403
    # A valid cloud administrator bearer still cannot select a local principal.
    assert (await network.client.post("/api/assistant/profile", headers=admin)).status_code == 403
    if team_session:
        # Team roles and selected shared objects never replace the assistant's
        # private owner. The dialogue application's grants stay personal.
        for selected in ("team:management", f"team:agent:{aid}", "team:knowledge:ABC123"):
            assert (
                await request("/api/assistant/profile", "POST", data_context=selected)
            ).status_code == 403
        async with connect(
            "wss" + network.url[5:] + ws_path,
            ssl=ssl._create_unverified_context(),
            proxy=None,
            compression=None,
            create_connection=SignedConnection,
            close_timeout=0.5,
        ) as websocket:
            await websocket.send(json.dumps({"type": "subscribe", "thread_id": tid}))
            network.h.view["team"]["membershipRevision"] += 1
            network.h.view["authorizationVersion"] += 1
            await network.h.service.invalidate_authority()
            async with asyncio.timeout(3):
                with pytest.raises(ConnectionClosed):
                    while True:
                        await websocket.recv()
        previous = len(identities)
        assert (await request("/api/assistant/profile", "POST")).status_code == 403
        assert len(identities) == previous
