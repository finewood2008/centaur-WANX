"""Current WANX private primary routes, using only the isolated HTTP fixture."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from tests.support.auth import create_agent, create_user


async def test_current_decision_routes_owner_roundtrip_and_schema(env_with_provider, monkeypatch):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    path = f"/api/agents/{aid}/ontology/decisions"
    assert (await client.get(path, headers=auth)).status_code == 404
    bound = await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    assert bound.status_code == 200, bound.text
    monkeypatch.setattr(
        registry.get_agent(aid), "_memory_runtime", SimpleNamespace(memory=None), raising=False
    )
    original = await client.get(path, headers=auth)
    assert original.status_code == 200, original.text
    assert original.json()["entries"] == []
    other = await create_user(client, auth, username="decision-other", role="admin")
    assert (await client.get(path, headers=other)).status_code == 404
    body = {
        "action": "confirm",
        "expected_version": original.json()["revision"],
        "request_id": "once",
        "description": "合成决定",
        "reasons": "验证流程",
        "expectation": "顺利完成",
        "revisit_date": "2026-01-01",
    }
    assert (await client.post(path + "/new", headers=other, json=body)).status_code == 404
    for field in ["prompt", "agent_id", "confirmed_by"]:
        assert (
            await client.post(path + "/new", headers=auth, json={**body, field: "forged"})
        ).status_code == 422
    response = await client.post(path + "/new", headers=auth, json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    entry = data["book"]["entries"][0]
    duplicate = await client.post(path + "/new", headers=auth, json=body)
    assert duplicate.json()["changed_id"] == entry["id"]
    assert (await client.get(path, headers=auth)).json()["entries"] == [entry]
    review = await client.post(
        path + "/" + entry["id"],
        headers=auth,
        json={
            "action": "review",
            "expected_version": entry["version"],
            "request_id": "review",
            "outcome": "合成结果",
        },
    )
    assert review.status_code == 200, review.text
    assert review.json()["book"]["entries"][0]["expectation"] == "顺利完成"
    assert review.json()["book"]["entries"][0]["state"] == "reviewed"
    foreign = await client.post(path + "/propose", headers=auth, json={"thread_id": "foreign"})
    assert foreign.status_code == 404, foreign.text
    schema = client._transport.app.openapi()
    for suffix in ["", "/propose", "/{decision_id}"]:
        route = schema["paths"]["/api/agents/{agent_id}/ontology/decisions" + suffix]
        for operation in route.values():
            assert operation["summary"] and operation["description"]
            assert operation["responses"]["200"]["content"]["application/json"]["schema"]
