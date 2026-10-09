"""Semantic grouping retains provenance, owner revisions and versioned admission."""

import json
from unittest.mock import Mock

import pytest
from langchain_core.messages import AIMessage
from tests.unit.agents.test_personal_ontology import ontology_env as ontology_env

from octop.infra.agents.ontology_admission import candidate_page, pending
from octop.infra.agents.ontology_dedup import _PATH as CACHE_PATH
from octop.infra.agents.ontology_dedup import consolidate_candidates
from octop.infra.agents.ontology_runtime import select_context
from octop.infra.agents.personal_ontology import _read, _save, generate_personal_ontology


async def prepare(env, count=3):
    registry, harness, workspace = env
    registry.is_agent_active = Mock(return_value=False)
    doc = (await generate_personal_ontology(registry, 7, "empty")).ontology
    original = doc.claims[0]
    doc.claims = [
        original.model_copy(
            deep=True,
            update={
                "id": str(i),
                "version": f"v{i}",
                "statement": f"合作投入前先看责任和行动：表达{i}",
                "conditions": f"合作评估的情境说明{i}",
                "exceptions": f"尚待核对的保留说明{i}",
            },
        )
        for i in range(count)
    ]
    await _save(workspace, doc)
    model = harness.model_factory.get.return_value
    model.ainvoke.reset_mock()
    return doc, model


def reply(messages, decide=lambda _pair: True):
    payload = json.loads(messages[1].content)
    return AIMessage(
        content=json.dumps(
            {
                "pairs": [
                    {"id": p["id"], "same_view": decide(p), "same_scope": True, "same_time": True}
                    for p in payload["pairs"]
                ]
            }
        )
    )


async def test_paraphrases_merge_once_newest_first_with_originals_and_no_core_admission(
    ontology_env,
):
    registry, _, workspace = ontology_env
    original, model = await prepare(ontology_env)
    model.ainvoke.side_effect = reply
    assert await consolidate_candidates(registry, 7) == 2
    doc = await _read(workspace)
    assert len(doc.claims) == 3
    assert [c.id for c in doc.claims if pending(c)] == ["2"]
    assert doc.claims[2].source_claim_ids == ["1", "0"]
    assert len(doc.claims[2].evidence) == 2  # Same events are not new independent evidence.
    for before, after in zip(original.claims, doc.claims, strict=True):
        assert (before.statement, before.conditions, before.exceptions) == (
            after.statement,
            after.conditions,
            after.exceptions,
        )
    assert not select_context(doc, "合作投入", "t").claims
    page = await candidate_page(registry, 7)
    assert page.total == page.pending_count == 1 and page.items[0].id == "2"
    assert await consolidate_candidates(registry, 7) == 0
    assert model.ainvoke.call_count == 1


async def test_negative_semantic_decisions_are_cached_across_restart(ontology_env):
    registry, _, workspace = ontology_env
    await prepare(ontology_env, 2)
    model = registry.get_agent("own").model_factory.get.return_value
    model.ainvoke.side_effect = lambda messages: reply(messages, lambda _p: False)
    assert await consolidate_candidates(registry, 7) == 0
    del registry._zhijun_ontology_locks
    assert await consolidate_candidates(registry, 7) == 0
    assert model.ainvoke.call_count == 1
    doc = await _read(workspace)
    doc.claims[1].statement += "；新的适用范围"
    doc.claims[1].version = "updated"
    await _save(workspace, doc)
    await consolidate_candidates(registry, 7)
    assert model.ainvoke.call_count == 2


@pytest.mark.parametrize(
    "change",
    [
        {"owner_edited": True},
        {"candidate_edited": True},
        {"core_status": "admitted"},
        {"core_status": "rejected"},
        {"core_status": "snoozed"},
        {"discussion_thread_id": "chosen"},
        {"source_kind": "self_report"},
        {"time_scope": "以前"},
        {"kind": "aspiration"},
        {"evidence": []},
    ],
)
async def test_protected_or_distinct_records_never_sent_to_merger(ontology_env, change):
    registry, _, workspace = ontology_env
    doc, model = await prepare(ontology_env, 2)
    doc.claims[0] = doc.claims[0].model_copy(update=change)
    await _save(workspace, doc)
    before = dict(workspace.files)
    assert await consolidate_candidates(registry, 7) == 0
    model.ainvoke.assert_not_called()
    assert workspace.files == before


@pytest.mark.parametrize("change", ["edit", "source", "chat"])
async def test_concurrent_user_or_source_change_wins(ontology_env, change):
    registry, harness, workspace = ontology_env
    await prepare(ontology_env, 2)

    async def changed(messages):
        if change == "edit":
            doc = await _read(workspace)
            doc.claims[0].candidate_edited = True
            doc.claims[0].statement = "本人纠正后的话"
            await _save(workspace, doc)
        elif change == "source":
            harness._memory_runtime.memory.atoms["a1"]["deprecated_at"] = "changed"
        else:
            registry.is_agent_active.return_value = True
        return reply(messages)

    harness.model_factory.get.return_value.ainvoke.side_effect = changed
    assert await consolidate_candidates(registry, 7) == 0
    assert all(not c.merged_into for c in (await _read(workspace)).claims)


async def test_incomplete_model_result_retries_later_and_does_not_hide_candidates(ontology_env):
    registry, _, workspace = ontology_env
    _, model = await prepare(ontology_env)
    model.ainvoke.return_value = AIMessage(content='{"pairs":[]}')
    before = await _read(workspace)
    assert await consolidate_candidates(registry, 7) == 0
    assert (await _read(workspace)).revision == before.revision
    assert json.loads(workspace.files[CACHE_PATH])["retry_after"]
    await consolidate_candidates(registry, 7)
    assert model.ainvoke.call_count == 1


async def test_similarity_is_not_transitive(ontology_env):
    registry, _, workspace = ontology_env
    _, model = await prepare(ontology_env)
    model.ainvoke.side_effect = lambda messages: reply(
        messages, lambda p: {p["left"], p["right"]} != {"0", "2"}
    )
    assert await consolidate_candidates(registry, 7) == 1
    assert len([c for c in (await _read(workspace)).claims if pending(c)]) == 2
