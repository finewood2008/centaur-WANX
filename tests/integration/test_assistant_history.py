"""Assistant organization changes preserve source history and ownership."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from tests.support.auth import create_user, resolve_user_id


async def test_history_rename_pin_archive_trash_restore_and_legacy(env_with_provider: Any) -> None:
    client, server, admin = env_with_provider
    assert (await client.get("/api/assistant/history")).status_code == 401
    auth = await create_user(client, admin, username="history-owner", permissions=[])
    uid = await resolve_user_id(client, admin, "history-owner")
    profile = (await client.post("/api/assistant/profile", headers=auth)).json()
    aid = profile["agent_id"]
    tid = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
    before = server.app_runtime.gateway.thread_registry.get_thread(tid)
    legacy = {"id": "legacy-owned", "title": "Original", "groups": []}
    server.services.repos.dialogue_repo.save((uid, "dialogue"), legacy)

    async def update(
        operation: str, kind: str = "thread", identity: str = tid, **extra: Any
    ) -> dict[str, Any]:
        response = await client.post(
            "/api/assistant/history",
            headers=auth,
            json={"operation": operation, "items": [{"kind": kind, "id": identity}], **extra},
        )
        assert response.status_code == 200, response.text
        return response.json()

    renamed = await update("rename", title="  Synthetic  renamed  ")
    assert renamed["entries"][f"thread:{tid}"]["title"] == "Synthetic renamed"
    pinned = await update("pin")
    assert pinned["entries"][f"thread:{tid}"]["pinned"] is True
    assert (await update("pin"))["revision"] == pinned["revision"]
    await update("archive")
    trashed = await update("trash")
    assert trashed["entries"][f"thread:{tid}"]["previous_status"] == "archived"
    assert trashed["entries"][f"thread:{tid}"]["deleted_at"]
    restored = await update("restore")
    assert restored["entries"][f"thread:{tid}"]["status"] == "archived"
    await update("unarchive")
    await update("unpin")
    await update("rename", "legacy", "legacy-owned", title="Alias only")
    await update("trash", "legacy", "legacy-owned")
    await update("restore", "legacy", "legacy-owned")
    assert server.app_runtime.gateway.thread_registry.get_thread(tid) == before
    assert server.services.repos.dialogue_repo.get((uid, "dialogue"), "legacy-owned") == legacy
    assert (await client.get("/api/assistant/history", headers=auth)).json()["entries"][
        "legacy:legacy-owned"
    ]["title"] == "Alias only"
    invalid = await client.post(
        "/api/assistant/history",
        headers=auth,
        json={"operation": "rename", "items": [{"kind": "thread", "id": tid}], "title": " "},
    )
    assert invalid.status_code == 400


async def test_history_batch_is_atomic_private_and_concurrent(
    env_with_provider: Any, monkeypatch: Any
) -> None:
    client, server, admin = env_with_provider
    alice = await create_user(client, admin, username="history-alice")
    bob = await create_user(client, admin, username="history-bob")
    aid = (await client.post("/api/assistant/profile", headers=alice)).json()["agent_id"]
    bid = (await client.post("/api/assistant/profile", headers=bob)).json()["agent_id"]
    tids = [
        (await client.post(f"/api/agents/{aid}/threads", headers=alice)).json()["thread_id"]
        for _ in range(4)
    ]
    foreign = (await client.post(f"/api/agents/{bid}/threads", headers=bob)).json()["thread_id"]
    items = [{"kind": "thread", "id": tid} for tid in tids]
    denied = await client.post(
        "/api/assistant/history",
        headers=alice,
        json={"operation": "trash", "items": [items[0], {"kind": "thread", "id": foreign}]},
    )
    assert denied.status_code == 404
    assert (await client.get("/api/assistant/history", headers=alice)).json()["entries"] == {}
    responses = await asyncio.gather(
        *(
            client.post(
                "/api/assistant/history", headers=alice, json={"operation": "pin", "items": [item]}
            )
            for item in items
        )
    )
    assert all(r.status_code == 200 for r in responses)
    state = (await client.get("/api/assistant/history", headers=alice)).json()
    assert state["revision"] == 4 and len(state["entries"]) == 4
    assert (await client.get("/api/assistant/history", headers=bob)).json()["entries"] == {}
    monkeypatch.setattr(
        server.app_runtime.gateway.ws_hub, "is_turn_active", lambda tid: tid == tids[0]
    )
    busy = await client.post(
        "/api/assistant/history", headers=alice, json={"operation": "trash", "items": items}
    )
    assert busy.status_code == 400
    assert busy.json()["error"]["details"]["reason"] == "ASSISTANT_TURN_ACTIVE"
    assert (await client.get("/api/assistant/history", headers=alice)).json() == state
    uid = await resolve_user_id(client, admin, "history-alice")
    prefs = json.loads(server.services.user_repo.get(uid).preferences_json)
    assert prefs["wanx_assistant_agent_id"] == aid
    schema = client._octop_app.openapi()
    assert schema["paths"]["/api/assistant/history"]["post"]["requestBody"]
