"""Actual HTTP authorization and persistence against isolated fixture databases."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from tests.support.auth import create_agent, create_user


async def test_batch_owner_schema_roundtrip_and_replay(env_with_provider, monkeypatch):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    root = f"/api/agents/{aid}/ontology"
    path = root + "/batch-review"
    assert (await client.get(path, headers=auth)).status_code == 404
    assert (
        await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    ).status_code == 200
    monkeypatch.setattr(
        registry.get_agent(aid), "_memory_runtime", SimpleNamespace(memory=None), raising=False
    )
    assert (await client.get(path, headers=auth)).json()["items"] == []
    doc = (await client.get(root, headers=auth)).json()
    created = await client.post(
        root + "/nodes/new",
        headers=auth,
        json={
            "action": "add",
            "request_id": "seed",
            "expected_version": doc["revision"],
            "statement": "合成数据：我在意诚信",
            "conditions": "工作中",
        },
    )
    assert created.status_code == 200, created.text
    item = (await client.get(path, headers=auth)).json()["items"][0]
    body = {
        "request_id": "bulk",
        "items": [
            {
                "id": item["claim"]["id"],
                "expected_version": item["claim"]["version"],
                "token": item["token"],
                "action": "admit",
            }
        ],
    }
    other = await create_user(client, auth, username="batch-other", role="admin")
    assert (await client.get(path, headers=other)).status_code == 404
    assert (await client.post(path, headers=other, json=body)).status_code == 404
    for field in ["prompt", "agent_id", "confirmed_by"]:
        assert (
            await client.post(path, headers=auth, json={**body, field: "forged"})
        ).status_code == 422
    assert (
        await client.post(
            path,
            headers=auth,
            json={**body, "items": [{**body["items"][0], "statement": "forged"}]},
        )
    ).status_code == 422
    reserved = registry.try_begin_history_backfill(aid)
    assert reserved
    try:
        assert (await client.post(path, headers=auth, json=body)).status_code != 200
    finally:
        registry.end_history_backfill(aid)
    result = await client.post(path, headers=auth, json=body)
    assert result.status_code == 200, result.text
    assert result.json()["results"][0]["status"] == "confirmed"
    assert (await client.post(path, headers=auth, json=body)).json() == result.json()
    assert (await client.get(path, headers=auth)).json()["items"] == []
    saved = (await client.get(root, headers=auth)).json()["claims"][0]
    assert saved["conditions"] == "工作中" and saved["core_status"] == "admitted"
    schema = client._transport.app.openapi()["paths"][
        "/api/agents/{agent_id}/ontology/batch-review"
    ]
    for operation in schema.values():
        assert operation["summary"] and operation["description"]
        assert operation["responses"]["200"]["content"]["application/json"]["schema"]
