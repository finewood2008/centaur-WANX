"""Zhijun ontology survives reads, is application scoped, and leaves memory unchanged."""

import json
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

from langchain_core.messages import AIMessage

from tests.integration.test_zhijun_profile import zhijun_auth


async def test_ontology_native_evidence_persistence_and_api_scope(
    env_with_provider: Any, monkeypatch: Any
) -> None:
    from octop.api.common.memory_client import _open_memory_for_agent
    from tests.integration.test_memory_api import _seed_memory

    client, server, wanx = env_with_provider
    auth = await zhijun_auth(client)
    profile = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    aid = profile["agent_id"]
    uid = profile["user_id"]
    _seed_memory(server, aid)
    memory, _ = _open_memory_for_agent(server, aid)
    raw = memory.get_raw("raw-1")
    candidate = memory.get_candidate("cand-1")
    atom = memory.get_atom("atom-1")
    for i, quote in enumerate(["合作时先看分工有没有落实", "下次投入之前我还是要看行动"], start=1):
        memory.add_raw_batch(
            [
                replace(
                    raw,
                    id=f"owner-r{i}",
                    user=str(uid),
                    session_id=f"experience-{i}",
                    thread_id=f"experience-{i}",
                    event_type="user_message",
                    content=quote,
                    timestamp=datetime.now(UTC),
                )
            ]
        )
        memory.add_candidate(
            replace(
                candidate,
                id=f"owner-c{i}",
                raw_event_ids=[f"owner-r{i}"],
                quote_event_id=f"owner-r{i}",
                subject_entity_type="User",
                assertion=quote,
                verbatim_quote=quote,
            )
        )
        memory.add_atom(
            replace(
                atom,
                id=f"owner-a{i}",
                candidate_id=f"owner-c{i}",
                raw_event_ids=[f"owner-r{i}"],
                quote_event_id=f"owner-r{i}",
                assertion=quote,
                verbatim_quote=quote,
            )
        )
    native = server.app_runtime.agent_registry.get_agent(aid)
    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=AIMessage(
                content=json.dumps(
                    {
                        "claims": [
                            {
                                "kind": "principle",
                                "title": "先看行动再投入",
                                "statement": "合作时倾向先看分工和行动，再决定投入。",
                                "conditions": "较大合作投入",
                                "exceptions": "尚待核对例外",
                                "evidence_ids": ["owner-a1", "owner-a2"],
                            }
                        ]
                    },
                    ensure_ascii=False,
                )
            )
        )
    )
    harness = SimpleNamespace(
        workspace=native.workspace,
        _memory_runtime=SimpleNamespace(memory=memory),
        model_factory=SimpleNamespace(get=Mock(return_value=llm)),
        config=SimpleNamespace(pick_default_model_ref=lambda: "own/default"),
    )
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry, "get_agent", lambda _aid: harness)
    before = [(a.id, a.assertion) for a in memory.list_atoms()]
    initial = await client.get("/api/zhijun/ontology", headers=auth)
    assert initial.status_code == 200, initial.text
    assert initial.json()["claims"] == []
    llm.ainvoke.assert_not_called()
    response = await client.post(
        "/api/zhijun/ontology:generate", headers=auth, json={"revision": initial.json()["revision"]}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ready"
    doc = response.json()["ontology"]
    claim = doc["claims"][0]
    assert claim["state"] == "draft" and claim["evidence_valid"]
    review = await client.post(
        f"/api/zhijun/ontology/{claim['id']}:review",
        headers=auth,
        json={"revision": doc["revision"], "action": "confirm"},
    )
    assert review.status_code == 200, review.text
    assert review.json()["ontology"]["claims"][0]["state"] == "confirmed"
    again = (await client.get("/api/zhijun/ontology", headers=auth)).json()
    assert again["revision"] == review.json()["ontology"]["revision"]
    assert [(a.id, a.assertion) for a in memory.list_atoms()] == before
    for method, path, body in [
        ("get", "/api/zhijun/ontology", None),
        ("post", "/api/zhijun/ontology:generate", {"revision": "empty"}),
        (
            "post",
            f"/api/zhijun/ontology/{claim['id']}:review",
            {"revision": again["revision"], "action": "confirm"},
        ),
    ]:
        kwargs = {"headers": wanx}
        if body is not None:
            kwargs["json"] = body
        denied = await getattr(client, method)(path, **kwargs)
        assert denied.status_code == 404
    invalid = await client.post(
        "/api/zhijun/ontology:generate",
        headers=auth,
        json={"revision": "empty", "agent_id": "foreign"},
    )
    assert invalid.status_code == 422
    schema = client._octop_app.openapi()
    for path in [
        "/api/zhijun/ontology",
        "/api/zhijun/ontology:generate",
        "/api/zhijun/ontology/{claim_id}:review",
    ]:
        route = next(iter(schema["paths"][path].values()))
        assert (
            route["summary"] and route["description"] and "$ref" in str(route["responses"]["200"])
        )


async def test_ontology_v2_owner_edit_restore_revision_and_application_boundary(
    env_with_provider: Any,
) -> None:
    client, server, wanx = env_with_provider
    auth = await zhijun_auth(client)
    profile = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    from octop.api.common.memory_client import _open_memory_for_agent
    from tests.integration.test_memory_api import _seed_memory

    _seed_memory(server, profile["agent_id"])
    memory, _ = _open_memory_for_agent(server, profile["agent_id"])
    registry = server.app_runtime.agent_registry
    registry.get_agent(profile["agent_id"])._memory_runtime = SimpleNamespace(memory=memory)
    created = await client.post(
        "/api/zhijun/ontology:nodes",
        headers=auth,
        json={
            "revision": "empty",
            "action": "add",
            "statement": "我希望先被听见",
            "kind": "response",
        },
    )
    assert created.status_code == 200, created.text
    doc = created.json()["ontology"]
    claim = doc["claims"][0]
    assert claim["source_kind"] == "self_report" and claim["evidence"] == []
    path = f"/api/zhijun/ontology/{claim['id']}:edit"
    changed = (
        await client.post(
            path,
            headers=auth,
            json={
                "revision": doc["revision"],
                "action": "change",
                "statement": "我现在想一起讨论",
                "kind": "response",
            },
        )
    ).json()
    assert changed["status"] == "ready" and changed["ontology"]["claims"][0]["changed"]
    stale = await client.post(
        path, headers=auth, json={"revision": doc["revision"], "action": "disable"}
    )
    assert stale.json()["status"] == "stale"
    restored = await client.post(
        path,
        headers=auth,
        json={
            "revision": changed["ontology"]["revision"],
            "action": "restore",
            "restore_version": changed["previous_version"],
        },
    )
    assert restored.json()["ontology"]["claims"][0]["statement"] == "我希望先被听见"
    for endpoint, method, payload in [
        (
            "/api/zhijun/ontology:nodes",
            "post",
            {"revision": "empty", "action": "add", "statement": "x"},
        ),
        (path, "post", {"revision": "empty", "action": "disable"}),
        ("/api/zhijun/ontology/context?thread_id=foreign&reply=test", "get", None),
    ]:
        assert (
            await client.request(
                method, endpoint, headers=wanx, **({"json": payload} if payload else {})
            )
        ).status_code == 404
    assert (
        await client.get(
            "/api/zhijun/ontology/context",
            headers=auth,
            params={"thread_id": "foreign", "reply": "test"},
        )
    ).status_code == 404
    config = registry._build_harness_config(registry.get_row(profile["agent_id"]))
    assert any(type(m).__name__ == "ZhijunOntologyMiddleware" for m in config.middleware)


async def test_context_api_is_owned_idempotent_versioned_and_openapi_documented(
    env_with_provider: Any,
) -> None:
    client, server, wanx = env_with_provider
    auth = await zhijun_auth(client)
    profile = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    from octop.api.common.memory_client import _open_memory_for_agent
    from tests.integration.test_memory_api import _seed_memory

    _seed_memory(server, profile["agent_id"])
    memory, _ = _open_memory_for_agent(server, profile["agent_id"])
    server.app_runtime.agent_registry.get_agent(
        profile["agent_id"]
    )._memory_runtime = SimpleNamespace(memory=memory)
    body = {
        "revision": "empty",
        "action": "add",
        "statement": "我在准备课程",
        "kind": "goal",
        "request_id": "one-request",
    }
    first = await client.post("/api/zhijun/ontology/context-nodes", headers=auth, json=body)
    assert first.status_code == 200, first.text
    second = await client.post("/api/zhijun/ontology/context-nodes", headers=auth, json=body)
    assert first.json()["changed_id"] == second.json()["changed_id"]
    node = next(
        n for n in first.json()["ontology"]["nodes"] if n["id"] == first.json()["changed_id"]
    )
    path = f"/api/zhijun/ontology/context-nodes/{node['id']}:edit"
    edited = await client.post(
        path,
        headers=auth,
        json={
            "revision": "unrelated",
            "expected_version": node["version"],
            "action": "correct",
            "kind": "goal",
            "statement": "我在准备第二期课程",
        },
    )
    assert edited.json()["status"] == "ready"
    conflict = await client.post(
        path,
        headers=auth,
        json={
            "revision": edited.json()["ontology"]["revision"],
            "expected_version": node["version"],
            "action": "disable",
        },
    )
    assert conflict.json()["status"] == "stale"
    assert (
        await client.post(path, headers=wanx, json={"revision": "empty", "action": "disable"})
    ).status_code == 404
    assert (
        await client.post("/api/zhijun/ontology/context-nodes", headers=wanx, json=body)
    ).status_code == 404
    assert (
        await client.post(
            path,
            headers=auth,
            json={"revision": "empty", "action": "disable", "agent_id": "foreign"},
        )
    ).status_code == 422
    schema = client._octop_app.openapi()
    for endpoint in [
        "/api/zhijun/ontology/context-nodes",
        "/api/zhijun/ontology/context-nodes/{node_id}:edit",
    ]:
        operation = schema["paths"][endpoint]["post"]
        assert operation["summary"] and operation["description"]
        assert "$ref" in str(operation["responses"]["200"])


async def test_core_admission_api_version_scope_thread_and_reread(env_with_provider: Any) -> None:
    import asyncio

    from octop.api.common.memory_client import _open_memory_for_agent
    from octop.infra.agents.ontology_runtime import select_context
    from octop.infra.agents.personal_ontology import read_personal_ontology

    client, server, wanx = env_with_provider
    auth = await zhijun_auth(client)
    profile = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    registry = server.app_runtime.agent_registry
    memory, _ = _open_memory_for_agent(server, profile["agent_id"])
    registry.get_agent(profile["agent_id"])._memory_runtime = SimpleNamespace(memory=memory)
    created = (
        await client.post(
            "/api/zhijun/ontology:nodes",
            headers=auth,
            json={
                "revision": "empty",
                "action": "add",
                "kind": "response",
                "statement": "希望你先听我说完",
            },
        )
    ).json()
    claim = created["ontology"]["claims"][0]
    assert claim["core_status"] == "pending"
    page = (await client.get("/api/zhijun/ontology/candidates?limit=1", headers=auth)).json()
    assert page["pending_count"] == 1 and page["total"] == 1
    endpoint = f"/api/zhijun/ontology/{claim['id']}:admission"
    body = {"action": "admit", "expected_version": claim["version"], "request_id": "test-admission"}
    assert (await client.post(endpoint, headers=wanx, json=body)).status_code == 404
    assert (await client.get("/api/zhijun/ontology/candidates", headers=wanx)).status_code == 404
    bound = await client.post(
        f"/api/zhijun/ontology/{claim['id']}:conversation",
        headers=auth,
        json={"expected_version": claim["version"]},
    )
    assert bound.status_code == 200, bound.text
    thread = bound.json()["thread"]
    again = await client.post(
        f"/api/zhijun/ontology/{claim['id']}:conversation",
        headers=auth,
        json={"expected_version": claim["version"]},
    )
    assert again.json()["thread"]["thread_id"] == thread["thread_id"]
    owner_thread = server.app_runtime.gateway.thread_registry.get_thread(thread["thread_id"])
    assert (
        owner_thread.user_id == profile["user_id"] and owner_thread.agent_id == profile["agent_id"]
    )
    doc = await read_personal_ontology(registry, profile["user_id"], check_changes=False)
    assert not select_context(doc, "先听", "other").claims
    a, b = await asyncio.gather(
        client.post(endpoint, headers=auth, json=body),
        client.post(endpoint, headers=auth, json=body),
    )
    assert a.status_code == b.status_code == 200
    assert (
        a.json()["ontology"]["claims"][0]["version"] == b.json()["ontology"]["claims"][0]["version"]
    )
    saved = (await client.get("/api/zhijun/ontology", headers=await zhijun_auth(client))).json()
    assert saved["claims"][0]["admitted_by"] == profile["user_id"]
    assert (
        await client.post(endpoint, headers=auth, json={**body, "request_id": "stale-new-key"})
    ).json()["status"] == "stale"
    assert (
        await client.post(endpoint, headers=auth, json={**body, "action": "reject"})
    ).status_code == 403
    doc = await read_personal_ontology(registry, profile["user_id"], check_changes=False)
    assert len(select_context(doc, "今天累了", "next").claims) == 1
    assert (await client.get("/api/zhijun/ontology/candidates", headers=auth)).json()["total"] == 0
    # Tool input cannot impersonate admission; the typed route accepts no ownership overrides.
    forged = {**body, "user_id": 99, "admitted_by": 99}
    assert (await client.post(endpoint, headers=auth, json=forged)).status_code == 422
    schema = client._octop_app.openapi()
    assert "/api/zhijun/ontology/{claim_id}:admission" in schema["paths"]
