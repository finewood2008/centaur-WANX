"""Real HTTP routing, authenticated owner isolation and empty-role readiness."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from octop.api.deps import sign_token
from tests.support.auth import bearer, create_agent, create_user


async def test_empty_role_prepare_context_and_owner_boundaries(env_with_provider, monkeypatch):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    assert (await client.get(f"/api/agents/{aid}/ontology", headers=auth)).status_code == 404
    bound = await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    assert bound.status_code == 200, bound.text
    registry = server.app_runtime.agent_registry
    harness = registry.get_agent(aid)
    harness._memory_runtime = SimpleNamespace(memory=None)
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    root = f"/api/agents/{aid}/ontology"
    assert (await client.get(root)).status_code == 401
    before = await client.get(root, headers=auth)
    assert before.status_code == 200, before.text
    assert before.json()["claims"] == []
    assert before.json()["preparation"]["enabled"] is False
    prepared = await client.post(root + "/prepare", headers=auth, json={})
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["preparation"]["enabled"] is True
    thread = await client.post(f"/api/agents/{aid}/threads", headers=auth)
    tid = thread.json()["thread_id"]
    context = await client.get(root + "/context/" + tid, headers=auth)
    assert context.status_code == 200, context.text
    assert context.json()["claims"] == []
    assert "flow" in context.json()
    assert (await client.get(root + "/context/missing", headers=auth)).status_code == 404
    other = await create_user(client, auth, username="other-owner", role="admin")
    for headers in (
        other,
        bearer(
            sign_token(
                server.services.secret_repo.get("jwt"),
                sub=1,
                uname="admin",
                role="admin",
                application_id="zhijun",
            )
        ),
    ):
        for method, suffix, body in (
            ("GET", "", None),
            ("POST", "/prepare", {}),
            ("GET", "/context/" + tid, None),
        ):
            response = await client.request(method, root + suffix, headers=headers, json=body)
            assert response.status_code == 404, response.text
    shared = await client.patch(f"/api/agents/{aid}", headers=auth, json={"is_shared": True})
    assert shared.status_code == 200, shared.text
    assert (await client.get(root, headers=auth)).status_code == 404
