"""Scoped typed choice generation never becomes a conversation or memory write."""

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from tests.integration.test_zhijun_profile import zhijun_auth


async def test_choices_are_owned_ephemeral_and_documented(
    env_with_provider: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, wanx_auth = env_with_provider
    auth = await zhijun_auth(client)
    profile = (await client.post("/api/zhijun/profile", headers=auth)).json()["profile"]
    aid = profile["agent_id"]
    thread = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()
    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=AIMessage(
                content='{"options":[{"label":"产品方向","draft":"我想先理清核心产品的方向，再接着聊研发。"},{"label":"这周进展","draft":"我更想聊这周的研发进展，产品方向可以稍后说。"},{"label":"还没理清","draft":"研发里最需要聊的部分还没理清，我想从眼下慢慢说。"}]}'
            )
        )
    )
    harness = SimpleNamespace(
        aget_history=AsyncMock(
            return_value=[
                HumanMessage(content="这周在研发核心产品"),
                AIMessage(content="眼下，你更想先聊哪件事？"),
            ]
        ),
        model_factory=SimpleNamespace(get=Mock(return_value=llm)),
        config=SimpleNamespace(pick_default_model_ref=lambda: "synthetic/default"),
    )
    registry = server.app_runtime.agent_registry
    monkeypatch.setattr(registry, "get_agent", lambda _: harness)
    monkeypatch.setattr(registry, "is_agent_active", lambda _: False)
    body = {"thread_id": thread["thread_id"], "reply": "眼下，你更想先聊哪件事？"}
    before = server.services.thread_message_repo.head(thread["thread_id"])
    response = await client.post("/api/zhijun/response-options", headers=auth, json=body)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ready"
    assert len(response.json()["invitation"]["options"]) == 3
    assert server.services.thread_message_repo.head(thread["thread_id"]) == before
    for invalid in [{**body, "agent_id": aid}, {**body, "memory_confirmed": True}]:
        assert (
            await client.post("/api/zhijun/response-options", headers=auth, json=invalid)
        ).status_code == 422
    assert (
        await client.post("/api/zhijun/response-options", headers=wanx_auth, json=body)
    ).status_code == 404
    assert (
        await client.post(
            "/api/zhijun/response-options", headers=auth, json={**body, "thread_id": "not-owned"}
        )
    ).status_code == 404
    llm.ainvoke.assert_awaited_once()
    schema = client._octop_app.openapi()
    route = schema["paths"]["/api/zhijun/response-options"]["post"]
    assert route["summary"] and route["description"]
    assert "ResponseOptionsResult" in str(route["responses"]["200"])
