from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
import pytest

from octop.api.dialogue_gateway import build_gateway
from octop.config import OctopConfig
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.dialogue.contracts import DialogueError, Generation, event
from octop.infra.dialogue.gateway import GatewayConfig, GatewayService
from octop.infra.dialogue.ledger import Ledger
from octop.infra.dialogue.service import DialogueService
from octop.infra.utils.paths import PathLayout


def key() -> str:
    return uuid.uuid4().hex


MODELS = [
    {
        "id": model,
        "name": model.upper(),
        "provider": "test",
        "max_input_bytes": 24000,
        "input_units": 1,
        "output_units": 1,
        "max_output_tokens": 2048,
    }
    for model in ["a", "b", "c"]
]


@pytest.fixture
async def box(tmp_path: Path) -> AsyncIterator[tuple[DialogueService, int, list[dict[str, Any]]]]:
    db = SqlitePool(tmp_path / "box.sqlite")
    run_migrations(db)
    services = build_shared_services(db=db, paths=PathLayout(tmp_path), config=OctopConfig())
    uid = services.user_repo.create(username="alice", role="user")
    services.user_repo.create(username="bob", role="user")
    pid = services.provider_repo.create(
        name="platform",
        kind="openai",
        base_url="https://platform.test/v1",
        api_key="account-credential",
        extra_json='{"dialogue_gateway":true}',
    )
    services.settings_repo.set(f"dialogue.provider:dialogue:{uid}", str(pid))
    calls: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer account-credential"
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"models": MODELS})
        if request.url.path == "/v1/quota":
            return httpx.Response(200, json={"remaining": 10000})
        body = json.loads(request.content)
        calls.append(body)
        text = body["model"] + " 独立回答"
        return httpx.Response(
            200,
            text=event({"type": "delta", "text": text})
            + event(
                {
                    "type": "done",
                    "usage": {"input_tokens": 20, "output_tokens": 10},
                    "accounting": "reported",
                }
            ),
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    svc = DialogueService(services, client)
    yield svc, uid, calls
    await svc.close()
    db.close()


async def finish(svc: DialogueService, uid: int, sid: str) -> dict[str, Any]:
    if svc.tasks:
        await asyncio.gather(*list(svc.tasks.values()))
    return await svc.get((uid, "dialogue"), sid)


async def test_comparison_snapshot_branch_and_idempotency(box: Any) -> None:
    svc, uid, calls = box
    owner = (uid, "dialogue")
    request_id = key()
    initial = await svc.create(owner, request_id, "如何选择产品方向？", ["a", "b"])
    same = await svc.create(owner, request_id, "如何选择产品方向？", ["a", "b"])
    assert initial["id"] == same["id"]
    data = await finish(svc, uid, initial["id"])
    assert len(calls) == 2 and calls[0]["messages"] == calls[1]["messages"]
    assert all(a["status"] == "completed" for a in data["groups"][0]["answers"])
    assert "requests" not in data and "context" not in data["groups"][0]
    group = data["groups"][0]
    await svc.mutate(owner, data["id"], key(), "add", {"group_id": group["id"], "models": ["c"]})
    await finish(svc, uid, data["id"])
    assert calls[-1]["messages"] == calls[0]["messages"]
    answer = group["answers"][0]
    follow_id = key()
    body = {"answer_id": answer["id"], "prompt": "展开第二点"}
    await svc.mutate(owner, data["id"], follow_id, "continue", body)
    await svc.mutate(owner, data["id"], follow_id, "continue", body)
    final = await finish(svc, uid, data["id"])
    assert len(calls) == 4
    assert calls[-1]["messages"] == [
        {"role": "user", "content": "如何选择产品方向？"},
        {"role": "assistant", "content": "a 独立回答"},
        {"role": "user", "content": "展开第二点"},
    ]
    assert len(final["groups"]) == 2
    assert len(await svc.list_sessions(owner)) == 1


async def test_ownership_and_idempotency_conflicts(box: Any) -> None:
    svc, uid, _ = box
    owner = (uid, "dialogue")
    request_id = key()
    data = await svc.create(owner, request_id, "问题", ["a"])
    await finish(svc, uid, data["id"])
    for other in [(uid + 1, "dialogue"), (uid, "zhijun")]:
        with pytest.raises(DialogueError, match="NOT_FOUND"):
            await svc.get(other, data["id"])
        with pytest.raises(DialogueError, match="NOT_FOUND"):
            await svc.delete(other, data["id"])
        assert await svc.list_sessions(other) == []
    with pytest.raises(DialogueError, match="IDEMPOTENCY_CONFLICT"):
        await svc.create(owner, request_id, "另一个问题", ["a"])
    with pytest.raises(DialogueError, match="MODEL_UNAVAILABLE"):
        await svc.create(owner, key(), "问题", ["a", "a"])
    await svc.delete(owner, data["id"])
    assert await svc.list_sessions(owner) == []


async def test_retry_preserves_preexisting_branch_snapshot(box: Any) -> None:
    svc, uid, calls = box
    owner = (uid, "dialogue")
    data = await svc.create(owner, key(), "原问题", ["a"])
    data = await finish(svc, uid, data["id"])
    answer = data["groups"][0]["answers"][0]
    await svc.mutate(
        owner, data["id"], key(), "continue", {"answer_id": answer["id"], "prompt": "追问"}
    )
    data = await finish(svc, uid, data["id"])
    branch = data["groups"][1]
    retry_id = key()
    await svc.mutate(owner, data["id"], retry_id, "retry", {"answer_id": answer["id"]})
    await svc.mutate(owner, data["id"], retry_id, "retry", {"answer_id": answer["id"]})
    await finish(svc, uid, data["id"])
    await svc.mutate(owner, data["id"], key(), "add", {"group_id": branch["id"], "models": ["b"]})
    await finish(svc, uid, data["id"])
    assert calls[-1]["messages"] == calls[1]["messages"]
    assert len(calls) == 4


async def test_restart_marks_interrupted_without_dispatch(box: Any) -> None:
    svc, uid, calls = box
    owner = (uid, "dialogue")
    data = await svc.create(owner, key(), "问题", ["a"])
    await finish(svc, uid, data["id"])
    stored = svc.repo.get(owner, data["id"])
    stored["groups"][0]["answers"][0]["status"] = "running"
    svc.repo.save(owner, stored)
    recovered = await svc.get(owner, data["id"])
    assert recovered["groups"][0]["answers"][0]["status"] == "interrupted"
    assert len(calls) == 1


async def test_partial_failure_and_reconnect_do_not_repeat_calls(box: Any) -> None:
    svc, uid, calls = box
    old = svc.client

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("models"):
            return httpx.Response(200, json={"models": MODELS})
        body = json.loads(request.content)
        calls.append(body)
        if body["model"] == "b":
            return httpx.Response(429, json={"code": "CONCURRENCY_LIMIT"})
        return httpx.Response(
            200, text=event({"type": "delta", "text": "成功"}) + event({"type": "done"})
        )

    svc.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await old.aclose()
    data = await svc.create((uid, "dialogue"), key(), "问题", ["a", "b"])
    data = await finish(svc, uid, data["id"])
    assert [a["status"] for a in data["groups"][0]["answers"]] == ["completed", "failed"]
    for _ in range(2):
        snapshots = [event async for event in svc.events((uid, "dialogue"), data["id"])]
        assert len(snapshots) == 1
    assert len(calls) == 2


async def test_stop_cancels_one_model_without_cancelling_sibling(box: Any) -> None:
    svc, uid, _ = box
    entered = asyncio.Event()

    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            entered.set()
            yield event({"type": "delta", "text": "部分回答"}).encode()
            await asyncio.sleep(60)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("models"):
            return httpx.Response(200, json={"models": MODELS})
        if json.loads(request.content)["model"] == "a":
            return httpx.Response(200, stream=SlowStream())
        return httpx.Response(
            200, text=event({"type": "delta", "text": "B完成"}) + event({"type": "done"})
        )

    await svc.client.aclose()
    svc.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    data = await svc.create((uid, "dialogue"), key(), "问题", ["a", "b"])
    await entered.wait()
    answer = data["groups"][0]["answers"][0]
    await svc.stop((uid, "dialogue"), data["id"], answer["id"])
    result = await finish(svc, uid, data["id"])
    assert [a["status"] for a in result["groups"][0]["answers"]] == ["stopped", "completed"]
    assert result["groups"][0]["answers"][0]["text"] == "部分回答"


def test_ledger_atomic_budget_idempotency_and_pending_restart(tmp_path: Path) -> None:
    path = tmp_path / "ledger.sqlite"
    ledger = Ledger(path)

    def reserve(i: int) -> str:
        try:
            ledger.reserve(
                account="a",
                request_id=str(i),
                fingerprint="hash",
                model="a",
                amount=80,
                budget=100,
                total_budget=1000,
                concurrency=3,
                total_concurrency=12,
            )
            return "ok"
        except DialogueError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(reserve, range(8)))
    assert results.count("ok") == 1
    assert ledger.quota("a", 100)["remaining"] == 20
    restarted = Ledger(path)
    assert restarted.quota("a", 100)["pending"] == 1
    winner = str(results.index("ok"))
    assert reserve(int(winner)) == "REQUEST_ALREADY_ACCEPTED"
    restarted.reconcile("a", winner, 20)
    assert restarted.quota("a", 100)["remaining"] == 80


@pytest.fixture
async def gateway(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[tuple[httpx.AsyncClient, GatewayService, list[dict[str, Any]]]]:
    monkeypatch.setenv("TEST_ACCOUNT_TOKEN", "a" * 40)
    monkeypatch.setenv("TEST_RELAY_KEY", "upstream-secret")
    config = GatewayConfig.model_validate(
        {
            "total_budget": 1000000,
            "accounts": [
                {
                    "id": "alice",
                    "token_env": "TEST_ACCOUNT_TOKEN",
                    "region": "TEST",
                    "models": ["model-a"],
                    "budget": 100000,
                }
            ],
            "models": [
                {
                    "id": "model-a",
                    "name": "Model A",
                    "provider": "test-relay",
                    "upstream_model": "pinned-model",
                    "base_url": "https://relay.test/v1",
                    "key_env": "TEST_RELAY_KEY",
                    "verified": True,
                    "regions": ["TEST"],
                }
            ],
        }
    )
    calls = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        assert request.headers["authorization"] == "Bearer upstream-secret"
        return httpx.Response(
            200,
            text=event({"choices": [{"delta": {"content": "hello"}, "finish_reason": None}]})
            + event(
                {
                    "choices": [{"delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 10},
                }
            )
            + "data: [DONE]\n\n",
        )

    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = GatewayService(config, Ledger(tmp_path / "platform.sqlite"), upstream)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=build_gateway(service)),
        base_url="https://platform.test",
        headers={"authorization": "Bearer " + "a" * 40},
    ) as client:
        yield client, service, calls
    await upstream.aclose()


async def test_gateway_catalog_dispatch_usage_and_replay(gateway: Any) -> None:
    client, service, calls = gateway
    response = await client.get("/v1/models")
    assert response.status_code == 200
    assert (
        "upstream-secret" not in response.text
        and "base_url" not in response.text
        and "key_env" not in response.text
    )
    body = {
        "request_id": key(),
        "model": "model-a",
        "messages": [{"role": "user", "content": "hello"}],
    }
    response = await client.post("/v1/generate", json=body)
    assert response.status_code == 200 and '"type": "done"' in response.text
    assert calls[0]["model"] == "pinned-model" and "tools" not in calls[0]
    assert (await client.get("/v1/quota")).json()["spent"] == 40
    assert (await client.post("/v1/generate", json=body)).status_code == 409
    assert len(calls) == 1
    assert (
        await client.post("/v1/generate", json={**body, "request_id": key(), "tools": [{}]})
    ).status_code == 422
    assert (
        await client.post("/v1/generate", json={**body, "request_id": key(), "model": "forged"})
    ).status_code == 403
    assert (
        await client.get("/v1/quota", headers={"authorization": "Bearer forged"})
    ).status_code == 401
    service.config.accounts[0].region = "UNSUPPORTED"
    assert (await client.get("/v1/models")).json() == {"models": []}


async def test_gateway_missing_usage_is_held_not_free(gateway: Any) -> None:
    client, service, _ = gateway
    await service.client.aclose()
    service.client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                text=event(
                    {"choices": [{"delta": {"content": "answer"}, "finish_reason": "stop"}]}
                ),
            )
        )
    )
    body = {
        "request_id": key(),
        "model": "model-a",
        "messages": [{"role": "user", "content": "question"}],
    }
    response = await client.post("/v1/generate", json=body)
    assert '"accounting": "pending"' in response.text
    quota = (await client.get("/v1/quota")).json()
    assert quota["pending"] == 1 and quota["held"] > 0 and quota["spent"] == 0
    await service.client.aclose()


async def test_gateway_rejects_tools_and_does_not_leak_upstream_errors(gateway: Any) -> None:
    client, service, _ = gateway
    await service.client.aclose()

    service.client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                text=event(
                    {"choices": [{"delta": {"tool_calls": [{"function": {"name": "shell"}}]}}]}
                ),
            )
        )
    )
    response = await client.post(
        "/v1/generate",
        json={
            "request_id": key(),
            "model": "model-a",
            "messages": [{"role": "user", "content": "run something"}],
        },
    )
    assert "TOOLS_DISABLED" in response.text and "shell" not in response.text
    assert (await client.get("/v1/quota")).json()["pending"] == 1
    await service.client.aclose()


async def test_gateway_cancel_holds_reservation(gateway: Any) -> None:
    _client, service, _calls = gateway
    body = Generation(
        request_id=key(), model="model-a", messages=[{"role": "user", "content": "question"}]
    )
    stream = await service.prepare(service.config.accounts[0], body)
    assert (await anext(stream))["type"] == "delta"
    await stream.aclose()
    quota = await service.quota(service.config.accounts[0])
    assert quota["active"] == 0 and quota["pending"] == 1 and quota["held"] > 0


async def test_anthropic_route_usage_and_oversized_usage_pending(gateway: Any) -> None:
    client, service, _calls = gateway
    await service.client.aclose()
    service.config.models[0].protocol = "anthropic"

    def upstream(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/messages"
        assert request.headers["x-api-key"] == "upstream-secret"
        assert "tools" not in json.loads(request.content)
        events = [
            {
                "type": "message_start",
                "message": {"usage": {"input_tokens": 20, "cache_read_input_tokens": 5}},
            },
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "answer"}},
            {"type": "message_delta", "usage": {"output_tokens": 10}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, text="".join(event(e) for e in events))

    service.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    response = await client.post(
        "/v1/generate",
        json={
            "request_id": key(),
            "model": "model-a",
            "messages": [{"role": "user", "content": "question"}],
        },
    )
    assert '"type": "done"' in response.text
    assert (await client.get("/v1/quota")).json()["spent"] == 35
    await service.client.aclose()


def test_global_budget_and_usage_anomaly_remain_bounded(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.sqlite")
    common = {
        "fingerprint": "same",
        "model": "m",
        "amount": 60,
        "budget": 1000,
        "total_budget": 100,
        "concurrency": 3,
        "total_concurrency": 3,
    }
    ledger.reserve(account="a", request_id="one", **common)
    with pytest.raises(DialogueError, match="QUOTA_EXHAUSTED"):
        ledger.reserve(account="b", request_id="two", **common)
    assert ledger.settle("a", "one", charge=100000) == "pending"
    assert ledger.quota("a", 1000)["held"] == 60


async def test_wanx_pool_catalog_stream_branch_and_idempotency(box: Any, monkeypatch: Any) -> None:
    from langchain_core.messages import AIMessageChunk

    svc, uid, gateway_calls = box
    svc.services.settings_repo.delete(f"dialogue.provider:dialogue:{uid}")
    pid = svc.services.provider_repo.create(
        name="Existing WANX relay",
        kind="openai",
        api_key="private-provider-key",
        base_url="https://relay.test/v1",
        models_json=json.dumps(
            [
                {"id": "model/a", "name": "A"},
                {"id": "model/b", "name": "B"},
                {"id": "off", "enabled": False},
                {"id": "embedding", "embedding": True},
            ]
        ),
    )
    calls = []

    class FakeModel:
        max_retries = 2

        def __init__(self, provider: Any, model: Any) -> None:
            self.provider, self.model = provider, model

        async def astream(self, messages: Any, **kwargs: Any) -> AsyncIterator[Any]:
            assert self.max_retries == 0 and not self.model.native_tool_search
            assert "tools" not in kwargs and kwargs["max_tokens"] > 0
            calls.append((self.model.id, [(m.type, m.content) for m in messages]))
            yield AIMessageChunk(content=self.model.name + " answer")
            yield AIMessageChunk(
                content="",
                response_metadata={"finish_reason": "stop"},
                usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            )

    monkeypatch.setattr("octop.infra.dialogue.pool.build_chat_model", FakeModel)
    models = await svc.models((uid, "dialogue"))
    assert [m["name"] for m in models] == ["A", "B"]
    assert "private-provider-key" not in json.dumps(models)
    assert "relay.test" not in json.dumps(models)
    assert all(m["source"] == "wanx_pool" for m in models)
    q = await svc.remote((uid, "dialogue"), "/quota")
    assert q["remaining"] is None and q["billing"] == "provider_managed"
    rid = key()
    mids = [m["id"] for m in models]
    created = await svc.create((uid, "dialogue"), rid, "question", mids)
    result = await finish(svc, uid, created["id"])
    assert len(calls) == 2 and calls[0][1] == calls[1][1]
    assert not gateway_calls
    assert all(a["status"] == "completed" for a in result["groups"][0]["answers"])
    await svc.create((uid, "dialogue"), rid, "question", mids)
    assert len(calls) == 2
    a = result["groups"][0]["answers"][1]
    await svc.mutate(
        (uid, "dialogue"),
        created["id"],
        key(),
        "continue",
        {"answer_id": a["id"], "prompt": "follow up"},
    )
    result = await finish(svc, uid, created["id"])
    assert calls[-1][0] == "model/b"
    assert calls[-1][1][-2:] == [("ai", "B answer"), ("human", "follow up")]
    assert all(content != "A answer" for _, content in calls[-1][1])
    svc.services.provider_repo.update(pid, enabled=False)
    assert await svc.models((uid, "dialogue")) == []
    with pytest.raises(DialogueError, match="MODEL_UNAVAILABLE"):
        await svc.create((uid, "dialogue"), key(), "question", mids)


async def test_bound_gateway_failure_never_falls_back_to_native_pool(box: Any) -> None:
    svc, uid, _ = box
    svc.services.provider_repo.create(
        name="native",
        kind="openai",
        api_key="secret",
        base_url="https://relay.test/v1",
        models_json='[{"id":"native"}]',
    )
    svc.services.settings_repo.set(f"dialogue.provider:dialogue:{uid}", "999999")
    with pytest.raises(DialogueError, match="GATEWAY_NOT_CONFIGURED"):
        await svc.models((uid, "dialogue"))


async def test_wanx_pool_stop_releases_slot_and_does_not_run_tools(
    box: Any, monkeypatch: Any
) -> None:
    from langchain_core.messages import AIMessageChunk

    svc, uid, _ = box
    svc.services.settings_repo.delete(f"dialogue.provider:dialogue:{uid}")
    svc.services.provider_repo.create(
        name="native",
        kind="openai",
        api_key="secret",
        base_url="https://relay.test/v1",
        models_json='[{"id":"native"}]',
    )
    entered = asyncio.Event()

    class WaitingModel:
        max_retries = 2

        async def astream(self, messages: Any, **kwargs: Any) -> AsyncIterator[Any]:
            entered.set()
            yield AIMessageChunk(content="partial")
            await asyncio.Event().wait()

    monkeypatch.setattr("octop.infra.dialogue.pool.build_chat_model", lambda *args: WaitingModel())
    mid = (await svc.models((uid, "dialogue")))[0]["id"]
    created = await svc.create((uid, "dialogue"), key(), "question", [mid])
    await asyncio.wait_for(entered.wait(), 2)
    result = await svc.stop(
        (uid, "dialogue"), created["id"], created["groups"][0]["answers"][0]["id"]
    )
    assert result["groups"][0]["answers"][0]["status"] == "stopped"
    assert not svc.pool.running

    class ToolModel:
        max_retries = 2

        async def astream(self, messages: Any, **kwargs: Any) -> AsyncIterator[Any]:
            yield AIMessageChunk(
                content="",
                tool_call_chunks=[{"name": "shell", "args": "{}", "id": "x", "index": 0}],
            )

    monkeypatch.setattr("octop.infra.dialogue.pool.build_chat_model", lambda *args: ToolModel())
    created = await svc.create((uid, "dialogue"), key(), "question", [mid])
    result = await finish(svc, uid, created["id"])
    assert result["groups"][0]["answers"][0]["error"] == "TOOLS_DISABLED"
    assert not svc.pool.running
