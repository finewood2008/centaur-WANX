"""Owned local source reads and the real native capture/recall attachment path."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from octop_gateway.models import TextContent
from octop_harness.middleware.memory import MemoryMiddleware
from octop_memory import MemoryService

from octop.api.common.memory_client import _open_memory_for_agent
from octop.api.deps import resolve_user_from_token
from octop.api.routers.chat.models import ChatTurnBody
from octop.api.routers.chat.turn import prepare_dashboard_turn
from octop.infra.agents.attachment_sources import (
    SOURCE_TEXT_LIMIT,
    build_attachment_tools,
)
from octop.infra.agents.memory.zhijun_recall import build_recall_tool
from octop.infra.agents.middleware.zhijun import ZhijunMemoryBoundary
from octop.infra.errors import OctopError
from octop.infra.gateway.process.message_keys import INBOUND_ATTACHMENTS_KEY
from tests.integration.test_zhijun_profile import zhijun_auth
from tests.support.auth import TEST_PASSWORD, create_user
from tests.support.http import chat_ws_path, ws_connect


async def _profile(client: Any) -> tuple[dict[str, str], str]:
    auth = await zhijun_auth(client)
    response = await client.post("/api/zhijun/profile", headers=auth)
    assert response.status_code == 200, response.text
    return auth, response.json()["profile"]["agent_id"]


async def _upload(
    client: Any,
    aid: str,
    auth: dict[str, str],
    content: bytes,
    *,
    filename: str = "合成会议笔记.txt",
    media_type: str = "text/plain",
) -> dict[str, Any]:
    response = await client.post(
        f"/api/agents/{aid}/upload",
        headers=auth,
        files={"file": (filename, content, media_type)},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _turn(source: dict[str, Any], *, text: str = "请一起看这份合成资料") -> dict[str, Any]:
    return {
        "type": "user_turn",
        "text": text,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": text},
                    {
                        "type": "file",
                        "workspace_path": source["workspace_path"],
                        "filename": source["filename"],
                        "media_type": source["media_type"],
                    },
                ],
            }
        ],
    }


async def test_upload_source_pages_are_bounded_owned_and_application_scoped(
    env_with_provider: Any,
) -> None:
    client, server, wanx_auth = env_with_provider
    auth, aid = await _profile(client)
    body = "synthetic-source-" * 4000
    source = await _upload(client, aid, auth, body.encode())
    assert source["extraction_status"] == "ready"
    assert source["extraction_truncated"] is True
    assert source["extraction_characters"] == len(body)
    assert "/upload/source?path=" in source["access_url"]
    preview = await client.get(source["access_url"], headers=auth)
    assert preview.status_code == 200, preview.text
    assert preview.json()["content"] == body[:12000]
    assert preview.json()["stored_chars"] == SOURCE_TEXT_LIMIT
    assert preview.json()["has_more"] is True
    last = await client.get(
        f"/api/agents/{aid}/upload/source",
        headers=auth,
        params={"path": source["path"], "offset": 36000},
    )
    assert last.json()["content"] == body[36000:48000]
    assert last.json()["has_more"] is False
    assert last.json()["truncated"] is True
    assert (await client.get(source["access_url"], headers=wanx_auth)).status_code == 404
    for route in ("workspace/download", "media/preview"):
        assert (
            await client.get(
                f"/api/agents/{aid}/{route}",
                headers=auth,
                params={"path": source["path"], "source": source["path"]},
            )
        ).status_code == 404
    assert (
        await client.get(
            f"/api/agents/{aid}/upload/source",
            headers=auth,
            params={"path": source["path"], "limit": 12001},
        )
    ).status_code == 422

    await create_user(client, wanx_auth, username="attachment-owner")
    login = await client.post(
        "/api/auth/login",
        json={
            "username": "attachment-owner",
            "password": TEST_PASSWORD,
            "application_id": "zhijun",
        },
    )
    other_auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    other_aid = (await client.post("/api/zhijun/profile", headers=other_auth)).json()["profile"][
        "agent_id"
    ]
    assert (await client.get(source["access_url"], headers=other_auth)).status_code in {403, 404}
    assert (
        await client.get(
            f"/api/agents/{other_aid}/upload/source",
            headers=other_auth,
            params={"path": source["path"]},
        )
    ).status_code == 404
    # A normal local inbound file without a server extraction record is not a source.
    workspace = server.app_runtime.agent_registry.get_agent(aid).workspace
    unregistered = "inbound/1750000000_unregistered.txt"
    await workspace.aupload_bytes(unregistered, b"not an uploaded source")
    assert (
        await client.get(
            f"/api/agents/{aid}/upload/source", headers=auth, params={"path": unregistered}
        )
    ).status_code == 404


async def test_attachment_paths_reject_urls_host_files_and_rules_before_thread_creation(
    env_with_provider: Any,
) -> None:
    client, server, _wanx_auth = env_with_provider
    auth, aid = await _profile(client)
    user = resolve_user_from_token(server, auth["Authorization"].split(" ", 1)[1])
    invalid = [
        "SOUL.md",
        "../SOUL.md",
        "/inbound/1750000000_a.txt",
        "inbound/../SOUL.md",
        "inbound/.zhijun-sources/1750000000_a.txt.json",
        "https://example.invalid/file.txt",
        "file:///private/tmp/file.txt",
        "inbound/1750000000_missing.txt",
        "",
        "C:\\secret.txt",
    ]
    for path in invalid:
        source = {"workspace_path": path, "filename": "a.txt", "media_type": "text/plain"}
        with pytest.raises(OctopError):
            await prepare_dashboard_turn(
                server, agent_id=aid, user=user, turn=ChatTurnBody.model_validate(_turn(source))
            )
        response = await client.get(
            f"/api/agents/{aid}/upload/source", headers=auth, params={"path": path}
        )
        assert response.status_code == 404
    assert (await client.get(f"/api/agents/{aid}/threads", headers=auth)).json() == []
    async with ws_connect(client._octop_app, chat_ws_path(aid, auth)) as ws:
        await ws.send_json(
            {
                "type": "user_turn",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": "https://example.invalid/image.png"},
                            },
                        ],
                    }
                ],
            }
        )
        frame = await ws.receive_json()
        assert frame["type"] == "error"
    assert (await client.get(f"/api/agents/{aid}/threads", headers=auth)).json() == []


async def test_local_extraction_failure_empty_and_ocr_unavailable_are_truthful(
    env_with_provider: Any,
    monkeypatch: Any,
) -> None:
    client, server, _wanx_auth = env_with_provider
    auth, aid = await _profile(client)
    # The shared WANX remote OCR setting must not be called by Zhijun.
    server.services.settings_repo.set("knowledge_ocr_enabled", "true")
    server.services.settings_repo.set("knowledge_ocr_backend", "remote")
    monkeypatch.setattr(
        "octop.infra.agents.attachment_sources.local_ocr_deps_available", lambda: False
    )
    extractor = MagicMock(side_effect=AssertionError("remote OCR must not be invoked"))
    monkeypatch.setattr("octop.infra.agents.attachment_sources.require_ocr_extractor", extractor)
    cases = [
        ("empty.txt", "text/plain", b"  \n", "empty"),
        ("unknown.bin", "application/octet-stream", b"synthetic", "unsupported"),
        ("broken.pdf", "application/pdf", b"synthetic malformed pdf", "failed"),
        ("scan.png", "image/png", b"synthetic image", "unsupported"),
    ]
    for filename, media_type, body, status in cases:
        source = await _upload(client, aid, auth, body, filename=filename, media_type=media_type)
        assert source["extraction_status"] == status
        assert source["extraction_error"]
        response = await client.get(source["access_url"], headers=auth)
        assert response.json()["ok"] is False
        assert response.json()["content"] == ""
        assert response.json()["error"]
        assert await server.app_runtime.agent_registry.get_agent(aid).workspace.aexists(
            source["path"]
        )
    extractor.assert_not_called()

    # Native image transport metadata survives, but no image bytes/URLs reach
    # the model when local OCR is unavailable.
    user = resolve_user_from_token(server, auth["Authorization"].split(" ", 1)[1])
    turn = _turn(source)
    turn["messages"][0]["content"][1]["type"] = "image"
    prepared = await prepare_dashboard_turn(
        server, agent_id=aid, user=user, turn=ChatTurnBody.model_validate(turn)
    )
    assert all(isinstance(part, TextContent) for part in prepared.inbound_content)
    assert "本地文字识别尚未就绪" in prepared.inbound_content[0].text
    assert prepared.inbound_attachments[0]["workspace_path"] == source["path"]


async def test_turn_read_limit_and_attachment_count_are_explicit(env_with_provider: Any) -> None:
    client, server, _wanx_auth = env_with_provider
    auth, aid = await _profile(client)
    user = resolve_user_from_token(server, auth["Authorization"].split(" ", 1)[1])
    source = await _upload(client, aid, auth, b"Synthetic bounded contents. " * 2000)
    turn = _turn(source)
    prepared = await prepare_dashboard_turn(
        server, agent_id=aid, user=user, turn=ChatTurnBody.model_validate(turn)
    )
    content = prepared.inbound_content[0].text
    assert f"仅读取 12000 / {source['extraction_characters']} 个字符" in content
    assert content.count("Synthetic bounded contents.") < 2000
    block = turn["messages"][0]["content"][1]
    turn["messages"][0]["content"] = [block] * 9
    with pytest.raises(OctopError, match="每次最多附上 8 份资料"):
        await prepare_dashboard_turn(
            server, agent_id=aid, user=user, turn=ChatTurnBody.model_validate(turn)
        )


async def test_uploaded_text_reaches_native_raw_and_new_session_memory_tools(
    env_with_provider: Any,
    monkeypatch: Any,
) -> None:
    client, server, _wanx_auth = env_with_provider
    auth, aid = await _profile(client)
    source = await _upload(
        client,
        aid,
        auth,
        b"SyntheticEvidenceBeacon: the launch was postponed until 2030-04-12 because the test bench was unavailable.",
    )
    memory, _bridge = _open_memory_for_agent(server, aid)
    service = MemoryService(memory)
    native = MemoryMiddleware(service=service, jsonl_enabled=False, recall_inject_enabled=False)
    captured = asyncio.Event()
    agent = server.app_runtime.agent_registry.get_agent(aid)
    request_seen: dict[str, Any] = {}

    async def capture_stream(request: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        request_seen.update(request)
        human = request["messages"][-1]
        assert isinstance(human, HumanMessage)
        assert "SyntheticEvidenceBeacon" in human.content
        assert source["path"] in human.content
        assert (
            human.additional_kwargs[INBOUND_ATTACHMENTS_KEY][0]["workspace_path"] == source["path"]
        )
        runtime = SimpleNamespace(
            config={
                "configurable": {
                    "thread_id": request["thread_id"],
                    "session_id": request["thread_id"],
                    "user": "1",
                }
            }
        )
        native.before_model({"messages": [human]}, runtime)
        native.after_model(
            {"messages": [human, AIMessage(content="资料说明测试台不可用，因此推迟了发布。")]},
            runtime,
        )
        for _ in range(100):
            if memory.list_raw(session_id=request["thread_id"], event_type="user_message"):
                captured.set()
                break
            await asyncio.sleep(0.01)
        yield {"type": "token", "node": "agent", "content": "合成资料已读取。"}
        yield {"type": "state_snapshot", "data": {}}

    agent.stream = capture_stream
    async with ws_connect(client._octop_app, chat_ws_path(aid, auth)) as ws:
        await ws.send_json(_turn(source))
        frames = await ws.drain_turn()
        assert frames[-1]["type"] == "done", frames
    await asyncio.wait_for(captured.wait(), timeout=2)
    raw = memory.list_raw(session_id=request_seen["thread_id"], event_type="user_message")
    assert len(raw) == 1
    assert "SyntheticEvidenceBeacon" in raw[0].content
    assert "2030-04-12" in raw[0].content
    assert source["path"] in raw[0].content
    # A different conversation can recall and inspect the actual raw evidence.
    recall = service.recall("SyntheticEvidenceBeacon", session_id="different-session")
    assert "2030-04-12" in recall.rendered
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {
                "agent_id": aid,
                "user": "1",
                "source": "web",
                "thread_id": "different-session",
            }
        },
    )
    boundary = ZhijunMemoryBoundary(aid, 1, lambda: service)
    recall_tool = build_recall_tool(None, lambda: service, lambda: memory, agent_id=aid, user_id=1)

    async def invoke_recall(request):
        return ToolMessage(
            content=await recall_tool.ainvoke(request.tool_call["args"]),
            tool_call_id=request.tool_call["id"],
        )

    handler = AsyncMock(side_effect=invoke_recall)
    search = await boundary.awrap_tool_call(
        SimpleNamespace(
            tool_call={
                "name": "zhijun_memory_recall",
                "id": "search",
                "args": {"query": "SyntheticEvidenceBeacon"},
            }
        ),
        handler,
    )
    hits = json.loads(search.content)["hits"]
    assert hits
    detail = await boundary.awrap_tool_call(
        SimpleNamespace(
            tool_call={
                "name": "zhijun_memory_recall",
                "id": "detail",
                "args": {"action": "get", "path": hits[0]["path"]},
            }
        ),
        handler,
    )
    assert json.loads(detail.content)["ok"] is True
    assert "2030-04-12" in json.loads(detail.content)["excerpt"]
    assert json.loads(detail.content)["statement_kind"] == "source_quote"
    assert json.loads(detail.content)["confirmation"] == "unconfirmed"
    assert handler.await_count == 2


async def test_attachment_tool_is_owner_scoped_and_boundary_preserves_error_domain(
    env_with_provider: Any,
    monkeypatch: Any,
) -> None:
    client, server, _wanx_auth = env_with_provider
    auth, aid = await _profile(client)
    source = await _upload(client, aid, auth, b"synthetic own attachment contents")
    tool = build_attachment_tools(
        lambda: server.app_runtime.agent_registry.get_agent(aid).workspace, agent_id=aid, user_id=1
    )[0]
    config = {"agent_id": aid, "user": "1", "source": "web"}
    monkeypatch.setattr("langgraph.config.get_config", lambda: {"configurable": config})
    result = json.loads(await tool.ainvoke({"path": source["path"], "offset": 10, "limit": 5}))
    assert result["content"] == "synthetic own attachment contents"[10:15]
    assert result["ok"] is True
    with pytest.raises(OctopError):
        await tool.ainvoke({"path": "AGENTS.md"})
    config["user"] = "2"
    with pytest.raises(OctopError):
        await tool.ainvoke({"path": source["path"]})
    config["user"] = "1"
    boundary = ZhijunMemoryBoundary(aid, 1, lambda: None)
    for name, expected in [
        ("search_knowledge", "knowledge_unavailable"),
        ("zhijun_attachment_get", "attachment_unavailable"),
    ]:
        result = await boundary.awrap_tool_call(
            SimpleNamespace(tool_call={"name": name, "id": "failed"}),
            AsyncMock(side_effect=OSError("synthetic failure")),
        )
        assert result.status == "error"
        assert json.loads(result.content)["error"] == expected
    denied = AsyncMock()
    for name in ("read_file", "write_file", "execute", "ask_agent"):
        result = await boundary.awrap_tool_call(
            SimpleNamespace(tool_call={"name": name, "id": "old-call"}), denied
        )
        assert result.status == "error"
    denied.assert_not_awaited()
