"""Space access is explicit, scoped, owner-bound and revocable."""

from __future__ import annotations

from typing import Any

import pytest

from octop.infra.agents.assistant_space_mcp import OwnerSpaceReader
from octop.infra.connectors.service import ConnectorService
from octop.infra.personal_space.service import SpaceError
from tests.support.auth import create_user, resolve_user_id


async def test_optional_space_grant_lifecycle_and_owner_isolation(env_with_provider: Any) -> None:
    client, server, admin = env_with_provider
    alice = await create_user(client, admin, username="space-alice", permissions=[])
    bob = await create_user(client, admin, username="space-bob", permissions=[])
    uid = await resolve_user_id(client, admin, "space-alice")
    aid = (await client.post("/api/assistant/profile", headers=alice)).json()["agent_id"]
    await client.post("/api/assistant/profile", headers=bob)
    assert server.services.repos.connector_repo.get_by_user_kind(uid, "custom-mcp") is None
    folders = []
    for name in ["Allowed", "Outside"]:
        response = await client.post(
            "/api/personal-space/folders", headers=alice, json={"name": name}
        )
        assert response.status_code == 200, response.text
        folders.append(response.json())
    response = await client.post(
        "/api/assistant/space-grant",
        headers=alice,
        json={
            "enabled": True,
            "selection": {"mode": "folder", "space_id": "personal", "folder_id": folders[0]["id"]},
        },
    )
    assert response.status_code == 200, response.text
    grant = response.json()
    reader = OwnerSpaceReader(server.paths.root, uid, grant["grant_id"])
    assert reader.spaces()[0]["root"] == folders[0]["id"]
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        reader.listing(parent=folders[1]["id"])
    connector = ConnectorService(
        repo=server.services.repos.connector_repo,
        secret_repo=server.services.secret_repo,
        settings_repo=server.services.settings_repo,
        config=server.services.config,
    )
    assert grant["mcp_server"] in connector.list_active_mcp_server_names(uid)
    assert grant["mcp_server"] not in connector.list_default_open_mcp_server_names(uid)
    tids = [
        (await client.post(f"/api/agents/{aid}/threads", headers=alice)).json()["thread_id"]
        for _ in range(2)
    ]
    bound = await client.post(
        "/api/assistant/space-grant",
        headers=alice,
        json={"enabled": True, "grant_id": grant["grant_id"], "thread_id": tids[0]},
    )
    assert bound.status_code == 200
    wrong_thread = await client.post(
        "/api/assistant/space-grant",
        headers=alice,
        json={"enabled": True, "grant_id": grant["grant_id"], "thread_id": tids[1]},
    )
    assert wrong_thread.status_code == 403
    denied = await client.post(
        "/api/assistant/space-grant",
        headers=bob,
        json={"enabled": False, "grant_id": grant["grant_id"]},
    )
    assert denied.status_code == 403
    assert reader.spaces()
    revoked = await client.post(
        "/api/assistant/space-grant",
        headers=alice,
        json={"enabled": False, "grant_id": grant["grant_id"]},
    )
    assert revoked.status_code == 200 and not revoked.json()["enabled"]
    assert grant["mcp_server"] not in connector.list_active_mcp_server_names(uid)
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        reader.spaces()
    assert (
        await client.post("/api/assistant/space-grant", json={"enabled": False})
    ).status_code == 401
