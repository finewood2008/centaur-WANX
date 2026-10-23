"""Real HTTP ownership and durable interview transitions; no model or personal data."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

from tests.support.auth import create_agent, create_user


async def setup(env, monkeypatch):
    client, server, auth = env
    aid = await create_agent(client, auth)
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    assert (
        await client.put(f"/api/agents/{aid}/zhijun-profile", headers=auth, json={"version": 1})
    ).status_code == 200
    return client, server, auth, aid, f"/api/agents/{aid}/ontology/interview"


async def test_interview_pause_resume_restart_and_owner_isolation(env_with_provider, monkeypatch):
    client, server, auth, aid, path = await setup(env_with_provider, monkeypatch)
    first = (await client.get(path, headers=auth)).json()
    assert first["status"] == "not_started"
    body = {"action": "start", "expected_version": first["version"], "request_id": "start"}
    response = await client.post(path, headers=auth, json=body)
    assert response.status_code == 200, response.text
    active = response.json()
    assert active["status"] == "active" and active["step"] == 0
    assert active == (await client.post(path, headers=auth, json=body)).json()
    threads = server.app_runtime.gateway.thread_registry
    assert threads.get_thread(active["thread_id"]).agent_id == aid
    assert threads.get_thread(active["thread_id"]).user_id == 1
    for action, expected in [
        ("pause", "paused"),
        ("resume", "active"),
        ("next", "active"),
        ("finish", "completed"),
    ]:
        previous = active
        response = await client.post(
            path,
            headers=auth,
            json={"action": action, "expected_version": previous["version"], "request_id": action},
        )
        assert response.status_code == 200, response.text
        active = response.json()
        assert active["status"] == expected and active["thread_id"] == previous["thread_id"]
        assert (await client.get(path, headers=auth)).json() == active
    assert active["step"] == 1
    stale = await client.post(
        path,
        headers=auth,
        json={"action": "next", "expected_version": first["version"], "request_id": "stale"},
    )
    assert stale.status_code >= 400
    other = await create_user(client, auth, username="interview-other", role="admin")
    assert (await client.get(path, headers=other)).status_code == 404
    assert (await client.post(path, headers=other, json=body)).status_code == 404
    assert (
        await client.post(path, headers=auth, json={**body, "thread_id": "foreign"})
    ).status_code == 422
    # Deleting the original conversation allows an explicit new start, never a silent reassignment.
    threads.delete_thread(active["thread_id"])
    assert not (await client.get(path, headers=auth)).json()["thread_available"]
    restarted = await client.post(
        path,
        headers=auth,
        json={"action": "start", "expected_version": active["version"], "request_id": "restart"},
    )
    assert restarted.status_code == 200
    assert restarted.json()["thread_id"] != active["thread_id"]


async def test_interview_busy_and_failed_save_create_no_orphan_thread(
    env_with_provider, monkeypatch
):
    client, server, auth, aid, path = await setup(env_with_provider, monkeypatch)
    registry = server.app_runtime.agent_registry
    body = {"action": "start", "expected_version": "empty", "request_id": "start"}
    threads = server.app_runtime.gateway.thread_registry
    before = [t.thread_id for t in threads.list_threads(agent_id=aid, user_id=1)]
    original = registry.try_begin_history_backfill
    monkeypatch.setattr(registry, "try_begin_history_backfill", lambda _: False)
    assert (await client.post(path, headers=auth, json=body)).status_code == 409
    monkeypatch.setattr(registry, "try_begin_history_backfill", original)
    workspace = registry.get_agent(aid).workspace
    monkeypatch.setattr(
        workspace, "aupload_bytes", AsyncMock(side_effect=OSError("injected write failure"))
    )
    assert (await client.post(path, headers=auth, json=body)).status_code == 500
    assert [t.thread_id for t in threads.list_threads(agent_id=aid, user_id=1)] == before
    assert (await client.get(path, headers=auth)).json()["status"] == "not_started"


async def test_changes_http_requires_owner_and_displayed_versions(env_with_provider, monkeypatch):
    from octop.infra.agents.personal_ontology import _save
    from tests.unit.agents.test_zhijun_changes import document

    client, server, auth, aid, _ = await setup(env_with_provider, monkeypatch)
    harness = server.app_runtime.agent_registry.get_agent(aid)
    monkeypatch.setattr(harness, "_memory_runtime", SimpleNamespace(memory=None), raising=False)
    workspace = harness.workspace
    await _save(workspace, document())
    path = f"/api/agents/{aid}/ontology/changes"
    response = await client.get(path, headers=auth)
    assert response.status_code == 200 and len(response.json()) == 1
    body = {
        "action": "exception",
        "request_id": "http",
        "expected_version": "rv",
        "source_version": "v2",
        "target_version": "v1",
        "note": "转换期",
    }
    other = await create_user(client, auth, username="change-other", role="admin")
    assert (await client.get(path, headers=other)).status_code == 404
    assert (await client.post(path + "/r", headers=other, json=body)).status_code == 404
    assert (
        await client.post(path + "/r", headers=auth, json={**body, "agent_id": "foreign"})
    ).status_code == 422
    stale = await client.post(path + "/r", headers=auth, json={**body, "target_version": "old"})
    assert stale.status_code == 200 and stale.json()["status"] == "stale"
    saved = await client.post(path + "/r", headers=auth, json=body)
    assert saved.status_code == 200 and saved.json()["status"] == "ready"
    assert (await client.get(path, headers=auth)).json() == []


async def test_interview_uncertain_write_keeps_thread_and_recovers_same_request(
    env_with_provider, monkeypatch
):
    client, server, auth, aid, path = await setup(env_with_provider, monkeypatch)
    workspace = server.app_runtime.agent_registry.get_agent(aid).workspace
    upload = workspace.aupload_bytes

    async def uncertain_write(name, content):
        await upload(name, content)
        raise OSError("connection lost after persistence")

    monkeypatch.setattr(workspace, "aupload_bytes", uncertain_write)
    body = {"action": "start", "expected_version": "empty", "request_id": "uncertain"}
    assert (await client.post(path, headers=auth, json=body)).status_code == 500
    current = (await client.get(path, headers=auth)).json()
    assert current["status"] == "active" and current["thread_available"]
    assert (await client.post(path, headers=auth, json=body)).json() == current
    threads = server.app_runtime.gateway.thread_registry.list_threads(agent_id=aid, user_id=1)
    assert len(threads) == 1


async def test_interview_and_change_docs_are_typed_and_renderable(env_with_provider):
    from copy import copy
    from dataclasses import replace

    import httpx

    from octop.api.app import build_app

    _, server, auth = env_with_provider
    docs_server = copy(server)
    docs_server.services = replace(
        server.services, config=replace(server.services.config, enable_api_docs=True)
    )
    app = build_app(docs_server)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        html = await client.get("/api/docs", headers=auth)
        assert html.status_code == 200 and "/api/openapi.json" in html.text
        spec = (await client.get("/api/openapi.json", headers=auth)).json()
    paths = spec["paths"]
    for suffix in ["interview", "changes", "changes/{relation_id}"]:
        assert all(
            op.get("summary") for op in paths["/api/agents/{agent_id}/ontology/" + suffix].values()
        )
    for name in [
        "InterviewView",
        "InterviewCommand",
        "ChangeView",
        "ChangeCommand",
        "ChangeResult",
    ]:
        assert name in spec["components"]["schemas"]
