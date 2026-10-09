"""Owner-scoped HTTP workflow from native documents to optional conversation context."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from octop.infra.agents import knowledge_understanding as understanding
from octop.infra.knowledge import jobs
from octop.infra.knowledge.service import KnowledgeService
from tests.integration.test_zhijun_knowledge import MODEL
from tests.integration.test_zhijun_knowledge import local_ready as local_ready
from tests.support.auth import TEST_PASSWORD, create_user, resolve_user_id
from tests.unit.agents.test_knowledge_understanding import proposal


async def auth(client, username="admin"):
    response = await client.post(
        "/api/auth/login",
        json={"username": username, "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


async def profile(client, server, headers):
    response = await client.post("/api/zhijun/profile", json={}, headers=headers)
    assert response.status_code == 200, response.text
    aid = response.json()["profile"]["agent_id"]
    harness = server.app_runtime.agent_registry.get_agent(aid)
    # HTTP fixtures fake harness execution; retain its real platform workspace and registry.
    harness.config.pick_default_model_ref = lambda: "synthetic/default"
    harness.config.resolve_model_ref = lambda _ref: (
        SimpleNamespace(base_url="http://127.0.0.1"),
        "synthetic",
    )
    harness.model_factory = SimpleNamespace(get=Mock(return_value=object()))
    harness._memory_runtime = SimpleNamespace(memory=None)
    return aid


def knowledge(server):
    server.services.settings_repo.set("knowledge_bases_enabled", "true")
    server.services.settings_repo.set("knowledge_embedding_backend", "onnx")
    server.services.settings_repo.set("knowledge_embedding_model", MODEL)
    return KnowledgeService(server.services, application_id="zhijun")


async def test_scope_role_and_owner_isolation_for_understanding_api(env_with_provider, local_ready):
    client, server, wanx_auth = env_with_provider
    await create_user(client, wanx_auth, username="other-admin", role="admin")
    other_uid = await resolve_user_id(client, wanx_auth, "other-admin")
    own_auth, other_auth = await auth(client), await auth(client, "other-admin")
    own_aid = await profile(client, server, own_auth)
    other_aid = await profile(client, server, other_auth)
    assert own_aid != other_aid
    service = knowledge(server)
    own_base = service.create_base(owner_user_id=1, name="Owner history")
    other_base = service.create_base(owner_user_id=other_uid, name="Other admin history")
    wanx_base = KnowledgeService(server.services).create_base(owner_user_id=1, name="WANX history")
    own = await client.get("/api/zhijun/understanding", headers=own_auth)
    assert own.status_code == 200, own.text
    assert {item["kb_id"] for item in own.json()["libraries"]} == {own_base.id}
    assert "documents" in own.json() and "weixin_deliveries" not in own.json()
    assert set(own.json()["model"]) == {"name", "local"}
    assert {
        item["kb_id"]
        for item in (await client.get("/api/zhijun/understanding", headers=other_auth)).json()[
            "libraries"
        ]
    } == {other_base.id}
    for blocked_id in (other_base.id, wanx_base.id):
        response = await client.put(
            "/api/zhijun/understanding",
            headers=own_auth,
            json={
                "revision": own.json()["revision"],
                "libraries": [{"kb_id": blocked_id, "selected": True, "role": "personal"}],
            },
        )
        assert response.status_code == 404, response.text
    for method, path, body in (
        ("GET", "/api/zhijun/understanding", None),
        ("PUT", "/api/zhijun/understanding", {"revision": "empty"}),
        ("POST", "/api/zhijun/understanding:run", {"revision": "empty"}),
        ("POST", "/api/zhijun/understanding:pause", {"revision": "empty"}),
        (
            "POST",
            "/api/zhijun/understanding/invitations/other:review",
            {"revision": "empty", "action": "accept"},
        ),
    ):
        response = await client.request(
            method, path, headers={**wanx_auth, "X-Application-Id": "zhijun"}, json=body
        )
        assert response.status_code == 404, response.text
    schema = client._octop_app.openapi()
    for path in (
        "/api/zhijun/understanding",
        "/api/zhijun/understanding:run",
        "/api/zhijun/understanding:pause",
        "/api/zhijun/understanding/invitations/{invitation_id}:review",
    ):
        for route in schema["paths"][path].values():
            assert route["summary"] and route["description"]
            assert "$ref" in route["responses"]["200"]["content"]["application/json"]["schema"]


async def test_http_reading_invitation_review_is_optional_versioned_and_not_a_user_message(
    env_with_provider, local_ready, monkeypatch
):
    client, server, wanx_auth = env_with_provider
    own_auth = await auth(client)
    aid = await profile(client, server, own_auth)
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry.ontology, "tick", AsyncMock())
    service = knowledge(server)
    base = service.create_base(owner_user_id=1, name="Synthetic personal notes")
    document = service.upload_document(
        base.id,
        actor_user_id=1,
        filename="history.md",
        content_type="text/markdown",
        content="当时我希望先看分工落实，再决定投入。".encode(),
    )
    jobs.process_document(server.services, base.id, document.id)
    model = AsyncMock(return_value=proposal())
    monkeypatch.setattr(understanding, "ainvoke_text", model)
    first = (await client.get("/api/zhijun/understanding", headers=own_auth)).json()
    model.assert_not_awaited()
    chosen = await client.put(
        "/api/zhijun/understanding",
        headers=own_auth,
        json={
            "revision": first["revision"],
            "enabled": False,
            "libraries": [{"kb_id": base.id, "selected": True, "role": "personal"}],
        },
    )
    assert chosen.status_code == 200, chosen.text
    model.assert_not_awaited()
    run = await client.post(
        "/api/zhijun/understanding:run",
        headers=own_auth,
        json={"revision": chosen.json()["revision"]},
    )
    assert run.status_code == 200, run.text
    model.assert_not_awaited()
    await understanding.process_understanding_batch(registry, 1)
    current = (await client.get("/api/zhijun/understanding", headers=own_auth)).json()
    item = current["invitations"][0]
    assert current["progress"]["status"] == "complete"
    assert item["source"]["document_id"] == document.id and item["status"] == "pending"
    assert model.await_count == 1
    path = "/api/zhijun/understanding/invitations/" + item["id"] + ":review"
    stale = await client.post(
        path, headers=own_auth, json={"revision": chosen.json()["revision"], "action": "accept"}
    )
    assert stale.status_code == 409, stale.text
    response = await client.post(
        path, headers=own_auth, json={"revision": current["revision"], "action": "read"}
    )
    assert response.status_code == 200, response.text
    current = response.json()
    assert current["invitations"][0]["read_at"]
    assert current["invitations"][0]["status"] == "pending"
    assert current["invitations"][0]["reviewed_at"] is None
    response = await client.post(
        path, headers=own_auth, json={"revision": current["revision"], "action": "accept"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["invitations"][0]["status"] == "active"
    assert (await client.get(f"/api/agents/{aid}/threads", headers=own_auth)).json() == []
    assert not (await client.get("/api/zhijun/ontology", headers=own_auth)).json()["claims"]
    current = response.json()
    conversation_path = path.removesuffix(":review") + ":conversation"
    threads_registry = server.app_runtime.gateway.thread_registry
    create_thread = threads_registry.create_thread
    monkeypatch.setattr(
        threads_registry, "create_thread", Mock(side_effect=RuntimeError("create interrupted"))
    )
    with pytest.raises(RuntimeError, match="create interrupted"):
        await understanding.start_invitation_conversation(
            registry, threads_registry, 1, item["id"], current["revision"]
        )
    interrupted = await understanding.read_understanding(registry, 1)
    reserved_tid = interrupted.invitations[0].discussion_thread_id
    assert reserved_tid and threads_registry.get_thread(reserved_tid) is None
    monkeypatch.setattr(threads_registry, "create_thread", create_thread)
    responses = await asyncio.gather(
        *(
            client.post(conversation_path, headers=own_auth, json={"revision": current["revision"]})
            for _ in range(2)
        )
    )
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    tid = responses[0].json()["thread"]["thread_id"]
    assert tid == reserved_tid
    assert responses[1].json()["thread"]["thread_id"] == tid
    current = responses[1].json()["state"]
    assert current["invitations"][0]["discussion_thread_id"] == tid
    threads = (await client.get(f"/api/agents/{aid}/threads", headers=own_auth)).json()
    assert len(threads) == 1
    history = (
        await client.get(f"/api/agents/{aid}/threads/{tid}/history", headers=own_auth)
    ).json()
    assert history["messages"] == []
    assert model.await_count == 1
    resolved = await client.post(
        path, headers=own_auth, json={"revision": current["revision"], "action": "resolve"}
    )
    assert resolved.status_code == 200, resolved.text
    resumed = await client.post(
        conversation_path, headers=own_auth, json={"revision": resolved.json()["revision"]}
    )
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["thread"]["thread_id"] == tid
    assert resumed.json()["state"]["invitations"][0]["status"] == "resolved"
    await create_user(client, wanx_auth, username="foreign-admin", role="admin")
    foreign_auth = await auth(client, "foreign-admin")
    await profile(client, server, foreign_auth)
    foreign = (await client.get("/api/zhijun/understanding", headers=foreign_auth)).json()
    response = await client.post(
        path, headers=foreign_auth, json={"revision": foreign["revision"], "action": "accept"}
    )
    assert response.status_code == 404, response.text
    response = await client.post(
        conversation_path, headers=foreign_auth, json={"revision": foreign["revision"]}
    )
    assert response.status_code == 404, response.text
    assert (await client.get("/api/zhijun/understanding", headers=foreign_auth)).json()[
        "invitations"
    ] == []
    service.update_text_document(
        base.id, document.id, actor_user_id=1, content="现在我的想法已经变化。"
    )
    jobs.process_document(server.services, base.id, document.id)
    changed = (await client.get("/api/zhijun/understanding", headers=own_auth)).json()
    assert changed["invitations"][0]["source_available"] is False
    response = await client.post(
        path, headers=own_auth, json={"revision": changed["revision"], "action": "accept"}
    )
    assert response.status_code == 404, response.text
    assert model.await_count == 1
    response = await client.post(
        conversation_path, headers=own_auth, json={"revision": changed["revision"]}
    )
    assert response.status_code == 404, response.text
