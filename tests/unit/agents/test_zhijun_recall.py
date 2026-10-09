"""Fixed extraction output cannot acquire owner-statement semantics in recall."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, ToolMessage
from octop_memory import Memory
from octop_memory.ports.llm.mock import MockLLMClient
from octop_memory.service import MemoryService
from octop_memory.types import Episode

from octop.infra.agents.memory.zhijun_recall import (
    build_recall_tool,
    ontology_context_payload,
    recall_record,
)
from octop.infra.agents.middleware.zhijun import ZhijunMemoryBoundary


@pytest.mark.parametrize("source", ["web", "weixin"])
async def test_auto_promoted_assistant_suggestion_is_an_unconfirmed_inference(
    tmp_path, monkeypatch, source
):
    memory = Memory("synthetic", backend_config={"db_path": str(tmp_path / "memory.sqlite")})
    try:
        quote = "建议你把 retry 上限设为 3，这样既能容错又不会拖慢响应。"
        service = MemoryService(memory)
        service.capture_turn(
            user="嗯，先这样吧，之后再看看。",
            assistant=quote,
            session_id="s",
            thread_id="t",
            user_id="7",
        )
        events = memory.list_raw(session_id="s")
        assistant = next(e for e in events if e.event_type == "assistant_message")
        canned = json.dumps(
            {
                "candidates": [
                    {
                        "candidate_type": "Fact",
                        "status": "pending",
                        "title": "retry limit",
                        "assertion": "建议将 retry 上限设为 3 以平衡容错与响应速度",
                        "verbatim_quote": quote,
                        "quote_event_id": assistant.id,
                        "subject": {"name": "User", "entity_type": "User"},
                        "target_entities": [],
                        "source_refs": [e.id for e in events],
                        "confidence": "low",
                        "importance": "medium",
                        "recommended_action": "promote",
                        "promotion_reason": "unaccepted assistant suggestion",
                    }
                ],
                "episodes": [],
            },
            ensure_ascii=False,
        )
        service = MemoryService(memory, llm=MockLLMClient(default_response=canned))
        extracted = service.extract("s", regen_pages=False)
        assert extracted["promotion"]["promoted"] == 1
        monkeypatch.setattr(
            "langgraph.config.get_config",
            lambda: {"configurable": {"agent_id": "own", "user": "7", "source": source}},
        )
        recall = build_recall_tool(None, lambda: service, lambda: memory, agent_id="own", user_id=7)
        search = json.loads(await recall.ainvoke({"query": "retry"}))
        hit = next(h for h in search["hits"] if h["path"].startswith("atom/"))
        detail = json.loads(await recall.ainvoke({"action": "get", "path": hit["path"]}))
        for item in (hit, detail):
            assert item["statement_kind"] == "inference"
            assert item["confirmation"] == "unconfirmed"
            assert item["evidence_origin"] == "assistant_message"
            assert "role_hint" not in item
        # A forged direct invocation still cannot cross owners.
        monkeypatch.setattr("langgraph.config.get_config", lambda: {"configurable": {"user": "8"}})
        with pytest.raises(PermissionError):
            await recall.ainvoke({"query": "retry"})
    finally:
        memory.backend.close()


def test_ontology_explicit_and_automatic_context_share_confirmation_policy():
    from octop.infra.agents.ontology_types import OntologyClaim

    claims = [
        OntologyClaim(
            id=str(i),
            kind="principle",
            title="理解",
            statement="选择",
            conditions="合作时",
            exceptions="",
            state=state,
            source_kind=origin,
            core_status="admitted" if i >= 2 else "pending",
            admitted_version="v" if i >= 2 else "",
            admitted_at="2026-10-02" if i >= 2 else "",
            admitted_by=7 if i >= 2 else None,
            version="v",
            evidence_valid=True,
        ).model_dump()
        for i, (state, origin) in enumerate(
            [
                ("draft", "self_report"),
                ("draft", "inference"),
                ("confirmed", "inference"),
                ("confirmed", "self_report"),
            ]
        )
    ]
    supplied = ontology_context_payload({"claims": claims})["claims"]
    assert supplied == [recall_record(c, kind="ontology") for c in claims[2:]]
    assert [c["statement_kind"] for c in supplied] == ["confirmed_understanding", "user_statement"]


async def test_unified_ontology_recall_does_not_resurrect_withdrawn_claims(monkeypatch):
    from octop.infra.agents.ontology_types import OntologyClaim, PersonalOntology

    doc = PersonalOntology(
        claims=[
            OntologyClaim(
                id=state,
                kind="principle",
                title=state,
                statement="选择",
                conditions="合作时",
                exceptions="待核对",
                state=state,
                version="v",
                admitted_version="v" if state == "confirmed" else "",
                admitted_at="2026-10-02" if state == "confirmed" else "",
                admitted_by=7 if state == "confirmed" else None,
                core_status="admitted" if state == "confirmed" else "pending",
                evidence_valid=True,
                discussion_thread_id="discussion" if state == "draft" else "",
            )
            for state in ("draft", "confirmed", "withdrawn", "dismissed")
        ]
    )

    async def read(*args, **kwargs):
        return doc

    monkeypatch.setattr("octop.infra.agents.personal_ontology.read_personal_ontology", read)
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "own", "user": "7", "source": "web"}},
    )
    recall = build_recall_tool(
        SimpleNamespace(), lambda: None, lambda: None, agent_id="own", user_id=7
    )
    result = json.loads(await recall.ainvoke({"scope": "ontology"}))
    assert {c["id"] for c in result["claims"]} == {"confirmed"}
    assert all(c["statement_kind"] != "user_statement" for c in result["claims"])
    hidden = json.loads(
        await recall.ainvoke({"scope": "ontology", "action": "get", "path": "/ontology/draft"})
    )
    assert "statement" not in hidden
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {
                "agent_id": "own",
                "user": "7",
                "source": "web",
                "thread_id": "discussion",
            }
        },
    )
    explicit = json.loads(await recall.ainvoke({"scope": "ontology"}))
    assert {c["id"] for c in explicit["claims"]} == {"draft", "confirmed"}


async def test_old_checkpoint_recall_is_replaced_without_rewriting_conversation():
    old = ToolMessage(content="user said: unaccepted suggestion", tool_call_id="old")
    conversation = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "memory_search",
                    "id": "old",
                    "args": {"query": "retry"},
                    "type": "tool_call",
                }
            ],
        ),
        old,
    ]
    request = ModelRequest(model=Mock(), messages=conversation, state={"messages": conversation})
    handler = AsyncMock(return_value=ModelResponse(result=[AIMessage(content="合成回复")]))
    await ZhijunMemoryBoundary("own", 7, lambda: None).awrap_model_call(request, handler)
    supplied = handler.call_args.args[0].messages[-1]
    assert json.loads(supplied.content)["error"] == "legacy_recall_requires_refresh"
    assert supplied.tool_call_id == old.tool_call_id
    assert old.content == "user said: unaccepted suggestion"


async def test_episode_recall_preserves_sources_without_unlabelled_nested_tools(
    tmp_path, monkeypatch
):
    memory = Memory("synthetic", backend_config={"db_path": str(tmp_path / "memory.sqlite")})

    class Calls(BaseCallbackHandler):
        def __init__(self):
            self.names = []

        def on_tool_start(self, serialized, input_str, **kwargs):
            self.names.append(serialized["name"])

    try:
        now = datetime.now(UTC)
        raw = memory.add_raw("第一次报告，我有些紧张。", event_type="user_message", user="7")
        memory.add_episodes(
            [
                Episode(
                    id="episode",
                    raw_event_ids=[raw.id],
                    occurred_at=now,
                    summary="第一次报告时紧张",
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
        monkeypatch.setattr(
            "langgraph.config.get_config",
            lambda: {"configurable": {"agent_id": "own", "user": "7", "source": "web"}},
        )
        recall = build_recall_tool(None, lambda: None, lambda: memory, agent_id="own", user_id=7)
        calls = Calls()
        search = json.loads(
            await recall.ainvoke({"scope": "episodes", "query": "报告"}, {"callbacks": [calls]})
        )
        assert search["items"][0]["statement_kind"] == "inference"
        detail = json.loads(
            await recall.ainvoke(
                {"scope": "episodes", "action": "get", "path": "/episodes/episode"},
                {"callbacks": [calls]},
            )
        )
        assert detail["episode"]["confirmation"] == "unconfirmed"
        assert detail["sources"][0]["content"] == raw.content
        assert detail["sources"][0]["statement_kind"] == "source_quote"
        assert detail["sources"][0]["evidence_origin"] == "user_message"
        assert calls.names == ["zhijun_memory_recall", "zhijun_memory_recall"]
    finally:
        memory.backend.close()
