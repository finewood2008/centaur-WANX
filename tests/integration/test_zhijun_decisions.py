"""Owned HTTP records and destination declarations over native workspace/gateway."""

import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx

from octop.api.app import build_app
from octop.infra.gateway.gateway import ChannelCreateSpec
from tests.integration.test_application_isolation import isolated as isolated


async def test_decision_and_channel_policy_http_workflow(isolated, monkeypatch):
    client, server, wanx, zhijun, wanx_id, profile_id = isolated
    gateway = server.app_runtime.gateway
    monkeypatch.setattr(gateway, "_safe_register_channel", AsyncMock())
    row = server.app_runtime.agent_registry.get_row(profile_id)
    channel = await gateway.create_channel(
        ChannelCreateSpec(
            channel_id="decision-channel",
            agent_id=profile_id,
            user_id=row.user_id,
            kind="weixin",
            name="判断回访",
            config={"owner_weixin_user_id": "owner", "accounts": []},
        )
    )
    policies = await client.get("/api/zhijun/notification-channels", headers=zhijun)
    assert policies.status_code == 200, policies.text
    assert policies.json() == [
        {"channel_id": channel.channel_id, "purpose": "work", "declared": False}
    ]
    marked = await client.put(
        "/api/zhijun/notification-channels",
        headers=zhijun,
        json={"channel_id": channel.channel_id, "purpose": "private"},
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["declared"] and marked.json()["purpose"] == "private"
    assert json.loads(gateway.get_channel(channel.channel_id).config_json) == {
        "owner_weixin_user_id": "owner",
        "accounts": [],
    }
    book = await client.get("/api/zhijun/decisions", headers=zhijun)
    body = {
        "revision": book.json()["revision"],
        "description": "接下项目",
        "expectation": "两个月内回款",
        "revisit_at": "2026-11-02T09:00:00+08:00",
        "private": False,
        "push_summary": "回看项目回款",
    }
    created = await client.post("/api/zhijun/decisions", headers=zhijun, json=body)
    assert created.status_code == 200, created.text
    result = created.json()
    entry = result["entries"][0]
    assert entry["source_class"] == "owner_entry" and not entry["sensitive"]
    reviewed = await client.post(
        f"/api/zhijun/decisions/{entry['id']}:review",
        headers=zhijun,
        json={
            "revision": result["revision"],
            "outcome": "实际三个月",
            "reflection": "以后留足余量",
        },
    )
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["entries"][0]["expectation"] == "两个月内回款"
    assert reviewed.json()["entries"][0]["state"] == "reviewed"
    stale = await client.post("/api/zhijun/decisions", headers=zhijun, json=body)
    assert stale.status_code == 409
    forged = await client.post(
        "/api/zhijun/decisions", headers=zhijun, json={**body, "source_class": "owner_entry"}
    )
    assert forged.status_code == 422
    for path in ("/api/zhijun/decisions", "/api/zhijun/notification-channels"):
        assert (await client.get(path, headers=wanx)).status_code == 404
    foreign = await gateway.create_channel(
        ChannelCreateSpec(
            channel_id="foreign-channel",
            agent_id=wanx_id,
            user_id=row.user_id,
            kind="weixin",
            name="other",
            config={},
        )
    )
    denied = await client.put(
        "/api/zhijun/notification-channels",
        headers=zhijun,
        json={"channel_id": foreign.channel_id, "purpose": "private"},
    )
    assert denied.status_code == 404
    schema = client._octop_app.openapi()
    for path in (
        "/api/zhijun/decisions",
        "/api/zhijun/decisions/{decision_id}:review",
        "/api/zhijun/notification-channels",
    ):
        for operation in schema["paths"][path].values():
            assert operation["summary"] and operation["description"]
            assert operation["responses"]["200"]["content"]["application/json"]["schema"]
    docs_server = SimpleNamespace(
        services=replace(
            server.services, config=replace(server.services.config, enable_api_docs=True)
        )
    )
    docs_app = build_app(docs_server)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=docs_app), base_url="http://testserver"
    ) as docs_client:
        page = await docs_client.get("/api/docs")
        assert page.status_code == 200 and "/api/openapi.json" in page.text
