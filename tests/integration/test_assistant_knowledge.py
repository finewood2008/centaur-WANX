"""Assistant warehouse ACLs and protected Starlink transport, using synthetic data."""

from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from octop.infra.agents.assistant_knowledge import (
    KnowledgeError,
    KnowledgeReader,
)
from octop.infra.semantica import client as starlink
from tests.support.auth import create_user, resolve_user_id

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def starlink_transport(env_with_provider: Any, monkeypatch: Any) -> Any:
    _, server, _ = env_with_provider
    server.paths.root.joinpath("semantica.json").write_text(
        json.dumps(
            {
                "service_url": "http://127.0.0.1:18999",
                "service_token": "synthetic-" * 6,
                "box_id": "synthetic-box",
                "application_id": "synthetic-starlink",
            }
        )
    )
    state: dict[str, Any] = {"deleted": set(), "offline": set(), "requests": [], "personal": {}}

    def handle(request: httpx.Request) -> httpx.Response:
        encoded = request.headers["x-semantica-scope"]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        state["requests"].append((request, claims))
        assert claims["permissions"] == ["read"] and not claims["owner_view"]
        personal = "resource_owner" not in claims
        if personal:
            resource = next(iter(claims["workspace_bindings"].values()))
            assert resource.startswith("personal:" + claims["actor_id"])
            ids = state["personal"].get(claims["actor_id"], [])
        else:
            assert claims["resource_owner"] == "team:wanx"
            ids = [A, B]
        path = request.url.path.removeprefix("/api/integration")
        if path == "/warehouses":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {"id": wid, "name": wid, "state": "active"}
                        for wid in ids
                        if wid not in state["deleted"]
                    ]
                },
            )
        if path.startswith("/warehouses/"):
            wid = path.rsplit("/", 1)[-1]
            if wid not in ids or wid in state["deleted"]:
                return httpx.Response(404, json={"code": "WAREHOUSE_NOT_FOUND"})
            return httpx.Response(
                200, json={"id": wid, "name": "Synthetic " + wid[0], "state": "active"}
            )
        resource = next(iter(claims["workspace_bindings"].values()))
        wid = resource.rsplit(":", 1)[-1]
        if wid in state["offline"]:
            return httpx.Response(503, json={"code": "SEMANTICA_SERVICE_UNAVAILABLE"})
        if path == "/search":
            body = json.loads(request.content)
            assert body["delivery_mode"] == "masked"
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "evidence-" + wid[0],
                            "document_id": "doc-" + wid[0],
                            "document_name": "Synthetic document",
                            "text": "[MASKED] synthetic evidence",
                        }
                    ]
                },
            )
        if path.startswith("/evidence/"):
            if path.endswith("evidence-" + wid[0]):
                return httpx.Response(
                    200, json={"id": path.rsplit("/", 1)[-1], "text": "[MASKED] synthetic evidence"}
                )
            return httpx.Response(404, json={"code": "EVIDENCE_NOT_FOUND"})
        return httpx.Response(200, json={"items": []})

    real = httpx.AsyncClient
    monkeypatch.setattr(
        starlink,
        "httpx",
        SimpleNamespace(
            AsyncClient=lambda **kw: real(transport=httpx.MockTransport(handle), **kw),
            HTTPError=httpx.HTTPError,
        ),
    )
    return state


async def test_admin_acl_member_selection_revocation_and_isolation(
    env_with_provider: Any, starlink_transport: Any
) -> None:
    client, server, admin = env_with_provider
    alice = await create_user(client, admin, username="knowledge-alice", permissions=[])
    bob = await create_user(client, admin, username="knowledge-bob", permissions=[])
    uid = await resolve_user_id(client, admin, "knowledge-alice")
    bid = await resolve_user_id(client, admin, "knowledge-bob")
    aid = (await client.post("/api/assistant/profile", headers=alice)).json()["agent_id"]
    path = "/api/assistant/knowledge"
    assert (await client.get(path + "/warehouses", headers=alice)).json()["items"] == []
    denied = await client.put(
        path + "/access/" + A, headers=alice, json={"audience": "all", "members": [], "revision": 0}
    )
    assert denied.status_code == 403
    saved = await client.put(
        path + "/access/" + A,
        headers=admin,
        json={"audience": "selected", "members": [uid], "revision": 0},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    assert (
        await client.put(
            path + "/access/" + A,
            headers=admin,
            json={"audience": "all", "members": [], "revision": 0},
        )
    ).status_code == 409
    assert [
        w["id"] for w in (await client.get(path + "/warehouses", headers=alice)).json()["items"]
    ] == [A]
    assert (await client.get(path + "/warehouses", headers=bob)).json()["items"] == []
    bad = await client.post(
        "/api/assistant/knowledge-grant",
        headers=alice,
        json={"enabled": True, "warehouses": [A, B]},
    )
    assert bad.status_code == 403
    tids = [
        (await client.post(f"/api/agents/{aid}/threads", headers=alice)).json()["thread_id"]
        for _ in range(2)
    ]
    grant = (
        await client.post(
            "/api/assistant/knowledge-grant",
            headers=alice,
            json={"enabled": True, "warehouses": [A], "thread_id": tids[0]},
        )
    ).json()
    assert grant["enabled"]
    reader = KnowledgeReader(server.paths.root, server.services.db, uid, grant["grant_id"])
    result = await reader.selected("search", query="synthetic")
    assert result["warehouses"][0]["result"]["items"][0]["text"].startswith("[MASKED]")
    assert result["assistant_knowledge_sources"][0]["warehouse_id"] == A
    cached = await client.get(path + "/sources/" + tids[0], headers=alice)
    assert cached.status_code == 200 and cached.json()["sources"][0]["warehouse_id"] == A
    assert (await client.get(path + "/sources/" + tids[0], headers=bob)).status_code == 403
    assert starlink_transport["requests"][-1][1]["actor_id"] == "wanx:" + str(uid)
    assert (
        await client.post(
            "/api/assistant/knowledge-grant",
            headers=bob,
            json={"enabled": False, "grant_id": grant["grant_id"]},
        )
    ).status_code == 403
    assert (
        await client.post(
            "/api/assistant/knowledge-grant",
            headers=alice,
            json={"enabled": True, "grant_id": grant["grant_id"], "thread_id": tids[1]},
        )
    ).status_code == 403
    source = {
        "grant_id": grant["grant_id"],
        "warehouse_id": A,
        "evidence_id": "evidence-1",
        "thread_id": tids[0],
    }
    assert (await client.post(path + "/evidence", headers=alice, json=source)).status_code == 200
    assert (
        await client.post(path + "/evidence", headers=alice, json={**source, "warehouse_id": B})
    ).status_code == 403
    assert (
        await client.put(
            path + "/access/" + A,
            headers=admin,
            json={"audience": "none", "members": [], "revision": 1},
        )
    ).status_code == 200
    result = await reader.selected("search", query="revoked")
    assert (
        result["warehouses"] == []
        and result["unavailable"][0]["code"] == "ASSISTANT_KNOWLEDGE_DENIED"
    )
    assert (await client.post(path + "/evidence", headers=alice, json=source)).status_code == 403
    with server.services.db.connect() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM assistant_knowledge_access_audit").fetchone()[0] == 2
        )
    assert (await client.get(path + "/warehouses")).status_code == 401
    # All-member authorization includes a subsequently created, active member.
    await client.put(
        path + "/access/" + B, headers=admin, json={"audience": "all", "members": [], "revision": 0}
    )
    late = await create_user(client, admin, username="knowledge-late", permissions=[])
    assert [
        w["id"] for w in (await client.get(path + "/warehouses", headers=late)).json()["items"]
    ] == [B]
    server.services.user_repo.set_disabled(bid, True)


async def test_multistore_partial_failure_expiry_box_change_and_disabled_user(
    env_with_provider: Any, starlink_transport: Any
) -> None:
    client, server, admin = env_with_provider
    me = (await client.get("/api/auth/me", headers=admin)).json()
    uid = me["id"]
    await client.post("/api/assistant/profile", headers=admin)
    grant = (
        await client.post(
            "/api/assistant/knowledge-grant",
            headers=admin,
            json={"enabled": True, "warehouses": [A, B]},
        )
    ).json()
    second = await client.post(
        "/api/assistant/knowledge-grant", headers=admin, json={"enabled": True, "warehouses": [A]}
    )
    assert second.status_code == 200, second.text
    assert second.json()["grant_id"] != grant["grant_id"]
    reader = KnowledgeReader(server.paths.root, server.services.db, uid, grant["grant_id"])
    result = await reader.selected("search", query="both")
    assert [r["warehouse"]["id"] for r in result["warehouses"]] == [A, B]
    starlink_transport["offline"].add(B)
    result = await reader.selected("search", query="partial")
    assert len(result["warehouses"]) == 1 and result["unavailable"][0]["warehouse_id"] == B
    starlink_transport["deleted"].add(A)
    assert (await reader.selected("search", query="deleted"))["warehouses"] == []
    starlink_transport["deleted"].clear()
    config_path = server.paths.root / "semantica.json"
    config = json.loads(config_path.read_text())
    config_path.write_text(json.dumps({**config, "box_id": "other-box"}))
    with pytest.raises(KnowledgeError):
        await reader.selected("search", query="wrong box")
    config_path.write_text(json.dumps(config))
    server.services.user_repo.set_disabled(uid, True)
    with pytest.raises(KnowledgeError):
        await reader.selected("warehouse")
    server.services.user_repo.set_disabled(uid, False)
    record = reader.store.get(grant["grant_id"])
    record["expires"] = 0
    reader.store.save(record)
    with pytest.raises(KnowledgeError):
        await reader.selected("warehouse")
    await client.post(
        "/api/assistant/knowledge-grant",
        headers=admin,
        json={"enabled": False, "grant_id": grant["grant_id"]},
    )
    with pytest.raises(KnowledgeError):
        reader.store.get(grant["grant_id"])


async def test_personal_knowledge_owner_scope_grants_and_evidence(
    env_with_provider: Any, starlink_transport: Any
) -> None:
    client, server, admin = env_with_provider
    alice = await create_user(client, admin, username="personal-alice", permissions=[])
    bob = await create_user(client, admin, username="personal-bob", permissions=[])
    uid = await resolve_user_id(client, admin, "personal-alice")
    bid = await resolve_user_id(client, admin, "personal-bob")
    starlink_transport["personal"] = {f"wanx:{uid}": [A], f"wanx:{bid}": [B]}
    personal = {**alice, "x-wanx-data-context": "personal"}
    personal_bob = {**bob, "x-wanx-data-context": "personal"}
    path = "/api/assistant/knowledge"
    aid = (await client.post("/api/assistant/profile", headers=alice)).json()["agent_id"]
    tid = (await client.post(f"/api/agents/{aid}/threads", headers=alice)).json()["thread_id"]
    assert [
        w["id"] for w in (await client.get(path + "/warehouses", headers=personal)).json()["items"]
    ] == [A]
    assert [
        w["id"]
        for w in (await client.get(path + "/warehouses", headers=personal_bob)).json()["items"]
    ] == [B]
    assert (await client.get(path + "/warehouses", headers=alice)).json()["items"] == []
    assert (
        await client.get(path + "/warehouses", headers={**alice, "x-wanx-data-context": "other"})
    ).status_code == 422
    denied = await client.post(
        "/api/assistant/knowledge-grant",
        headers=personal,
        json={"enabled": True, "warehouses": [B]},
    )
    assert denied.status_code == 404
    grant = await client.post(
        "/api/assistant/knowledge-grant",
        headers=personal,
        json={"enabled": True, "warehouses": [A], "thread_id": tid},
    )
    assert grant.status_code == 200, grant.text
    gid = grant.json()["grant_id"]
    # The stdio MCP derives its data scope from the persisted grant.
    reader = KnowledgeReader(server.paths.root, server.services.db, uid, gid)
    result = await reader.selected("search", query="synthetic")
    assert result["warehouses"][0]["warehouse"]["id"] == A
    assert "resource_owner" not in starlink_transport["requests"][-1][1]
    source = {"grant_id": gid, "warehouse_id": A, "evidence_id": "evidence-1", "thread_id": tid}
    assert (await client.post(path + "/evidence", headers=personal, json=source)).status_code == 200
    assert (await client.post(path + "/evidence", headers=alice, json=source)).status_code == 403
    assert (
        await client.post(path + "/evidence", headers=personal_bob, json=source)
    ).status_code == 403
    for headers in [alice, personal_bob]:
        assert (
            await client.post(
                "/api/assistant/knowledge-grant",
                headers=headers,
                json={"enabled": True, "grant_id": gid, "thread_id": tid},
            )
        ).status_code == 403
    with server.services.db.connect() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM assistant_knowledge_access_audit").fetchone()[0] == 0
        )
    revoked = await client.post(
        "/api/assistant/knowledge-grant", headers=personal, json={"enabled": False, "grant_id": gid}
    )
    assert revoked.status_code == 200
    with pytest.raises(KnowledgeError):
        await reader.selected("search", query="revoked")
