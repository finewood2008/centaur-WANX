"""Zhijun knowledge selections survive runtime preparation without crossing domains."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain.agents.middleware import ModelRequest
from langchain_core.messages import ToolMessage
from langgraph.config import var_child_runnable_config

from octop.config import OctopConfig
from octop.infra.agents.manager import AgentManager
from octop.infra.agents.middleware.zhijun import ZhijunMemoryBoundary
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.process.processor import GlobalProcessor
from octop.infra.knowledge.hint import KnowledgeSearchHintMiddleware
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def context(tmp_path, monkeypatch):
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path))
    paths = PathLayout(tmp_path)
    pool = SqlitePool(paths.db)
    run_migrations(pool)
    config = OctopConfig()
    services = build_shared_services(db=pool, paths=paths, config=config)
    owner = services.user_repo.create(username="owner", role="admin")
    other = services.user_repo.create(username="other", role="user")
    manager = AgentManager(repos=services.repos, paths=paths, config=config)
    services.agent_repo.create(
        agent_id="profile", user_id=owner, name="知君", application_id="zhijun"
    )
    own = services.knowledge_repo.create_base(
        owner_user_id=owner, name="本人的合成资料", default_open=True, application_id="zhijun"
    )
    optional = services.knowledge_repo.create_base(
        owner_user_id=owner, name="可选的合成资料", application_id="zhijun"
    )
    wanx = services.knowledge_repo.create_base(
        owner_user_id=owner, name="万象合成资料", default_open=True, shared=True
    )
    others = services.knowledge_repo.create_base(
        owner_user_id=other, name="他人的合成资料", default_open=True, application_id="zhijun"
    )
    yield SimpleNamespace(
        manager=manager,
        services=services,
        owner=owner,
        own=own,
        optional=optional,
        wanx=wanx,
        others=others,
    )
    pool.close()


def _request(context, **configurable):
    return {
        "agent_id": "profile",
        "user": str(context.owner),
        "source": "web",
        "configurable": {
            "agent_id": "profile",
            "user": str(context.owner),
            "source": "web",
            "locale": "zh",
            **configurable,
        },
    }


@pytest.mark.asyncio
async def test_default_catalog_reaches_model_and_scoped_search(context, monkeypatch):
    processor = object.__new__(GlobalProcessor)
    processor._agent_manager = context.manager
    processor._knowledge_services = context.services
    request = _request(context)
    processor._attach_turn_knowledge_config(
        request,
        user_id=context.owner,
        is_admin=True,
        explicit_ids=None,
        locale="zh",
        agent_id="profile",
    )
    prepared = context.manager._prepare_stream_request("profile", request)
    row = context.manager.get_row("profile")
    harness_config = context.manager._build_harness_config(row)
    model_request = ModelRequest(model=MagicMock(), messages=[], tools=harness_config.tools)
    captured = []
    boundary = ZhijunMemoryBoundary("profile", context.owner, lambda: None)

    async def capture(req):
        captured.append(req)
        return object()

    async def restrict(req):
        return await boundary.awrap_model_call(req, capture)

    retrieved = AsyncMock(return_value="合成正文中的依据")
    monkeypatch.setattr("octop.infra.knowledge.tools.retrieve_context", retrieved)
    token = var_child_runnable_config.set({"configurable": prepared["configurable"]})
    try:
        await KnowledgeSearchHintMiddleware().awrap_model_call(model_request, restrict)
        tool = next(t for t in captured[0].tools if t.name == "search_knowledge")
        assert context.own.name in tool.description
        assert context.wanx.name not in tool.description
        assert context.others.name not in tool.description

        async def execute(req):
            return ToolMessage(
                content=await tool.ainvoke(req.tool_call["args"]), tool_call_id="search"
            )

        result = await boundary.awrap_tool_call(
            SimpleNamespace(
                tool_call={"name": "search_knowledge", "id": "search", "args": {"query": "依据"}}
            ),
            execute,
        )
    finally:
        var_child_runnable_config.reset(token)
    assert json.loads(result.content) == {"ok": True, "content": "合成正文中的依据", "empty": False}
    assert retrieved.await_args.kwargs["knowledge_base_ids"] == [context.own.id]
    assert retrieved.await_args.kwargs["application_id"] == "zhijun"
    assert retrieved.await_args.kwargs["user_id"] == context.owner
    assert retrieved.await_args.kwargs["is_admin"] is False


@pytest.mark.parametrize("selection", [{}, {"knowledge_base_ids": None}])
def test_omitted_selection_uses_only_owned_domain_defaults(context, selection):
    prepared = context.manager._prepare_stream_request("profile", _request(context, **selection))
    cfg = prepared["configurable"]
    assert cfg["knowledge_base_ids"] == [context.own.id]
    assert cfg["knowledge_base_catalog"] == [
        {"id": context.own.id, "name": context.own.name, "description": ""}
    ]


def test_explicit_empty_selection_does_not_restore_defaults(context):
    prepared = context.manager._prepare_stream_request(
        "profile",
        _request(
            context,
            knowledge_base_ids=[],
            knowledge_base_catalog=[{"id": context.wanx.id, "name": "forged"}],
        ),
    )
    assert prepared["configurable"]["knowledge_base_ids"] == []
    assert prepared["configurable"]["knowledge_base_catalog"] == []


def test_explicit_selection_rebuilds_catalog_and_blocks_external_context(context):
    prepared = context.manager._prepare_stream_request(
        "profile",
        _request(
            context,
            knowledge_base_ids=[context.optional.id],
            knowledge_base_catalog=[{"id": context.wanx.id, "name": "forged secret"}],
            application_id="wanx",
            user_is_admin=True,
            kb_ids=[context.wanx.id],
            mcp_servers=["foreign"],
            plugin_tool_configs={"foreign": {}},
            team_peers=["foreign"],
        ),
    )
    cfg = prepared["configurable"]
    assert cfg["knowledge_base_ids"] == [context.optional.id]
    assert cfg["knowledge_base_catalog"] == [
        {"id": context.optional.id, "name": context.optional.name, "description": ""}
    ]
    assert cfg["application_id"] == "zhijun"
    assert cfg["user_is_admin"] is False
    assert cfg["mcp_servers"] == []
    assert cfg["team_peers"] == []
    assert "kb_ids" not in cfg
    assert "plugin_tool_configs" not in cfg
    assert prepared["mcp_servers"] == []
    assert prepared["skills"] == []


@pytest.mark.parametrize("base", ["wanx", "others"])
def test_forged_selection_never_reaches_runtime_even_for_admin(context, base):
    denied = getattr(context, base)
    with pytest.raises(OctopError) as raised:
        context.manager._prepare_stream_request(
            "profile",
            _request(
                context,
                knowledge_base_ids=[denied.id],
                user_is_admin=True,
                knowledge_base_catalog=[{"id": denied.id, "name": "forged secret"}],
            ),
        )
    assert raised.value.code == ErrorCode.KNOWLEDGE_NOT_FOUND
