"""Real HTTP routes for the standalone browser contract, without launching Chrome."""

import asyncio
from unittest.mock import Mock

import pytest

from octop.infra.browser import control
from tests.support.auth import create_user


@pytest.fixture(autouse=True)
def browser_controls():
    control._controls.clear()
    yield
    control._controls.clear()


async def test_browser_capabilities_are_registered_authenticated_and_permission_checked(env):
    client, _server, auth = env
    response = await client.get("/api/browser/control-capabilities", headers=auth)
    assert response.status_code == 200
    assert response.json() == {
        "version": 1,
        "exclusive_control": True,
        "keyboard": True,
        "header_auth": True,
        "skill_learning": 1,
    }
    assert (await client.get("/api/browser/control-capabilities")).status_code == 401
    limited = await create_user(client, auth, username="limited", permissions=[])
    assert (
        await client.get("/api/browser/control-capabilities", headers=limited)
    ).status_code == 403
    assert (await client.get("/api/browser/learning/status", headers=limited)).status_code == 403
    from octop.api.app import build_app

    schema = build_app(_server).openapi()
    for path in [
        "/api/browser/control-capabilities",
        "/api/browser/model-access",
        "/api/browser/learning/start",
        "/api/browser/learning/stop",
    ]:
        assert path in schema["paths"]


async def test_configured_provider_uses_native_thread_composer_without_budget(env_with_main_agent):
    client, server, auth, agent = env_with_main_agent
    response = await client.post(
        "/api/admin/providers",
        headers=auth,
        json={
            "name": "DeepSeek",
            "kind": "openai",
            "base_url": "https://api.deepseek.com",
            "api_key": "synthetic-test-key",
            "models": [{"id": "test", "enabled": True}],
        },
    )
    assert response.status_code == 201
    response = await client.post(
        f"/api/agents/{agent}/threads", headers=auth, json={"title": "Browser"}
    )
    assert response.status_code == 201
    thread = response.json()["thread_id"]
    result = await client.post(
        "/api/browser/model-access", headers=auth, json={"agent_id": agent, "thread_id": thread}
    )
    assert result.status_code == 200
    assert result.json() == {
        "mode": "configured-provider",
        "model_ref": "DeepSeek/test",
        "task_budget_required": False,
    }
    row = server.app_runtime.gateway.thread_registry.get_thread(thread)
    assert row.model_ref == "DeepSeek/test"
    denied = await client.post(
        "/api/browser/model-access",
        headers=auth,
        json={"agent_id": agent, "thread_id": "not-owned"},
    )
    assert denied.status_code == 403


async def test_takeover_http_waits_for_inflight_before_unlocking(env_with_main_agent, monkeypatch):
    client, server, auth, agent = env_with_main_agent
    thread = (
        await client.post(f"/api/agents/{agent}/threads", headers=auth, json={"title": "Browser"})
    ).json()["thread_id"]
    await client.post("/api/browser/sessions/auto/handoff", headers=auth, json={"target": "user"})
    response = await client.post(
        "/api/browser/sessions/auto/handoff",
        headers=auth,
        json={"target": "agent", "agent_id": agent, "thread_id": thread},
    )
    assert response.status_code == 200
    me = (await client.get("/api/auth/me", headers=auth)).json()
    state = control.control_for(f"user-{me['id']}")
    cancel = Mock()
    monkeypatch.setattr(server.app_runtime.agent_registry, "cancel_stream", cancel)
    async with state.lock:
        pending = asyncio.create_task(
            client.post("/api/browser/sessions/auto/handoff", headers=auth, json={"target": "user"})
        )
        await asyncio.sleep(0.05)
        assert state.owner == "user"
        assert not pending.done()
    assert (await pending).status_code == 200
    cancel.assert_called_once_with(agent, thread)
    assert state.thread_id == ""
    response = await client.post(
        "/api/browser/sessions/auto/handoff",
        headers=auth,
        json={"target": "agent", "agent_id": agent, "thread_id": "foreign"},
    )
    assert response.status_code == 403
    assert state.owner == "user"
