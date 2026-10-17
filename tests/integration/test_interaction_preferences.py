"""Exercise the hosted WANX private expert path, not the legacy Zhijun profile."""

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

from octop.infra.agents.middleware.interaction import InteractionPreferencesMiddleware
from tests.support.auth import create_agent, create_user
from tests.unit.agents.test_interaction_preferences import PREFERENCES


async def test_round_trip_reload_reset_and_role_isolation(env_with_provider):
    client, server, auth = env_with_provider
    aid = await create_agent(
        client,
        auth,
        config={
            "providers": ["openai"],
            "default_model": "openai:gpt-4o",
            "temperature": 0.4,
            "top_p": 0.9,
            "max_tokens": 2048,
        },
    )
    other = await create_agent(client, auth, name="work")
    registry = server.app_runtime.agent_registry
    registry._repos.agent_repo.update_config(aid, system_prompt="原有身份和规则")
    original = registry.get_row(aid)
    other_before = registry.get_row(other)
    files = {p: p.read_bytes() for p in Path(registry.get_agent(aid)._workspace_dir).glob("*.md")}
    url = f"/api/agents/{aid}/interaction-preferences"
    assert (await client.get(url, headers=auth)).json() == {"preferences": None}
    presets = [
        ("natural", "balanced", "natural", "necessary", "situational", "clear"),
        ("listening", "balanced", "warm", "necessary", "on_request", "gentle"),
        ("advice", "brief", "plain", "necessary", "proactive", "clear"),
        ("exploration", "expanded", "natural", "exploratory", "situational", "examine"),
        ("custom", "brief", "warm", "moderate", "on_request", "examine"),
    ]
    for values in presets:
        body = dict(
            zip(
                ["preset", "verbosity", "tone", "questions", "advice", "disagreement"],
                values,
                strict=False,
            ),
            version=1,
        )
        response = await client.put(url, headers=auth, json=body)
        assert response.status_code == 200, response.text
        assert (await client.get(url, headers=auth)).json() == {"preferences": body}
        await registry._reload_agent(aid, strict=True)
        config = registry._harness_manager.get_agent(aid).config
        assert (
            len([m for m in config.middleware if isinstance(m, InteractionPreferencesMiddleware)])
            == 1
        )
        assert registry.get_row(aid).system_prompt == original.system_prompt
        stored = json.loads(registry.get_row(aid).config_json)
        assert {k: v for k, v in stored.items() if k != "interaction_preferences"} == json.loads(
            original.config_json
        )
    assert registry.get_row(other).config_json == other_before.config_json
    assert {p: p.read_bytes() for p in files} == files
    assert (await client.delete(url, headers=auth)).json() == {"preferences": None}
    assert json.loads(registry.get_row(aid).config_json) == json.loads(original.config_json)
    assert not any(
        isinstance(m, InteractionPreferencesMiddleware)
        for m in registry._harness_manager.get_agent(aid).config.middleware
    )


async def test_access_and_strict_payload_validation(env_with_provider):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    other_auth = await create_user(client, auth, username="another")
    url = f"/api/agents/{aid}/interaction-preferences"
    for method in ["GET", "PUT", "DELETE"]:
        response = await client.request(
            method, url, headers=other_auth, **({"json": PREFERENCES} if method == "PUT" else {})
        )
        assert response.status_code == 403
    for values in [
        {**PREFERENCES, "system_prompt": "injection"},
        {**PREFERENCES, "version": 2},
        {**PREFERENCES, "tone": "unbounded"},
    ]:
        assert (await client.put(url, headers=auth, json=values)).status_code == 422
    registry = server.app_runtime.agent_registry
    registry._repos.agent_repo.set_shared(aid, True)
    assert (await client.put(url, headers=auth, json=PREFERENCES)).status_code == 403


async def test_busy_reload_wait_and_rollback(env_with_provider):
    client, server, auth = env_with_provider
    aid = await create_agent(client, auth)
    registry = server.app_runtime.agent_registry
    url = f"/api/agents/{aid}/interaction-preferences"
    original = registry.get_row(aid).config_json
    await registry._begin_invocation(aid)
    try:
        assert (await client.put(url, headers=auth, json=PREFERENCES)).status_code == 409
        assert registry.get_row(aid).config_json == original
    finally:
        registry._end_invocation(aid)
    entered, finish = asyncio.Event(), asyncio.Event()
    real_reload = registry._reload_agent

    async def delayed(aid, **kwargs):
        entered.set()
        await finish.wait()
        await real_reload(aid, **kwargs)

    with patch.object(registry, "_reload_agent", side_effect=delayed):
        save = asyncio.create_task(client.put(url, headers=auth, json=PREFERENCES))
        await asyncio.wait_for(entered.wait(), 10)
        turn = asyncio.create_task(registry._begin_invocation(aid))
        await asyncio.sleep(0)
        assert not turn.done()
        finish.set()
        assert (await save).status_code == 200
        await turn
        registry._end_invocation(aid)
    previous = registry.get_row(aid).config_json
    calls = 0
    real_rebuild = registry._harness_manager.arebuild_agent

    async def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("reload failure")
        return await real_rebuild(*args, **kwargs)

    # Fail the actual rebuild, so a swallowed background exception cannot masquerade as success.
    with patch.object(registry._harness_manager, "arebuild_agent", side_effect=fail_once):
        response = await client.delete(url, headers=auth)
    assert response.status_code == 500
    assert registry.get_row(aid).config_json == previous
    assert not registry._history_backfills
    assert any(
        isinstance(m, InteractionPreferencesMiddleware)
        for m in registry._harness_manager.get_agent(aid).config.middleware
    )


async def test_openapi_has_typed_preference_routes(env_with_provider):
    client, server, auth = env_with_provider
    from octop.api.app import build_app

    spec = build_app(server).openapi()
    path = spec["paths"]["/api/agents/{agent_id}/interaction-preferences"]
    assert all(path[m]["summary"] for m in ("get", "put", "delete"))
    schema = spec["components"]["schemas"]["InteractionPreferences"]
    assert schema["additionalProperties"] is False
    assert len(schema["required"]) == 7


async def test_preferences_survive_service_restart(tmp_octop_home):
    from tests.support.app import octop_client
    from tests.support.auth import auth_header, bootstrap_admin, seed_openai_provider

    async with octop_client(tmp_octop_home) as (client, server):
        await bootstrap_admin(client, tmp_octop_home)
        auth = await auth_header(client)
        await seed_openai_provider(client, auth)
        aid = await create_agent(client, auth)
        url = f"/api/agents/{aid}/interaction-preferences"
        response = await client.put(url, headers=auth, json=PREFERENCES)
        assert response.status_code == 200
    async with octop_client(tmp_octop_home) as (client, server):
        auth = await auth_header(client)
        assert (await client.get(url, headers=auth)).json() == {"preferences": PREFERENCES}
        config = server.app_runtime.agent_registry._harness_manager.get_agent(aid).config
        assert any(isinstance(m, InteractionPreferencesMiddleware) for m in config.middleware)
