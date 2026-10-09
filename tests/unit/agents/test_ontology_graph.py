"""One current personal context over native records, with reversible owner edits."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from octop_memory import Memory
from tests.unit.agents.test_personal_ontology import ontology_env as ontology_env

from octop.infra.agents.ontology_graph import current_native_record, edit_context_node
from octop.infra.agents.ontology_runtime import (
    ZhijunOntologyMiddleware,
    read_context,
    select_context,
)
from octop.infra.agents.ontology_types import (
    OntologyContextEdit,
    OntologyEdit,
    OntologyRelationEdit,
)
from octop.infra.agents.personal_ontology import (
    _owned_sources,
    edit_personal_ontology,
    generate_personal_ontology,
    read_personal_ontology,
    review_ontology_relation,
)
from octop.infra.errors import OctopError


async def test_stopped_source_is_excluded_from_search_but_readable_as_history(
    ontology_env, monkeypatch
):
    from octop.infra.agents.memory.zhijun_recall import build_recall_tool

    registry, harness, _ = ontology_env
    memory = harness._memory_runtime.memory
    doc = await read_personal_ontology(registry, 7)
    fact = next(n for n in doc.nodes if "a1" in n.native_ids)
    await edit(registry, fact, "disable")
    service = SimpleNamespace(
        search=lambda *args, **kwargs: {
            "hits": [
                {"path": "raw_events/r1", "content": memory.events["r1"].content},
                {"path": "raw_events/r2", "content": memory.events["r2"].content},
            ]
        },
        get=lambda path: {"content": memory.events["r1"].content},
    )
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "own", "user": "7", "source": "web"}},
    )
    recall = build_recall_tool(registry, lambda: service, lambda: memory, agent_id="own", user_id=7)
    search = json.loads(await recall.ainvoke({"query": "分工"}))
    assert [row["path"] for row in search["hits"]] == ["raw_events/r2"]
    assert search["excluded_stopped_count"] == 1
    history = json.loads(await recall.ainvoke({"action": "get", "path": "raw_events/r1"}))
    assert history["content"] == memory.events["r1"].content
    assert history["current_use"] is False


async def edit(registry, node, action="correct", **values):
    return await edit_context_node(
        registry,
        7,
        node.id,
        OntologyContextEdit(
            revision="unrelated-background-revision",
            expected_version=node.version,
            action=action,
            kind=node.kind,
            **values,
        ),
    )


def add_context(memory, monkeypatch):
    from octop_memory.application import dashboard_data as data

    for atom in memory.atoms.values():
        atom["entity_id"] = "p1"
    entities = [{"id": "p1", "entity_type": "Person", "canonical_name": "西平", "aliases": []}]
    episodes = [
        {
            "id": "e1",
            "quote_event_id": "r1",
            "verbatim_quote": memory.atoms["a1"]["verbatim_quote"],
            "summary": "讨论了分工",
            "emotion": "tired",
            "occurred_at": datetime.now(UTC).isoformat(),
            "people": ["西平"],
            "topics": [],
        }
    ]
    memory.list_entities = lambda **kw: entities
    memory.list_episodes = lambda **kw: episodes
    for name, items in [("list_entities", entities), ("list_episodes", episodes)]:
        monkeypatch.setattr(
            data,
            name,
            lambda m, p, items=items: {"items": items, "total": len(items), "has_more": False},
        )
    return entities


async def test_graph_connects_people_experiences_and_understandings_without_model_on_read(
    ontology_env, monkeypatch
):
    registry, harness, workspace = ontology_env
    add_context(harness._memory_runtime.memory, monkeypatch)
    doc = await read_personal_ontology(registry, 7)
    assert {n.kind for n in doc.nodes} == {"fact", "person", "episode"}
    assert {edge.kind for edge in doc.links} == {"about", "experienced", "related"}
    assert not workspace.files
    harness.model_factory.get.assert_not_called()
    result = await generate_personal_ontology(registry, 7, doc.revision)
    assert any(
        edge.kind == "evidence" and edge.source == result.ontology.claims[0].id
        for edge in result.ontology.links
    )
    context = select_context(result.ontology, "西平的分工还是没有落实", "new-turn")
    assert any(n.kind == "person" for n in context.nodes)
    assert not context.claims and context.nodes  # Generated understandings still await admission.
    assert len(context.nodes) + len(context.claims) <= 8


async def test_name_correction_keeps_raw_quote_and_updates_all_current_displays(
    ontology_env, monkeypatch
):
    registry, harness, _ = ontology_env
    memory = harness._memory_runtime.memory
    memory.atoms["a1"].update(assertion="西平负责技术", verbatim_quote="西平负责技术")
    memory.events["r1"].content = "西平负责技术"
    add_context(memory, monkeypatch)
    before = await read_personal_ontology(registry, 7)
    person = next(n for n in before.nodes if n.kind == "person")
    result = await edit(registry, person, statement="细平", title="细平")
    assert result.status == "ready"
    after = result.ontology
    assert any(n.kind == "fact" and n.statement == "细平负责技术" for n in after.nodes)
    assert memory.events["r1"].content == "西平负责技术"
    retrieved = current_native_record(after, {"content": "西平负责技术"}, "/raw_events/r1")
    assert any(n["statement"] == "细平负责技术" for n in retrieved["current_context"])
    stale = await edit(registry, person, statement="另一个名字")
    assert stale.status == "stale"


async def test_withdrawn_source_stops_recall_and_inference_and_can_restore(ontology_env):
    registry, harness, _ = ontology_env
    generated = await generate_personal_ontology(registry, 7, "empty")
    fact = next(n for n in generated.ontology.nodes if "a1" in n.native_ids)
    _, _, old_fingerprint = await _owned_sources(
        harness.workspace, harness._memory_runtime.memory, 7
    )
    withdrawn = await edit(registry, fact, "disable")
    assert not withdrawn.ontology.claims[0].evidence_valid
    assert current_native_record(withdrawn.ontology, {}, "atom/a1.md")["current_use"] is False
    _, _, fingerprint = await _owned_sources(harness.workspace, harness._memory_runtime.memory, 7)
    assert fingerprint != old_fingerprint
    current = next(n for n in withdrawn.ontology.nodes if n.id == fact.id)
    restored = await edit(registry, current, "restore", restore_version=withdrawn.previous_version)
    assert restored.ontology.claims[0].evidence_valid
    assert harness._memory_runtime.memory.atoms["a1"]["deprecated_at"] is None


async def test_merge_checks_both_versions_and_undo_restores_both_nodes(ontology_env, monkeypatch):
    registry, harness, _ = ontology_env
    entities = add_context(harness._memory_runtime.memory, monkeypatch)
    entities.append({"id": "p2", "entity_type": "Person", "canonical_name": "细平", "aliases": []})
    harness._memory_runtime.memory.atoms["a2"]["entity_id"] = "p2"
    doc = await read_personal_ontology(registry, 7)
    first, second = [n for n in doc.nodes if n.kind == "person"]
    stale = await edit(registry, first, "merge", merge_target=second.id, merge_target_version="old")
    assert stale.status == "stale"
    merged = await edit(
        registry, first, "merge", merge_target=second.id, merge_target_version=second.version
    )
    assert merged.status == "ready"
    target = next(n for n in merged.ontology.nodes if n.id == second.id)
    assert set(target.native_ids) == {"p1", "p2"}
    assert {
        edge.source
        for edge in merged.ontology.links
        if edge.kind == "about" and edge.target == target.id
    } == {n.id for n in doc.nodes if n.kind == "fact"}
    source = next(n for n in merged.ontology.nodes if n.id == first.id)
    undone = await edit(registry, source, "restore", restore_version=merged.previous_version)
    assert next(n for n in undone.ontology.nodes if n.id == second.id).native_ids == ["p2"]
    assert next(n for n in undone.ontology.nodes if n.id == first.id).state == "active"
    assert any(edge.kind == "about" and edge.target == first.id for edge in undone.ontology.links)


async def test_inferred_connection_is_reviewable_and_rechecks_changed_endpoint(
    ontology_env, monkeypatch
):
    registry, harness, _ = ontology_env
    add_context(harness._memory_runtime.memory, monkeypatch)
    doc = await read_personal_ontology(registry, 7)
    link = next(edge for edge in doc.links if edge.kind == "related")
    result = await review_ontology_relation(
        registry,
        7,
        OntologyRelationEdit(
            revision=doc.revision,
            relation_id=link.id,
            action="confirm",
            expected_version=link.version,
        ),
    )
    assert next(edge for edge in result.ontology.links if edge.id == link.id).state == "confirmed"
    person = next(n for n in result.ontology.nodes if n.kind == "person")
    changed = await edit(registry, person, statement="细平", title="细平")
    updated = next(edge for edge in changed.ontology.links if edge.id == link.id)
    assert updated.state == "draft" and updated.version != link.version


async def test_context_add_retry_returns_same_node_and_permanent_removal_does_not_resurrect(
    ontology_env,
):
    registry, _, _ = ontology_env
    body = OntologyContextEdit(
        revision="empty",
        action="add",
        statement="我正在筹备课程",
        kind="goal",
        request_id="retry-key",
    )
    first = await edit_context_node(registry, 7, None, body)
    second = await edit_context_node(registry, 7, None, body)
    assert first.changed_id == second.changed_id
    node = next(n for n in second.ontology.nodes if n.id == first.changed_id)
    removed = await edit(registry, node, "purge")
    assert not any(n.id == node.id for n in removed.ontology.nodes)
    with pytest.raises(OctopError):
        await edit_context_node(registry, 7, None, body)


async def test_native_manual_add_and_later_native_edit_enter_current_context(
    ontology_env, tmp_path, monkeypatch
):
    registry, harness, _ = ontology_env
    # Restore actual native dashboard functions instead of the synthetic adapter.
    import importlib

    from octop_memory.application import dashboard_data as data

    importlib.reload(data)
    memory = Memory("graph-native", backend_config={"db_path": str(tmp_path / "native.db")})
    harness._memory_runtime.memory = memory
    try:
        atom, _, _ = memory.create_atom(
            "细平是技术负责人", entity_name="细平", entity_type="Person"
        )
        doc = await read_personal_ontology(registry, 7)
        fact = next(n for n in doc.nodes if n.kind == "fact")
        assert fact.source_kind == "self_report"
        changed = await edit(registry, fact, statement="细平负责连接层")
        assert changed.status == "ready"
        memory.replace_atom(atom.id, assertion="细平负责连接层和技术团队")
        doc = await read_personal_ontology(registry, 7)
        assert any(
            n.statement == "细平负责连接层和技术团队" and n.state == "active" for n in doc.nodes
        )
        assert next(n for n in doc.nodes if n.id == fact.id).state == "withdrawn"
    finally:
        memory.backend.close()


async def test_ordinary_chat_can_adopt_unique_visible_conclusion(ontology_env, monkeypatch):
    registry, _, _ = ontology_env
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "own", "user": "7", "thread_id": "t"}},
    )
    statement = "方向和担责分不开，定方向的人就是最后要负责的人。"
    messages = [
        HumanMessage(content="我认为定方向和负责分不开"),
        AIMessage(content=f"我会这样记住：「{statement}」。这样理解准确吗？"),
        HumanMessage(id="approval", content="准确，就是这样。"),
    ]
    request = ToolCallRequest(
        tool_call={
            "id": "c",
            "name": "zhijun_ontology_update",
            "args": {
                "revision": "empty",
                "action": "confirm",
                "quote": "准确，就是这样。",
                "statement": statement,
            },
        },
        tool=None,
        runtime=None,
        state={"messages": messages},
    )
    result = await ZhijunOntologyMiddleware(registry, "own", 7).awrap_tool_call(
        request, AsyncMock()
    )
    assert json.loads(result.content)["status"] == "ready"
    doc = await read_personal_ontology(registry, 7)
    assert doc.claims[0].kind == "principle"
    assert doc.claims[0].declaration == "准确，就是这样。"
    assert doc.claims[0].core_status == "pending"
    assert doc.claims[0].id not in {
        c.id for c in select_context(doc, "如何判断人机的方向和责任", "next").claims
    }


async def test_node_and_claim_versions_ignore_unrelated_document_progress(ontology_env):
    registry, _, _ = ontology_env
    doc = await read_personal_ontology(registry, 7)
    fact = doc.nodes[0]
    await edit_context_node(
        registry,
        7,
        None,
        OntologyContextEdit(
            revision=doc.revision, action="add", statement="我正筹备课程", kind="goal"
        ),
    )
    assert (await edit(registry, fact, statement="先看责任再投入")).status == "ready"
    doc = await read_personal_ontology(registry, 7)
    claim = await edit_personal_ontology(
        registry,
        7,
        None,
        OntologyEdit(
            revision=doc.revision, action="add", statement="我希望你先听我说完", kind="response"
        ),
    )
    old = claim.ontology.claims[0]
    await edit_context_node(
        registry,
        7,
        None,
        OntologyContextEdit(
            revision=claim.ontology.revision, action="add", statement="当前目标", kind="goal"
        ),
    )
    result = await edit_personal_ontology(
        registry,
        7,
        old.id,
        OntologyEdit(
            revision=claim.ontology.revision,
            expected_version=old.version,
            action="correct",
            statement="我希望先一起理清事实",
            kind="response",
        ),
    )
    assert result.status == "ready"


@pytest.mark.parametrize("source", ["web", "weixin"])
async def test_current_fact_is_supplied_and_traced_in_both_conversation_channels(
    ontology_env, monkeypatch, source
):
    registry, _, _ = ontology_env
    doc = await read_personal_ontology(registry, 7)
    fact = doc.nodes[0]
    saved = await edit(registry, fact, statement="我正在筹备陶艺课程", core=True)
    updated = next(n for n in saved.ontology.nodes if n.id == fact.id)
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {
                "agent_id": "own",
                "user": "7",
                "thread_id": "next-thread",
                "source": source,
            }
        },
    )
    human = HumanMessage(id="h-new", content="课程的筹备让我有些累")
    request = ModelRequest(model=None, messages=[human], state={"messages": [human]})
    handler = AsyncMock(
        return_value=ModelResponse(result=[AIMessage(id="a-new", content="我在听。")])
    )
    await ZhijunOntologyMiddleware(registry, "own", 7).awrap_model_call(request, handler)
    actual = await read_context(registry, 7, "next-thread", "我在听。", latest=True)
    assert any(
        n.id == updated.id and n.version == updated.version and n.statement == updated.statement
        for n in actual.nodes
    )
    assert "我正在筹备陶艺课程" in handler.call_args.args[0].system_message.content
