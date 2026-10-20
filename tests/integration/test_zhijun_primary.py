"""Single private companion identity persists without rewriting personal data."""

import json
from unittest.mock import AsyncMock

from tests.support.auth import create_agent, create_user


async def test_primary_identity_unique_owned_and_config_preserving(env_with_provider, monkeypatch):
    client, server, auth = env_with_provider
    first = await create_agent(client, auth)
    second = await create_agent(client, auth, name="second-bot")
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    before = registry.get_config(first)
    path = f"/api/agents/{first}/zhijun-profile"
    assert (await client.put(path, json={"version": 1})).status_code == 401
    for values in [{"version": 2}, {"version": 1, "agent_id": second}]:
        assert (await client.put(path, headers=auth, json=values)).status_code == 422
    assert (await client.put(path, headers=auth, json={"version": 1})).status_code == 200
    assert (await client.put(path, headers=auth, json={"version": 1})).status_code == 200
    after = registry.get_config(first)
    assert after.pop("zhijun_profile") == {"version": 1, "primary": True}
    assert after == before
    refused = await client.put(
        f"/api/agents/{second}/zhijun-profile", headers=auth, json={"version": 1}
    )
    assert refused.status_code >= 400
    assert "zhijun_profile" not in registry.get_config(second)
    other = await create_user(client, auth, username="other-primary", role="admin")
    assert (await client.put(path, headers=other, json={"version": 1})).status_code == 403
    assert json.loads(registry.get_row(first).config_json)["zhijun_profile"]["primary"]
    listing = (await client.get("/api/agents", headers=auth)).json()
    assert [a["agent_id"] for a in listing if a.get("zhijun_primary")] == [first]


async def test_primary_binding_busy_and_failed_reload_roll_back(env_with_provider, monkeypatch):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    registry = server.app_runtime.agent_registry
    before = registry.get_config(aid)
    monkeypatch.setattr(registry, "try_begin_history_backfill", lambda _: False)
    response = await client.put(
        f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1}
    )
    assert response.status_code == 409
    assert registry.get_config(aid) == before
    monkeypatch.setattr(registry, "try_begin_history_backfill", lambda _: True)
    original = registry._reload_agent

    async def reload(agent_id, **kwargs):
        if registry.get_config(agent_id).get("zhijun_profile"):
            raise RuntimeError("injected failure")
        await original(agent_id, **kwargs)

    monkeypatch.setattr(registry, "_reload_agent", reload)
    response = await client.put(
        f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1}
    )
    assert response.status_code == 500
    assert registry.get_config(aid) == before


async def test_generic_config_cannot_create_replace_or_remove_primary_identity(env_with_provider):
    client, server, auth = env_with_provider
    marker = {"version": 1, "primary": True}
    created = await client.post(
        "/api/agents",
        headers=auth,
        json={"name": "copied-config", "config": {"zhijun_profile": marker}},
    )
    assert created.status_code == 201
    aid = created.json()["agent_id"]
    registry = server.app_runtime.agent_registry
    assert not created.json()["zhijun_primary"]
    assert "zhijun_profile" not in registry.get_config(aid)
    injected = await client.patch(
        f"/api/agents/{aid}", headers=auth, json={"config": {"zhijun_profile": marker}}
    )
    assert injected.status_code == 200
    assert not injected.json()["zhijun_primary"]
    assert "zhijun_profile" not in registry.get_config(aid)
    bound = await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    assert bound.status_code == 200
    for config in [{"temperature": 0.3}, {"zhijun_profile": {"primary": False}}]:
        changed = await client.patch(f"/api/agents/{aid}", headers=auth, json={"config": config})
        assert changed.status_code == 200
        assert changed.json()["zhijun_primary"]
        assert registry.get_config(aid)["zhijun_profile"] == marker
    await registry.update_config_json(aid, json.dumps({"zhijun_profile": None}))
    assert registry.get_config(aid)["zhijun_profile"] == marker


async def test_primary_task_grounding_follows_expression_preferences(
    env_with_provider, monkeypatch
):
    from octop.infra.agents.middleware.interaction import InteractionPreferencesMiddleware
    from octop.infra.agents.role_ontology import RoleOntologyMiddleware
    from tests.unit.agents.test_interaction_preferences import PREFERENCES

    client, server, auth = env_with_provider
    aid = await create_agent(client, auth, config={"temperature": 0.4})
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    assert (
        await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    ).status_code == 200
    assert (
        await client.put(
            f"/api/agents/{aid}/interaction-preferences", headers=auth, json=PREFERENCES
        )
    ).status_code == 200
    middleware = registry._harness_manager.get_agent(aid).config.middleware
    preferences = [
        i for i, m in enumerate(middleware) if isinstance(m, InteractionPreferencesMiddleware)
    ]
    grounding = [i for i, m in enumerate(middleware) if isinstance(m, RoleOntologyMiddleware)]
    assert len(preferences) == len(grounding) == 1
    assert preferences[0] < grounding[0]
    assert json.loads(registry.get_row(aid).config_json)["temperature"] == 0.4
