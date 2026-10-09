"""Core admission is owned, versioned and never implied by chat or legacy state."""

import asyncio
import json
from copy import deepcopy

from tests.unit.agents.test_personal_ontology import ontology_env as ontology_env
from tests.unit.agents.test_personal_ontology import proposal

from octop.infra.agents.ontology_admission import (
    admitted,
    candidate_page,
    group_candidates,
    pending,
    review_core,
)
from octop.infra.agents.ontology_runtime import select_context
from octop.infra.agents.ontology_types import (
    CoreCommand,
    OntologyClaim,
    OntologyEdit,
    PersonalOntology,
)
from octop.infra.agents.personal_ontology import _PATH, _read, _save, edit_personal_ontology


async def statement(registry, text="我希望重要方向由我决定", kind="principle"):
    current = await _read(registry.get_agent("own").workspace)
    result = await edit_personal_ontology(
        registry,
        7,
        None,
        OntologyEdit(revision=current.revision, action="add", statement=text, kind=kind),
    )
    return result.ontology.claims[-1]


def command(claim, action="admit", **values):
    return CoreCommand(
        expected_version=claim.version, request_id=action + claim.version, action=action, **values
    )


async def test_chat_and_legacy_writes_require_explicit_owner_admission(ontology_env):
    registry, _, _ = ontology_env
    claim = await statement(registry)
    assert not admitted(claim) and pending(claim)
    doc = await _read(registry.get_agent("own").workspace)
    assert not select_context(doc, "重要方向", "t").claims
    # Acknowledging the wording via the old review endpoint is not core admission.
    from octop.infra.agents.personal_ontology import OntologyReview, review_personal_ontology

    old = await review_personal_ontology(
        registry, 7, claim.id, OntologyReview(revision=doc.revision, action="confirm")
    )
    claim = old.ontology.claims[0]
    assert not admitted(claim)
    result = await review_core(registry, 7, claim.id, command(claim))
    saved = result.ontology.claims[0]
    assert admitted(saved) and saved.importance == 1
    assert select_context(result.ontology, "重要方向", "t").claims[0].id == claim.id


async def test_candidate_edit_snooze_reject_and_idempotent_admission(ontology_env):
    registry, _, _ = ontology_env
    claim = await statement(registry)
    edited = await review_core(
        registry,
        7,
        claim.id,
        command(claim, "edit_candidate", statement="我希望保留最终决定权", conditions="与 AI 协作"),
    )
    claim = edited.ontology.claims[0]
    assert pending(claim) and not admitted(claim)
    later = await review_core(registry, 7, claim.id, command(claim, "later"))
    claim = later.ontology.claims[0]
    assert claim.snoozed_until and (await candidate_page(registry, 7)).pending_count == 0
    request = command(claim)
    a, b = await asyncio.gather(
        review_core(registry, 7, claim.id, request), review_core(registry, 7, claim.id, request)
    )
    assert a.ontology.claims[0].version == b.ontology.claims[0].version
    assert len(a.ontology.claims) == 1
    conflict = await review_core(
        registry, 7, claim.id, CoreCommand(**{**request.model_dump(), "request_id": "different"})
    )
    assert conflict.status == "stale"
    undo = await review_core(
        registry,
        7,
        claim.id,
        command(a.ontology.claims[0], "restore", restore_version=a.previous_version),
    )
    assert not admitted(undo.ontology.claims[0])
    rejected = await review_core(registry, 7, claim.id, command(undo.ontology.claims[0], "reject"))
    assert not pending(rejected.ontology.claims[0])


async def test_correction_immediately_revokes_old_core_and_restore_cannot_bypass(ontology_env):
    registry, _, _ = ontology_env
    claim = await statement(registry)
    a = await review_core(registry, 7, claim.id, command(claim))
    claim = a.ontology.claims[0]
    corrected = await edit_personal_ontology(
        registry,
        7,
        claim.id,
        OntologyEdit(
            revision=a.ontology.revision,
            expected_version=claim.version,
            action="correct",
            statement="我希望与伙伴共同决定",
        ),
    )
    claim = corrected.ontology.claims[0]
    assert pending(claim) and not admitted(claim)
    assert not select_context(corrected.ontology, "重要方向", "t").claims
    legacy_restore = await edit_personal_ontology(
        registry,
        7,
        claim.id,
        OntologyEdit(
            revision=corrected.ontology.revision,
            expected_version=claim.version,
            action="restore",
            restore_version=corrected.previous_version,
        ),
    )
    assert not admitted(legacy_restore.ontology.claims[0])


async def test_weight_orders_relevant_peers_without_admitting_unrelated_content(ontology_env):
    registry, _, _ = ontology_env
    a = await statement(registry, "我希望合作前看分工")
    result = await review_core(registry, 7, a.id, command(a))
    a = result.ontology.claims[0]
    b = await statement(registry, "我希望合作前看行动")
    result = await review_core(registry, 7, b.id, command(b))
    b = next(c for c in result.ontology.claims if c.id == b.id)
    result = await review_core(registry, 7, b.id, command(b, "importance", importance=3))
    context = select_context(result.ontology, "合作", "t")
    assert context.claims[0].id == b.id
    assert not select_context(result.ontology, "烘焙面包", "t").claims


async def test_upgrade_backs_up_and_requires_new_review_without_reviving_rejected(ontology_env):
    registry, _, workspace = ontology_env
    await statement(registry)
    original = json.loads(workspace.files[_PATH])
    original["schema_version"] = 3
    original["claims"][0]["core_status"] = "admitted"
    original["claims"][0]["state"] = "confirmed"
    rejected = deepcopy(original["claims"][0])
    rejected.update(id="rejected", state="dismissed")
    temporary = deepcopy(rejected)
    temporary.update(id="temporary", state="draft", kind="situation")
    original["claims"].extend([rejected, temporary])
    text = json.dumps(original)
    workspace.files[_PATH] = text
    doc = await _read(workspace)
    assert pending(doc.claims[0]) and not admitted(doc.claims[0])
    assert doc.claims[1].core_status == "rejected" and doc.claims[2].core_status == "background"
    await _save(workspace, doc)
    assert workspace.files["zhijun/backups/personal-ontology-before-core-v4.json"] == text
    assert len((await _read(workspace)).claims[0].history) == len(doc.claims[0].history)


def test_grouping_preserves_original_ids_and_different_scope_and_polarity():
    def claim(id, **kw):
        return OntologyClaim(
            id=id,
            kind="principle",
            title=id,
            statement="我希望保留最终决定权",
            conditions="与 AI 协作",
            exceptions="尚待核对",
            **kw,
        )

    a = claim("a")
    b = claim("b")
    c = claim("c")
    c.conditions = "与伙伴合作"
    d = claim("d")
    d.statement = "我不希望保留最终决定权"
    doc = PersonalOntology(claims=[a, b, c, d])
    group_candidates(doc)
    assert doc.claims[0].merged_into == "b" and doc.claims[1].source_claim_ids == ["a"]
    assert pending(doc.claims[2]) and pending(doc.claims[3])
    assert len(doc.claims) == 4


async def test_source_changes_do_not_turn_adoption_into_unverified_source_quotes(ontology_env):
    registry, _, _ = ontology_env
    claim = await statement(registry)
    admitted_result = await review_core(registry, 7, claim.id, command(claim))
    claim = admitted_result.ontology.claims[0]
    assert admitted(claim) and claim.declaration == claim.statement
    changed = await review_core(
        registry,
        7,
        claim.id,
        command(claim, "edit_core", statement="我希望先听完，再决定", conditions="重要决策"),
    )
    assert admitted(changed.ontology.claims[0])
    stopped = await review_core(
        registry, 7, claim.id, command(changed.ontology.claims[0], "disable")
    )
    assert not admitted(stopped.ontology.claims[0])
    restored = await review_core(
        registry,
        7,
        claim.id,
        command(stopped.ontology.claims[0], "restore", restore_version=stopped.previous_version),
    )
    assert admitted(restored.ontology.claims[0])


async def test_candidate_discussion_is_explicit_and_does_not_enter_other_threads(
    ontology_env, monkeypatch
):
    from unittest.mock import AsyncMock, Mock

    from langchain.agents.middleware import ModelRequest, ModelResponse
    from langchain_core.messages import AIMessage, HumanMessage

    from octop.infra.agents.ontology_runtime import ZhijunOntologyMiddleware

    registry, _, workspace = ontology_env
    c = await statement(registry)
    doc = await _read(workspace)
    doc.claims[0].discussion_thread_id = "chosen"
    await _save(workspace, doc)
    middleware = ZhijunOntologyMiddleware(registry, "own", 7)
    for thread in ["chosen", "other"]:
        monkeypatch.setattr(
            "langgraph.config.get_config",
            lambda thread=thread: {
                "configurable": {
                    "agent_id": "own",
                    "user": "7",
                    "thread_id": thread,
                    "source": "web",
                }
            },
        )
        human = HumanMessage(id=thread, content="这项理解还有一点想说")
        handler = AsyncMock(return_value=ModelResponse(result=[AIMessage(content="我在听。")]))
        await middleware.awrap_model_call(
            ModelRequest(model=Mock(), messages=[human], state={"messages": [human]}), handler
        )
        prompt = handler.call_args.args[0].system_message.content
        supplied = json.loads(
            prompt.split("<personal-understanding>\n")[1].split("\n</personal-understanding>")[0]
        )
        assert not supplied["claims"]
        if thread == "chosen":
            assert supplied["candidate_discussion"]["id"] == c.id
            assert supplied["candidate_discussion"]["core_status"] == "pending"
        else:
            assert supplied.get("candidate_discussion") is None
        assert human.content == "这项理解还有一点想说"

    # Confirming does not disconnect an explicitly opened discussion from its subject.
    current = (await _read(workspace)).claims[0]
    await review_core(registry, 7, current.id, command(current))
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {"configurable": {"agent_id": "own", "user": "7", "thread_id": "chosen"}},
    )
    human = HumanMessage(id="after-admission", content="这项理解还有一点想说")
    await middleware.awrap_model_call(
        ModelRequest(model=Mock(), messages=[human], state={"messages": [human]}), handler
    )
    supplied = json.loads(
        handler.call_args.args[0]
        .system_message.content.split("<personal-understanding>\n")[1]
        .split("\n</personal-understanding>")[0]
    )
    assert supplied["claims"][0]["id"] == c.id
    assert supplied.get("candidate_discussion") is None


async def test_reextracted_atoms_do_not_reintroduce_a_rejected_understanding(ontology_env):
    from langchain_core.messages import AIMessage

    from octop.infra.agents.personal_ontology import generate_personal_ontology

    registry, harness, workspace = ontology_env
    result = await generate_personal_ontology(registry, 7, "empty")
    claim = result.ontology.claims[0]
    await review_core(registry, 7, claim.id, command(claim, "reject"))
    memory = harness._memory_runtime.memory
    old_atoms = list(memory.atoms.values())
    memory.atoms.clear()
    for i, atom in enumerate(old_atoms, start=1):
        memory.atoms[f"new-{i}"] = {**atom, "id": f"new-{i}"}
    renamed = {
        **proposal(),
        "title": "谨慎看待共同投入",
        "statement": "对合作投入先观察一段，等伙伴有实际行动再继续。",
        "conditions": "与伙伴一起承担合作投入时",
        "evidence_ids": ["new-1", "new-2"],
    }
    harness.model_factory.get.return_value.ainvoke.return_value = AIMessage(
        content=json.dumps({"claims": [renamed]}, ensure_ascii=False)
    )
    current = await _read(workspace)
    refreshed = await generate_personal_ontology(registry, 7, current.revision)
    assert refreshed.status == "ready"
    assert len(refreshed.ontology.claims) == 1
    assert refreshed.ontology.claims[0].core_status == "rejected"
