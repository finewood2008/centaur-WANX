"""Blank profile ownership and actual runtime memory boundaries."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import ToolMessage
from octop_harness.config import HarnessAgentConfig
from octop_harness.registry import AgentEntry, AgentRegistry
from octop_harness.request import ChatRequest
from octop_memory import Memory
from octop_memory.types import Episode

from octop.config import OctopConfig
from octop.infra.agents.manager import AgentManager
from octop.infra.agents.memory.zhijun_tools import build_episode_tools
from octop.infra.agents.middleware.zhijun import ZhijunMemoryBoundary
from octop.infra.agents.runtime_manager import ApplicationHarnessManager, ApplicationTeamManager
from octop.infra.agents.zhijun import (
    CONVERSATION_RULES,
    MATERIAL_RULES,
    PROFILE_READY,
    RULES_DIR,
    ensure_profile_initialized,
    get_or_create_profile,
    get_profile,
)
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.process.processor import GlobalProcessor
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def manager(tmp_path: Path) -> AgentManager:
    paths = PathLayout(tmp_path / "home")
    db = SqlitePool(paths.db)
    run_migrations(db)
    services = build_shared_services(db=db, paths=paths, config=OctopConfig())
    services.user_repo.create(username="synthetic", role="admin")
    return AgentManager(repos=services.repos, paths=paths, config=OctopConfig())


@pytest.mark.asyncio
async def test_blank_profile_and_idempotent_parallel_creation(manager: AgentManager) -> None:
    # An existing WANX companion with the same display name remains separate.
    manager._repos.agent_repo.create(agent_id="oldwanx", user_id=1, name="知君")
    await manager.boot()  # No providers: the durable blank profile must still survive.
    try:
        assert get_profile(manager, 1) is None
        profiles = await asyncio.gather(*(get_or_create_profile(manager, 1) for _ in range(3)))
        row = get_profile(manager, 1)
        assert row is not None
        assert {p.agent_id for p in profiles} == {row.agent_id}
        assert row.application_id == "zhijun"
        assert row.agent_id != "oldwanx"
        assert row.last_state == "failed"
        assert not manager._repos.proactive_care_config_repo.get(row.agent_id).enabled
        workspace = manager.workspace_for_agent(row.agent_id)
        assert await workspace.aread_text("USER.md") == ""
        assert await workspace.aread_text("MEMORY.md") == ""
        assert workspace.exists(".bootstrapped")
        assert not workspace.exists("BOOTSTRAP.md")
        assert not workspace.exists("_builtin_skills")
        assert manager._repos.thread_repo.list_by_agent(agent_id=row.agent_id) == []
        with pytest.raises(sqlite3.IntegrityError):
            manager._repos.agent_repo.create(
                agent_id="duplicate", user_id=1, name="another", application_id="zhijun"
            )
        assert manager._repos.agent_repo.get("oldwanx").application_id == "wanx"
        assert (await get_or_create_profile(manager, 1)).agent_id == row.agent_id
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_storage_and_capabilities_cannot_be_reconfigured(manager: AgentManager) -> None:
    await manager.boot()
    try:
        row = await get_or_create_profile(manager, 1)
        for change in (
            {"application_id": "wanx"},
            {"config_json": json.dumps({"backend": {"type": "local_shell"}})},
            {"config_json": json.dumps({"memory": {"backend": {"db_path": "other.sqlite"}}})},
            {"knowledge_base_ids": '["other"]'},
            {"mcp_servers": '["other"]'},
        ):
            with pytest.raises(OctopError) as err:
                await manager.update(row.agent_id, **change)
            assert err.value.code == ErrorCode.FORBIDDEN
        with pytest.raises(OctopError):
            await manager.update_config_json(row.agent_id, '{"backend": "state"}')
        cfg = manager._build_harness_config(row)
        assert not cfg.memory_recall_inject_enabled
        assert not cfg.team_enabled
        assert not cfg.bootstrap_enabled
        assert not cfg.subagents_auto_load
        assert cfg.memory == (
            "AGENTS.md",
            "SOUL.md",
            "ZHIJUN_MATERIALS.md",
            "ZHIJUN_CONVERSATION.md",
        )
        assert cfg.mcp_server_configs == {}
        assert cfg.acp_runners == {}
        assert {tool.name for tool in cfg.tools} == {
            "zhijun_memory_recall",
            "zhijun_attachment_get",
            "search_knowledge",
            "zhijun_response_options",
            "zhijun_ontology_update",
            "zhijun_context_update",
            "zhijun_knowledge_get",
            "zhijun_understanding_review",
        }
        assert manager.default_knowledge_base_ids(row.agent_id) == []
        assert manager.default_mcp_servers(row.agent_id) == []
        assert manager.resolve_user_agent(1, row.agent_id) is None
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_partial_seed_retry_keeps_identity_and_personal_markdown(
    manager, monkeypatch
) -> None:
    await manager.boot()
    original = manager._backend_workspace_for_row
    fail_first = True

    def workspace_for(row, **kwargs):
        workspace = original(row, **kwargs)
        upload = workspace.aupload_many

        async def partial_upload(pairs):
            nonlocal fail_first
            if fail_first:
                fail_first = False
                await upload(pairs[:1])
                raise OSError("synthetic partial upload")
            return await upload(pairs)

        workspace.aupload_many = partial_upload
        return workspace

    monkeypatch.setattr(manager, "_backend_workspace_for_row", workspace_for)
    try:
        row = await get_or_create_profile(manager, 1)
        assert row.last_state == "failed"
        workspace = manager.workspace_for_agent(row.agent_id)
        assert await workspace.aread_text(PROFILE_READY) is None
        await workspace.aupload_many(
            [("USER.md", b"synthetic person"), ("MEMORY.md", b"synthetic context")]
        )
        recovered = await get_or_create_profile(manager, 1)
        assert recovered.agent_id == row.agent_id
        assert await workspace.aread_text(PROFILE_READY) == "ready-v1\n"
        assert await workspace.aread_text("AGENTS.md") == (RULES_DIR / "AGENTS.md").read_text()
        assert await workspace.aread_text("SOUL.md") == (RULES_DIR / "SOUL.md").read_text()
        assert await workspace.aread_text("USER.md") == "synthetic person"
        assert await workspace.aread_text("MEMORY.md") == "synthetic context"
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_material_rules_upgrade_preserves_existing_personal_files(
    manager: AgentManager,
) -> None:
    agent_id = manager._repos.agent_repo.create(
        agent_id="existing", user_id=1, name="知君", application_id="zhijun"
    )
    row = manager._repos.agent_repo.get(agent_id)
    assert row is not None
    workspace = manager._backend_workspace_for_row(row)
    original = {
        PROFILE_READY: "ready-v1\n",
        "AGENTS.md": "existing owner rules",
        "SOUL.md": "existing companion voice",
        "USER.md": "synthetic personal context",
        "MEMORY.md": "synthetic existing memory",
    }
    await workspace.aupload_many([(name, text.encode()) for name, text in original.items()])
    await ensure_profile_initialized(row, workspace)
    for name, text in original.items():
        assert await workspace.aread_text(name) == text
    assert await workspace.aread_text(MATERIAL_RULES) == (RULES_DIR / MATERIAL_RULES).read_text()
    assert (
        await workspace.aread_text(CONVERSATION_RULES)
        == (RULES_DIR / CONVERSATION_RULES).read_text()
    )
    # Retry does not replace a rule the owner has subsequently edited on the host.
    await workspace.aupload_many(
        [
            (MATERIAL_RULES, b"owner material rules"),
            (CONVERSATION_RULES, b"owner conversation rules"),
        ]
    )
    await ensure_profile_initialized(row, workspace)
    assert await workspace.aread_text(MATERIAL_RULES) == "owner material rules"
    assert await workspace.aread_text(CONVERSATION_RULES) == "owner conversation rules"


@pytest.mark.asyncio
async def test_gateway_uses_own_knowledge_domain_and_keeps_mcp_disabled(
    manager: AgentManager,
) -> None:
    manager._repos.agent_repo.create(
        agent_id="zhijun", user_id=1, name="知君", application_id="zhijun"
    )
    processor = object.__new__(GlobalProcessor)
    processor._agent_manager = manager
    processor._knowledge_services = MagicMock()
    processor._knowledge_services.knowledge_repo.list_visible.return_value = [
        SimpleNamespace(
            id="OWNKB1", owner_user_id=1, default_open=True, name="本人的资料", description=""
        ),
    ]
    request: dict = {}
    processor._attach_turn_knowledge_config(
        request, user_id=1, is_admin=True, explicit_ids=None, locale="zh", agent_id="zhijun"
    )
    processor._knowledge_services.knowledge_repo.list_all.assert_not_called()
    processor._knowledge_services.knowledge_repo.list_visible.assert_called_once_with(
        1, application_id="zhijun"
    )
    assert request["configurable"]["application_id"] == "zhijun"
    assert request["configurable"]["knowledge_base_ids"] == ["OWNKB1"]
    assert (
        await processor._resolve_turn_mcp_servers(
            agent_id="zhijun", user_id=1, explicit=None, apply_defaults=True
        )
        is None
    )


@pytest.mark.asyncio
async def test_old_tool_calls_cannot_bypass_the_single_recall_entry(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "profile", "user": "1", "source": "web"}},
    )
    service = MagicMock()
    service.search.return_value = {"hits": [{"path": "/atoms/one", "snippet": "合成资料"}]}
    boundary = ZhijunMemoryBoundary("profile", 1, lambda: service)
    handler = AsyncMock()
    request = SimpleNamespace(tool_call={"name": "execute_shell_command", "id": "call", "args": {}})
    result = await boundary.awrap_tool_call(request, handler)
    assert result.status == "error"
    handler.assert_not_awaited()
    for name in (
        "memory_search",
        "memory_get",
        "zhijun_episode_search",
        "zhijun_episode_get",
        "zhijun_ontology_read",
    ):
        request.tool_call = {"name": name, "id": "call", "args": {"query": "资料"}}
        result = await boundary.awrap_tool_call(request, handler)
        assert result.status == "error"
    service.search.assert_not_called()
    service.get.assert_not_called()
    handler.assert_not_awaited()
    request.tool_call = {"name": "zhijun_memory_recall", "id": "call", "args": {}}
    handler.return_value = ToolMessage(content='{"ok": true}', tool_call_id="call")
    result = await boundary.awrap_tool_call(request, handler)
    assert json.loads(result.content)["ok"] is True
    monkeypatch.setattr("langgraph.config.get_config", lambda: {"configurable": {"user": "2"}})
    result = await boundary.awrap_tool_call(request, handler)
    assert result.status == "error"


@pytest.mark.asyncio
async def test_episode_tools_are_native_owned_and_preserve_raw_sources(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "profile", "user": "1", "source": "web"}},
    )
    memory = Memory(
        namespace="synthetic", backend_config={"db_path": str(tmp_path / "memory.sqlite")}
    )
    try:
        now = datetime.now(UTC)
        raw = memory.add_raw("第一次作报告，我有些紧张。", event_type="conversation_turn")
        memory.add_episodes(
            [
                Episode(
                    id="episode",
                    raw_event_ids=[raw.id],
                    occurred_at=now,
                    summary="第一次作报告时紧张",
                    verbatim_quote=raw.content,
                    quote_event_id=raw.id,
                    emotion="anxious",
                    intensity=3,
                    people=[],
                    topics=["工作"],
                    extractor_version="synthetic",
                    created_at=now,
                )
            ]
        )
        tools = {
            t.name: t for t in build_episode_tools(lambda: memory, agent_id="profile", user_id=1)
        }
        search = json.loads(await tools["zhijun_episode_search"].ainvoke({"query": "报告"}))
        assert search["items"][0]["path"] == "/episodes/episode"
        detail = json.loads(await tools["zhijun_episode_get"].ainvoke({"episode_id": "episode"}))
        assert detail["sources"][0]["path"] == f"/raw_events/{raw.id}"
        assert detail["sources"][0]["content"] == raw.content
        monkeypatch.setattr("langgraph.config.get_config", lambda: {"configurable": {"user": "2"}})
        with pytest.raises(PermissionError):
            await tools["zhijun_episode_get"].ainvoke({"episode_id": "episode"})
    finally:
        memory.backend.close()


@pytest.mark.asyncio
async def test_direct_native_peer_dispatch_is_blocked_in_both_directions() -> None:
    registry = AgentRegistry()
    for app in ("wanx", "zhijun"):
        registry.add(
            AgentEntry(
                agent_id=app,
                agent=MagicMock(),
                config=HarnessAgentConfig(),
                metadata={"user_id": 1, "application_id": app},
                tags=[],
                created_at=datetime.now(UTC),
            )
        )
    team = ApplicationTeamManager(registry)
    assert team.list_peers(1, exclude_agent_id="zhijun") == []
    assert team.list_peers(1, exclude_agent_id="wanx") == []
    for source, target in (("wanx", "zhijun"), ("zhijun", "wanx")):
        with pytest.raises(ValueError, match="not found"):
            await team.call_peer(
                from_agent_id=source, to_agent_id=target, message="合成", user_id=1
            )
        registry.get(target).agent.call.assert_not_called()


@pytest.mark.asyncio
async def test_zhijun_never_inherits_shared_tracing_callbacks() -> None:
    manager = ApplicationHarnessManager()
    agent = MagicMock()
    manager._registry.add(
        AgentEntry(
            agent_id="profile",
            agent=agent,
            config=HarnessAgentConfig(),
            metadata={"user_id": 1, "application_id": "zhijun"},
            tags=[],
            created_at=datetime.now(UTC),
        )
    )
    manager._langfuse = MagicMock()
    request = ChatRequest(messages="合成对话", user="1", callbacks=[MagicMock()])
    result = await manager._enrich_request("profile", request)
    assert result.callbacks is None
    manager._langfuse.enrich_request.assert_not_called()
    manager._sync_langfuse_to_agents()
    agent.set_langfuse_callbacks.assert_called_with(None)


@pytest.mark.asyncio
async def test_episode_date_only_covers_entire_server_day(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "profile", "user": "1", "source": "web"}},
    )
    memory = Memory(
        namespace="synthetic", backend_config={"db_path": str(tmp_path / "memory.sqlite")}
    )
    try:
        dates = [
            "2026-09-30T23:59:59+08:00",
            "2026-10-01T00:00:00+08:00",
            "2026-10-01T23:59:59+08:00",
            "2026-10-02T00:00:00+08:00",
        ]
        for index, date in enumerate(dates):
            memory.add_episodes(
                [
                    Episode(
                        id=str(index),
                        raw_event_ids=[],
                        occurred_at=datetime.fromisoformat(date),
                        summary="合成经历",
                        verbatim_quote="",
                        quote_event_id="",
                        emotion="neutral",
                        intensity=1,
                        people=[],
                        topics=[],
                        extractor_version="synthetic",
                        created_at=datetime.now(UTC),
                    )
                ]
            )
        search = build_episode_tools(
            lambda: memory, agent_id="profile", user_id=1, time_zone="Asia/Shanghai"
        )[0]
        result = json.loads(
            await search.ainvoke({"date_from": "2026-10-01", "date_to": "2026-10-01"})
        )
        assert {row["id"] for row in result["items"]} == {"1", "2"}
        result = json.loads(
            await search.ainvoke(
                {"date_from": "2026-10-01T00:00:00", "date_to": "2026-10-02T00:00:00"}
            )
        )
        assert {row["id"] for row in result["items"]} == {"1", "2"}
    finally:
        memory.backend.close()
