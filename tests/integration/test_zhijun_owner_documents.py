"""HTTP boundaries and schemas, using isolated synthetic document storage."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from octop.infra.agents import zhijun_owner_documents as m
from tests.support.auth import create_agent, create_user
from tests.unit.agents.test_zhijun_owner_documents import Knowledge


async def test_material_routes_require_primary_owner_and_closed_payload(
    env_with_provider, monkeypatch
):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    path = f"/api/agents/{aid}/ontology/owner-documents/private/note"
    monkeypatch.setattr(m, "_knowledge", lambda _: Knowledge())
    assert (await client.get(path, headers=auth)).status_code == 404
    assert (
        await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    ).status_code == 200
    monkeypatch.setattr(
        registry.get_agent(aid),
        "config",
        SimpleNamespace(pick_default_model_ref=lambda: "synthetic/model"),
    )
    view = await client.get(path, headers=auth)
    assert view.status_code == 200, view.text
    data = view.json()
    body = {
        "action": "mark",
        "expected_version": "empty",
        "request_id": "mark",
        "source_version": data["source_version"],
        "model_ref": data["model_ref"],
    }
    other = await create_user(client, auth, username="material-other", role="admin")
    assert (await client.get(path, headers=other)).status_code == 404
    assert (await client.post(path, headers=other, json=body)).status_code == 404
    assert (
        await client.post(path, headers=auth, json={**body, "text": "invented"})
    ).status_code == 422
    assert (
        await client.post(path, headers=auth, json={**body, "agent_id": "other"})
    ).status_code == 422
    marked = await client.post(path, headers=auth, json=body)
    assert marked.status_code == 200, marked.text
    assert marked.json()["current"]
    assert (await client.get(path, headers=auth)).json()["record"] == marked.json()["record"]
    schema = client._transport.app.openapi()
    route = schema["paths"]["/api/agents/{agent_id}/ontology/owner-documents/{kb_id}/{document_id}"]
    assert route["post"]["summary"] and route["post"]["requestBody"]
