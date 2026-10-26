"""Authenticated company collection and per-Agent resource access, real HTTP routes."""

import secrets
from typing import Any
from uuid import uuid4

from tests.support.auth import create_user


async def test_company_collection_and_agent_authority(env: Any):
    client, _server, admin = env
    alice = await create_user(client, admin, username="agent_hub_alice")
    bob = await create_user(client, admin, username="agent_hub_bob")
    base = "/api/_client/space-agents"
    key = secrets.token_urlsafe(32)
    registration = {
        "machine": uuid4().hex,
        "kind": "codex",
        "profile": "a" * 64,
        "name": "Codex A",
        "destination": "company",
        "credential": key,
    }
    response = await client.post(base + "/connections", headers=alice, json=registration)
    assert response.status_code == 200, response.text
    agent = response.json()["id"]
    assert "credential" not in response.json()
    project = {"id": "b" * 64, "name": "合成项目", "conversations": True, "memory": True}
    response = await client.put(
        base + f"/connections/{agent}/collection",
        headers=alice,
        json={"expected": 0, "collection": {"enabled": True, "projects": [project]}},
    )
    assert response.status_code == 200, response.text
    item = {
        "id": "synthetic-event-1",
        "project": project["id"],
        "category": "conversation",
        "role": "user",
        "title": "合成记录",
        "text": "仅供验证，不含客户资料。",
        "timestamp": "2026-10-25T09:00:00Z",
    }
    response = await client.post(
        base + f"/connections/{agent}/records", headers=alice, json={"records": [item]}
    )
    assert response.status_code == 200, response.text
    record = response.json()["saved"][0]
    for headers in [alice, bob, admin]:
        assert (await client.get(base + "/archives?destination=company", headers=headers)).json()[
            "sources"
        ][0]["member"]
        assert (await client.get(base + "/records/" + record, headers=headers)).json()[
            "text"
        ] == item["text"]
    root = (await client.get(base + "/archives?destination=company", headers=alice)).json()[
        "sources"
    ][0]["projects"][0]["root"]
    response = await client.post(
        base + f"/connections/{agent}/grants",
        headers=alice,
        json={"domain": "company", "root": root},
    )
    assert response.status_code == 200, response.text
    grant = response.json()["id"]
    headers = {**alice, "x-agent-connection": key}
    response = await client.post(
        base + f"/connections/{agent}/invoke", headers=headers, json={"action": "access"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["grants"][0]["permission"] == "read"
    assert (
        await client.post(
            base + f"/connections/{agent}/invoke",
            headers=headers,
            json={"action": "mkdir", "grant_id": grant, "name": "forbidden"},
        )
    ).status_code == 403
    assert (
        await client.post(
            base + f"/connections/{agent}/invoke",
            headers={**bob, "x-agent-connection": key},
            json={"action": "access"},
        )
    ).status_code == 404
    assert (await client.get(base + "/connections")).status_code == 401
    # Existing public file APIs keep their original schema and user isolation.
    personal = (await client.get("/api/personal-space/overview", headers=alice)).json()
    assert personal["protocolVersion"] == 1
    assert personal["filesBytes"] == 0
    aid = (await client.get("/api/auth/me", headers=alice)).json()["id"]
    response = await client.patch(f"/api/users/{aid}", headers=admin, json={"disabled": True})
    assert response.status_code == 200, response.text
    assert (await client.get(base + "/connections", headers=alice)).status_code in [401, 403]
    assert (
        await client.post(
            base + f"/connections/{agent}/invoke", headers=headers, json={"action": "access"}
        )
    ).status_code in [401, 403]
    schema = (await client.get("/api/openapi.json", headers=admin)).json()
    assert not any(path.startswith(base) for path in schema.get("paths", {}))
