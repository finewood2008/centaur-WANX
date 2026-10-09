"""Two real synthetic accounts, native auth, workspace persistence and API isolation."""

import json
from unittest.mock import AsyncMock

from octop.infra.agents import digital_self as service
from tests.integration.test_zhijun_profile import zhijun_auth
from tests.support.auth import TEST_PASSWORD


async def test_digital_self_two_accounts_publish_approve_chat_clear_and_openapi(
    env_with_provider, monkeypatch
):
    client, server, wanx = env_with_provider
    owner = await zhijun_auth(client)
    own_profile = (await client.post("/api/zhijun/profile", headers=owner)).json()["profile"]
    visitor = await server.user_manager.create(
        username="digital-self-visitor", password=TEST_PASSWORD, role="user"
    )
    logged = await client.post(
        "/api/auth/login",
        json={"username": visitor.username, "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    assert logged.status_code == 200, logged.text
    guest = {"Authorization": f"Bearer {logged.json()['access_token']}"}
    guest_profile = (await client.post("/api/zhijun/profile", headers=guest)).json()["profile"]
    base = "/api/zhijun/digital-self"
    initial = await client.get(base + "/me", headers=owner)
    assert initial.status_code == 200, initial.text
    assert initial.json()["status"] == "unpublished"
    draft = initial.json()["draft"]
    draft.update(
        name="合成研究者",
        bio="讨论研究方法",
        entries=[
            {
                "id": "method",
                "title": "检查条件",
                "text": "先检查判断的前提，再比较相反的例子。",
                "source": None,
                "recognized": True,
            }
        ],
    )
    state = (
        await client.put(
            base + "/me",
            headers=owner,
            json={"revision": "empty", "action": "publish", "draft": draft},
        )
    ).json()
    assert state["status"] == "published"
    sid = state["id"]
    infer = AsyncMock(
        return_value=json.dumps(
            {
                "answer": "这是基于本人发布的方法所作的推演。可以先比较两个条件。",
                "sources": ["method"],
                "options": ["我想先比较条件"],
                "memory": [{"text": "希望讨论研究方法", "quote": "我正在研究这个方法"}],
            },
            ensure_ascii=False,
        )
    )
    monkeypatch.setattr(service, "_infer", infer)
    monkeypatch.setattr(service, "_model", lambda _h: {"name": "synthetic:model", "local": True})
    found = await client.get(base, headers=guest)
    assert found.status_code == 200, found.text
    assert [i["id"] for i in found.json()["items"]] == [sid]
    assert found.json()["network_status"] == "contract_pending"
    assert (await client.get(base, headers=wanx)).status_code == 404
    assert (
        await client.get(f"/api/agents/{own_profile['agent_id']}", headers=guest)
    ).status_code == 403
    assert (
        await client.get(f"/api/agents/{guest_profile['agent_id']}", headers=owner)
    ).status_code == 403  # admin does not cross private ownership
    applied = await client.post(f"{base}/{sid}/access", headers=guest, json={"note": "合成咨询"})
    assert applied.status_code == 200, applied.text
    assert applied.json()["access_status"] == "pending"
    history = (await client.get(f"{base}/{sid}/conversation", headers=guest)).json()
    question = {
        "request_id": "synthetic_request_0001",
        "revision": history["revision"],
        "publication_version": state["publication"]["version"],
        "text": "我正在研究这个方法",
        "acknowledge_owner_visibility": True,
    }
    assert (
        await client.post(f"{base}/{sid}/conversation", headers=guest, json=question)
    ).status_code == 403
    current = (await client.get(base + "/me", headers=owner)).json()
    granted = await client.post(
        base + "/me/access",
        headers=owner,
        json={"revision": current["revision"], "visitor_id": visitor.id, "action": "approve"},
    )
    assert granted.status_code == 200, granted.text
    result = await client.post(f"{base}/{sid}/conversation", headers=guest, json=question)
    assert result.status_code == 200, result.text
    assert len(result.json()["messages"]) == 2
    args = infer.call_args.args
    assert args[3]["sources"] == [
        {"id": "method", "title": "检查条件", "text": "先检查判断的前提，再比较相反的例子。"}
    ]
    source = await client.get(f"{base}/{sid}/sources/method", headers=guest)
    assert source.status_code == 200 and set(source.json()) == {
        "id",
        "title",
        "text",
        "publication_version",
    }
    assert (await client.get(f"{base}/{sid}/sources/SOUL.md", headers=guest)).status_code == 404
    owner_history = await client.get(f"{base}/me/visitors/{visitor.id}", headers=owner)
    assert owner_history.json()["messages"] == result.json()["messages"]
    assert (await client.get(f"{base}/me/visitors/{visitor.id}", headers=guest)).status_code == 404
    conflict = await client.request(
        "DELETE",
        f"{base}/{sid}/conversation",
        headers=guest,
        json={"revision": "stale", "action": "clear"},
    )
    assert conflict.status_code == 409
    cleared = await client.request(
        "DELETE",
        f"{base}/{sid}/conversation",
        headers=guest,
        json={"revision": result.json()["revision"], "action": "clear"},
    )
    assert (
        cleared.status_code == 200
        and cleared.json()["messages"] == []
        and cleared.json()["memory"] == []
    )
    assert (await client.get(f"{base}/me/visitors/{visitor.id}", headers=owner)).json()[
        "messages"
    ] == []
    assert (await client.get(base + "/me", headers=guest)).json()["draft"]["entries"] == []
    assert infer.call_count == 1
    from octop.api.app import build_app

    openapi = build_app(server).openapi()
    routes = {path: spec for path, spec in openapi["paths"].items() if path.startswith(base)}
    assert len(routes) == 10
    for spec in routes.values():
        for method in spec.values():
            assert (
                method["summary"]
                and method["responses"]["200"]["content"]["application/json"]["schema"]
            )
