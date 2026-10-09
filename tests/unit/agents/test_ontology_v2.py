"""Owner corrections, context injection, provenance and incremental coverage."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, Mock

import pytest
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from tests.unit.agents.test_personal_ontology import ontology_env as ontology_env
from tests.unit.agents.test_personal_ontology import proposal

from octop.infra.agents.ontology_admission import review_core
from octop.infra.agents.ontology_runtime import (
    ZhijunOntologyMiddleware,
    read_context,
    select_context,
)
from octop.infra.agents.ontology_types import CoreCommand, OntologyEdit
from octop.infra.agents.personal_ontology import (
    _sources,
    edit_personal_ontology,
    generate_personal_ontology,
    read_personal_ontology,
    record_assisted_reply,
    record_expression_options,
)
from octop.infra.errors import OctopError


async def own(registry, statement="我希望你先听我说完", **kwargs):
    doc = await read_personal_ontology(registry, 7)
    return await edit_personal_ontology(
        registry,
        7,
        None,
        OntologyEdit(
            revision=doc.revision, action="add", statement=statement, kind="response", **kwargs
        ),
    )


async def test_self_declaration_edit_undo_and_next_context(ontology_env):
    registry, harness, _ = ontology_env
    first = await own(registry)
    claim = first.ontology.claims[0]
    assert claim.source_kind == "self_report" and claim.evidence_valid
    assert not claim.evidence
    harness.model_factory.get.assert_not_called()
    updated = await edit_personal_ontology(
        registry,
        7,
        claim.id,
        OntologyEdit(
            revision=first.ontology.revision,
            action="correct",
            statement="我希望先一起理清事实",
            kind="response",
        ),
    )
    context = select_context(await read_personal_ontology(registry, 7), "今天有些累", "next")
    assert context.claims == []  # Chat corrections must wait for owner admission.
    undone = await edit_personal_ontology(
        registry,
        7,
        claim.id,
        OntologyEdit(
            revision=updated.ontology.revision,
            action="restore",
            restore_version=updated.previous_version,
        ),
    )
    assert undone.ontology.claims[0].statement == claim.statement
    assert len(undone.ontology.claims[0].history) == 3
    disabled = await edit_personal_ontology(
        registry, 7, claim.id, OntologyEdit(revision=undone.ontology.revision, action="disable")
    )
    assert not select_context(disabled.ontology, "希望", "next").claims


async def test_same_experience_cannot_be_two_supports(ontology_env):
    registry, harness, _ = ontology_env
    harness._memory_runtime.memory.events["r2"].thread_id = "experience-1"
    result = await generate_personal_ontology(registry, 7, "empty")
    assert result.status == "insufficient"
    harness.model_factory.get.assert_not_called()


async def test_user_edit_wins_while_model_in_flight(ontology_env):
    registry, harness, _ = ontology_env
    first = await own(registry)
    started, finish = asyncio.Event(), asyncio.Event()

    async def wait(_messages):
        started.set()
        await finish.wait()
        return AIMessage(content=json.dumps({"claims": [proposal()]}))

    harness.model_factory.get.return_value.ainvoke.side_effect = wait
    pending = asyncio.create_task(generate_personal_ontology(registry, 7, first.ontology.revision))
    await started.wait()
    second_job = await generate_personal_ontology(registry, 7, first.ontology.revision)
    assert second_job.status == "unavailable"
    edited = await own(registry, "我现在更希望主动讨论")
    finish.set()
    assert (await pending).status == "stale"
    assert (await read_personal_ontology(registry, 7)).revision == edited.ontology.revision


async def test_incremental_unchanged_does_not_call_model_or_overwrite_owner(ontology_env):
    registry, harness, _ = ontology_env
    edited = await own(registry)
    result = await generate_personal_ontology(
        registry, 7, edited.ontology.revision, incremental=True
    )
    calls = harness.model_factory.get.return_value.ainvoke.call_count
    again = await generate_personal_ontology(
        registry, 7, result.ontology.revision, incremental=True
    )
    assert harness.model_factory.get.return_value.ainvoke.call_count == calls
    assert again.ontology.claims[0].source_kind == "self_report"
    assert again.ontology.claims[0].id == edited.ontology.claims[0].id
    assert again.ontology.progress.status == "complete"


async def test_generated_and_edited_options_do_not_become_independent_evidence(ontology_env):
    registry, harness, workspace = ontology_env
    await record_expression_options(workspace, "t", "question", ["先看分工有没有落实"])
    await record_assisted_reply(
        registry, 7, "t", "先看分工有没有落实", "想等他们拿出行动再决定投入"
    )
    result = await generate_personal_ontology(registry, 7, "empty")
    assert result.status == "insufficient"
    harness.model_factory.get.assert_not_called()


async def test_same_option_keeps_each_conversation_origin(ontology_env):
    registry, _, workspace = ontology_env
    for thread in ["first", "second"]:
        await record_expression_options(workspace, thread, "question", ["先听我说完"])
    for thread in ["first", "second"]:
        await record_assisted_reply(registry, 7, thread, "先听我说完", "我先说完")
    with pytest.raises(OctopError):
        await record_assisted_reply(registry, 7, "foreign", "先听我说完", "我先说完")


async def test_old_evidence_cannot_resurrect_corrected_understanding(ontology_env):
    registry, harness, _ = ontology_env
    generated = await generate_personal_ontology(registry, 7, "empty")
    claim = generated.ontology.claims[0]
    edited = await edit_personal_ontology(
        registry,
        7,
        claim.id,
        OntologyEdit(
            revision=generated.ontology.revision,
            action="correct",
            kind="principle",
            statement="我愿意先投入，再和伙伴一起落实分工。",
        ),
    )
    old = proposal()
    old["statement"] = "合作投入前，我会等待责任分工落地。"
    harness.model_factory.get.return_value.ainvoke.return_value = AIMessage(
        content=json.dumps({"claims": [old]}, ensure_ascii=False)
    )
    refreshed = await generate_personal_ontology(registry, 7, edited.ontology.revision)
    assert len(refreshed.ontology.claims) == 1
    assert refreshed.ontology.claims[0].statement == edited.ontology.claims[0].statement


def test_all_source_pages_are_read_not_only_recent_120(ontology_env, monkeypatch):
    _, harness, _ = ontology_env
    from octop_memory.application import dashboard_data

    memory = harness._memory_runtime.memory
    items = [dict(memory.atoms["a1"], id=f"item-{i}") for i in range(453)]
    offsets = []

    def pages(_memory, params):
        offsets.append(params["offset"])
        return {
            "items": items[params["offset"] : params["offset"] + params["limit"]],
            "total": len(items),
            "has_more": params["offset"] + params["limit"] < len(items),
        }

    monkeypatch.setattr(dashboard_data, "list_atoms", pages)
    _, coverage, _ = _sources(memory, 7)
    assert offsets == [0, 200, 400]
    assert coverage.read_atoms == 453 and not coverage.has_more


@pytest.mark.parametrize("source", ["web", "weixin"])
async def test_same_runtime_context_desktop_weixin_and_exact_trace(
    ontology_env, monkeypatch, source
):
    registry, _, workspace = ontology_env
    first = await own(registry)
    claim = first.ontology.claims[0]
    first = await review_core(
        registry,
        7,
        claim.id,
        CoreCommand(action="admit", expected_version=claim.version, request_id="runtime-admission"),
    )
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {"agent_id": "own", "user": "7", "thread_id": "t", "source": source}
        },
    )
    middleware = ZhijunOntologyMiddleware(registry, "own", 7)
    human = HumanMessage(id="h1", content="今天很累，只想被听见")
    request = ModelRequest(model=Mock(), messages=[human], state={"messages": [human]})
    handler = AsyncMock(return_value=ModelResponse(result=[AIMessage(content="我在听。")]))
    await middleware.awrap_model_call(request, handler)
    prompt = handler.call_args.args[0].system_message.content
    assert "我希望你先听我说完" in prompt and "停止分析和追问" in prompt
    assert human.content == "今天很累，只想被听见"
    trace = await read_context(registry, 7, "t", "我在听。", latest=True)
    assert trace.revision == first.ontology.revision
    assert trace.claims[0].id == first.ontology.claims[0].id
    assert (await read_context(registry, 7, "other", "我在听。")).available is False
    assert any("ontology-context" in path for path in workspace.files)


async def test_chat_tool_accepts_only_current_owner_words_and_versions(ontology_env, monkeypatch):
    registry, _, _ = ontology_env
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {"agent_id": "own", "user": "7", "thread_id": "t", "source": "web"}
        },
    )
    middleware = ZhijunOntologyMiddleware(registry, "own", 7)
    human = HumanMessage(id="h1", content="我希望你先听我说完")
    args = {
        "revision": "empty",
        "action": "add",
        "quote": human.content,
        "statement": human.content,
    }

    def request(body):
        return ToolCallRequest(
            tool_call={"id": "tc", "name": "zhijun_ontology_update", "args": body},
            tool=None,
            state={"messages": [human]},
            runtime=None,
        )

    handler = AsyncMock()
    rejected = await middleware.awrap_tool_call(
        request({**args, "statement": "我缺乏安全感"}), handler
    )
    assert json.loads(rejected.content)["saved"] is False
    result = await middleware.awrap_tool_call(request(args), handler)
    assert json.loads(result.content)["status"] == "ready"
    assert (await read_personal_ontology(registry, 7)).claims[0].declaration_turn == "h1"
    stale = await middleware.awrap_tool_call(request(args), handler)
    assert json.loads(stale.content)["status"] == "stale"
    handler.assert_not_called()


async def test_foreign_context_rejected_before_read(ontology_env, monkeypatch):
    registry, harness, _ = ontology_env
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "foreign", "user": "7", "source": "web"}},
    )
    middleware = ZhijunOntologyMiddleware(registry, "own", 7)
    with pytest.raises(OctopError):
        await middleware.awrap_model_call(ModelRequest(model=Mock(), messages=[]), AsyncMock())
    harness.model_factory.get.assert_not_called()


async def test_identical_replies_keep_their_own_immutable_context(ontology_env, monkeypatch):
    registry, _, _ = ontology_env
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {"agent_id": "own", "user": "7", "thread_id": "t", "source": "web"}
        },
    )
    first = await own(registry)
    middleware = ZhijunOntologyMiddleware(registry, "own", 7)
    for index in [1, 2]:
        if index == 2:
            await own(registry, "我现在希望多听一些不同角度")
        human = HumanMessage(id=f"h{index}", content="今天想聊聊")
        await middleware.awrap_model_call(
            ModelRequest(model=Mock(), messages=[human], state={"messages": [human]}),
            AsyncMock(
                return_value=ModelResponse(result=[AIMessage(id=f"a{index}", content="我在听。")])
            ),
        )
    old = await read_context(registry, 7, "t", "我在听。", reply_id="a1")
    new = await read_context(registry, 7, "t", "我在听。", reply_id="a2")
    assert old.revision == first.ontology.revision and new.revision != old.revision
    assert old.turn_id == "h1" and new.turn_id == "h2"
    assert (await read_context(registry, 7, "t", "不同的回答", reply_id="a1")).available is False
