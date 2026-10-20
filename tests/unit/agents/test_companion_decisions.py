"""Synthetic owner decisions; all storage in memory, no real accounts or histories."""

import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, messages_to_dict
from pydantic import ValidationError
from tests.unit.agents.test_role_ontology import Registry

from octop.infra.agents import personal_ontology as p
from octop.infra.agents import role_ontology as r
from octop.infra.agents import zhijun_decisions as d
from octop.infra.agents.ontology_admission import admitted
from octop.infra.agents.ontology_types import PersonalOntology
from octop.infra.errors import OctopError


@pytest.fixture
def setup(monkeypatch):
    reg = Registry()
    reg.octop_config = NS(default_timezone="Asia/Shanghai")
    reg.reserved = False

    def reserve(_):
        if reg.reserved:
            return False
        reg.reserved = True
        return True

    reg.try_begin_history_backfill = reserve
    reg.end_history_backfill = lambda _: setattr(reg, "reserved", False)
    h = reg.get_agent("personal")
    h.config = NS(pick_default_model_ref=lambda: "synthetic/model")
    h.model_factory = NS(get=lambda _: object())
    gateway = NS(
        thread_registry=NS(
            get_thread=lambda tid: NS(agent_id="personal", user_id=1) if tid == "thread" else None
        )
    )
    page = AsyncMock(
        return_value={
            "messages": messages_to_dict(
                [
                    HumanMessage(content="我决定先试做两周，因为还不了解需求。我担心时间不够。"),
                    AIMessage(content="预计你会赚十万。"),
                ]
            )
        }
    )
    model = AsyncMock(
        return_value=json.dumps(
            {
                "description": "我决定先试做两周",
                "reasons": "因为还不了解需求",
                "concerns": "我担心时间不够。",
                "expectation": "",
            }
        )
    )
    monkeypatch.setattr(d, "read_page", page)
    monkeypatch.setattr(d, "ainvoke_text", model)
    return reg, gateway, page, model


async def command(setup, action="confirm", did="new", **kw):
    reg, gateway, _, _ = setup
    with r.agent_scope(reg, 1, "personal"):
        doc = await p._read(reg.get_agent("personal").workspace)
        entry = next((e for e in doc.decisions if e.id == did), None)
        body = {
            "action": action,
            "expected_version": entry.version if entry else doc.revision,
            "request_id": str(len(doc.decision_operations)),
            "description": "试做两周",
            "reasons": "了解需求",
            "expectation": "收集反馈",
            "revisit_date": "2026-01-01",
        }
        body.update(kw)
        return await d.decision_command(reg, gateway, object(), 1, did, d.DecisionCommand(**body))


async def add_principle(reg):
    with r.agent_scope(reg, 1, "personal"):
        doc = await p._read(reg.get_agent("personal").workspace)
        result = await r.command(
            reg,
            1,
            "new",
            r.RoleCommand(
                action="add_admit",
                request_id="principle",
                expected_version=doc.revision,
                statement="我倾向先验证再投入",
                kind="principle",
            ),
        )
        return result["ontology"].claims[0]


async def test_read_and_proposal_do_not_persist_or_send_other_private_content(setup):
    reg, gateway, _, model = setup
    await add_principle(reg)
    before = dict(reg.get_agent("personal").workspace.files)
    with r.agent_scope(reg, 1, "personal"):
        assert not (await d.decisions(reg, 1)).entries
        preview = await d.propose_decision(
            reg, gateway, object(), 1, d.ProposeDecision(thread_id="thread")
        )
    assert preview.expectation == "" and preview.description == "我决定先试做两周"
    model_input = model.call_args.args[1][1].content
    assert "预计你会赚十万" not in model_input and "先验证再投入" not in model_input
    assert reg.get_agent("personal").workspace.files == before
    assert not reg.reserved


async def test_confirm_readback_restart_idempotence_and_legacy_preservation(setup):
    reg, _, _, _ = setup
    h = reg.get_agent("personal")
    h.workspace.files["zhijun/decision-book.json"] = '{"revision":"legacy","entries":[]}'
    h.workspace.files["USER.md"] = "original"
    result = await command(setup, request_id="once", expected_version="empty")
    again = await command(setup, request_id="once", expected_version="empty")
    assert result.changed_id == again.changed_id and len(again.book.entries) == 1
    assert result.changed_id in result.book.due_ids
    assert (
        PersonalOntology.model_validate_json(h.workspace.files[p._PATH]).decisions[0].description
        == "试做两周"
    )
    assert h.workspace.files["USER.md"] == "original"
    assert h.workspace.files["zhijun/decision-book.json"] == '{"revision":"legacy","entries":[]}'
    assert reg.get_agent("work").workspace.files == {}
    with pytest.raises(OctopError):
        await command(setup, request_id="once", expected_version="empty", description="不同内容")


@pytest.mark.parametrize("effect", ["reinforce", "exception", "change"])
async def test_review_keeps_original_snapshot_and_only_proposes_understanding(setup, effect):
    reg, _, _, _ = setup
    claim = await add_principle(reg)
    result = await command(setup, understandings=[{"id": claim.id, "version": claim.version}])
    entry = result.book.entries[0]
    reviewed = await command(
        setup,
        "review",
        entry.id,
        outcome="试做后发现需求不同",
        reflection="需要更早核对",
        effect=effect,
        understanding="这次时间有限，我希望先核对需求",
        target_id=claim.id,
        target_version=claim.version,
        revisit_date="",
    )
    saved = reviewed.book.entries[0]
    assert saved.expectation == entry.expectation and saved.understandings == entry.understandings
    assert saved.state == "reviewed" and not reviewed.book.due_ids and len(saved.reviews) == 1
    with r.agent_scope(reg, 1, "personal"):
        doc = await r.read_role_ontology(reg, 1)
        original = next(c for c in doc.claims if c.id == claim.id)
        proposed = next(c for c in doc.claims if c.id == reviewed.candidate_id)
        assert original.model_dump() == claim.model_dump()
        assert not admitted(proposed) and proposed.evidence_valid
        assert proposed.evidence[0].source_type == "decision_review"
    second = await command(
        setup, "review", entry.id, outcome="两周后继续有反馈", revisit_date="2026-12-01"
    )
    assert (
        len(second.book.entries[0].reviews) == 2
        and second.book.entries[0].reviews[0] == saved.reviews[0]
    )
    archived = await command(setup, "archive", entry.id)
    assert (
        archived.book.entries[0].state == "archived" and len(archived.book.entries[0].reviews) == 2
    )
    with pytest.raises(OctopError):
        await command(setup, "review", entry.id, outcome="不能改写")


async def test_conflicts_stale_sources_and_busy_deny_without_write(setup):
    reg, gateway, page, _ = setup
    with r.agent_scope(reg, 1, "personal"):
        preview = await d.propose_decision(
            reg, gateway, object(), 1, d.ProposeDecision(thread_id="thread")
        )
    page.return_value = {"messages": messages_to_dict([HumanMessage(content="不做了")])}
    stale = await command(setup, thread_id="thread", source_hash=preview.source_hash)
    assert stale.status == "stale" and not stale.book.entries
    reg.reserved = True
    with pytest.raises(OctopError):
        await command(setup)
    reg.reserved = False
    result = await command(setup)
    stale = await command(setup, "review", result.changed_id, expected_version="old", outcome="ok")
    assert stale.status == "stale" and not stale.book.entries[0].reviews


async def test_owner_private_primary_and_thread_checks(setup):
    reg, gateway, _, model = setup
    with pytest.raises(OctopError), r.agent_scope(reg, 2, "personal"):
        await d.decisions(reg, 2)
    with r.agent_scope(reg, 1, "personal"):
        with pytest.raises(OctopError):
            await d.propose_decision(
                reg, gateway, object(), 1, d.ProposeDecision(thread_id="foreign")
            )
        reg.rows["personal"].config_json = "{}"
        with pytest.raises(OctopError):
            await d.decisions(reg, 1)
    model.assert_not_called()
    assert not reg.reserved


@pytest.mark.parametrize(
    "result",
    [
        '{"description":"凭空补充"}',
        "not json",
        '{"description":"我决定先试做两周","prompt":"oops"}',
    ],
)
async def test_hallucinated_or_invalid_model_output_rejected(setup, result):
    reg, gateway, _, model = setup
    model.return_value = result
    with pytest.raises(OctopError), r.agent_scope(reg, 1, "personal"):
        await d.propose_decision(reg, gateway, object(), 1, d.ProposeDecision(thread_id="thread"))
    assert reg.get_agent("personal").workspace.files == {} and not reg.reserved


async def test_failed_write_is_not_success_and_post_write_failure_can_retry(setup, monkeypatch):
    reg, _, _, _ = setup
    workspace = reg.get_agent("personal").workspace
    original = workspace.aupload_bytes

    async def broken(path, content):
        raise OSError("synthetic disk failure")

    monkeypatch.setattr(workspace, "aupload_bytes", broken)
    with pytest.raises(OSError):
        await command(setup, request_id="retry", expected_version="empty")
    assert not workspace.files and not reg.reserved

    async def saved_then_lost(path, content):
        await original(path, content)
        raise OSError("synthetic response lost")

    monkeypatch.setattr(workspace, "aupload_bytes", saved_then_lost)
    with pytest.raises(OSError):
        await command(setup, request_id="retry", expected_version="empty")
    recovered = await command(setup, request_id="retry", expected_version="empty")
    assert recovered.status == "ready" and len(recovered.book.entries) == 1


async def test_changed_understanding_or_review_evidence_not_silently_reused(setup):
    reg, _, _, _ = setup
    c = await add_principle(reg)
    result = await command(setup, understandings=[{"id": c.id, "version": c.version}])
    with pytest.raises(OctopError):
        await command(
            setup,
            "review",
            result.changed_id,
            outcome="test",
            effect="change",
            understanding="限定观点",
            target_id=c.id,
            target_version="stale",
        )
    result = await command(
        setup,
        "review",
        result.changed_id,
        outcome="test",
        effect="change",
        understanding="限定观点",
        target_id=c.id,
        target_version=c.version,
    )
    with r.agent_scope(reg, 1, "personal"):
        doc = await p._read(reg.get_agent("personal").workspace)
        doc.decisions[0].reviews[0].understanding = "tampered"
        await p._save(reg.get_agent("personal").workspace, doc)
        fresh = await r.read_role_ontology(reg, 1)
        assert not next(c for c in fresh.claims if c.id == result.candidate_id).evidence_valid


def test_closed_requests_and_calendar_dates():
    for extra in [
        {"prompt": "override"},
        {"revisit_date": "2026-02-30"},
        {"revisit_date": "20260101"},
        {"private": False},
    ]:
        with pytest.raises(ValidationError):
            d.DecisionCommand(action="confirm", request_id="r", expected_version="empty", **extra)


async def test_review_exception_keeps_both_material_and_review_evidence_checks(setup, monkeypatch):
    from octop.infra.agents import zhijun_owner_documents as material
    from octop.infra.agents.ontology_types import OntologyEvidence
    from octop.infra.agents.zhijun_changes import ChangeCommand, pending_changes, resolve_change

    reg, _, _, _ = setup
    target = await add_principle(reg)
    with r.agent_scope(reg, 1, "personal"):
        doc = await p._read(reg.get_agent("personal").workspace)
        target = doc.claims[0]
        target.source_kind = "inference"
        target.evidence = [
            OntologyEvidence(
                source_type="owner_document", quote=target.statement, timestamp="synthetic"
            )
        ]
        await p._save(reg.get_agent("personal").workspace, doc)
    validator = AsyncMock(return_value=True)
    monkeypatch.setattr(material, "validate_evidence", validator)
    result = await command(setup, understandings=[{"id": target.id, "version": target.version}])
    result = await command(
        setup,
        "review",
        result.changed_id,
        outcome="特殊情境",
        effect="exception",
        understanding="紧急情境下我先处理眼前问题",
        target_id=target.id,
        target_version=target.version,
    )
    with r.agent_scope(reg, 1, "personal"):
        doc = await r.read_role_ontology(reg, 1)
        change = pending_changes(doc)[0]
        await resolve_change(
            reg,
            1,
            change.id,
            ChangeCommand(
                action="exception",
                request_id="exception",
                expected_version=change.version,
                source_version=change.proposed.version,
                target_version=change.previous.version,
                note="紧急情境",
            ),
        )
        fresh = await r.read_role_ontology(reg, 1)
        target = next(c for c in fresh.claims if c.id == target.id)
        assert admitted(target) and len(target.evidence) == 2
        validator.return_value = False
        assert not admitted(
            next(c for c in (await r.read_role_ontology(reg, 1)).claims if c.id == target.id)
        )
