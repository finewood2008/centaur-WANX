"""Review preserves evidence, versions, current owner decisions and native memory."""

import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

import pytest
from tests.unit.agents.test_role_ontology import Registry

from octop.infra.agents import personal_ontology as p
from octop.infra.agents import role_ontology as r
from octop.infra.agents.ontology_admission import admitted
from octop.infra.agents.ontology_types import (
    OntologyClaim,
    OntologyCoverage,
    OntologyEvidence,
    OntologyRelation,
    PersonalOntology,
)
from octop.infra.agents.zhijun_changes import ChangeCommand, pending_changes, resolve_change
from octop.infra.errors import OctopError


def document():
    old = OntologyClaim(
        id="old",
        version="v1",
        kind="value",
        title="稳定",
        statement="工作选择时我优先稳定",
        conditions="工作选择",
        exceptions="尚待核对例外",
        state="confirmed",
        core_status="admitted",
        admitted_at="2026-01-01T00:00:00+00:00",
        admitted_by=1,
        admitted_version="v1",
        evidence=[
            OntologyEvidence(source_type="owner_declaration", quote="我优先稳定", timestamp="now")
        ],
    )
    new = OntologyClaim(
        id="new",
        version="v2",
        kind="value",
        title="成长",
        statement="工作选择时我更看重成长",
        conditions="工作选择",
        exceptions="尚待核对例外",
        evidence=[
            OntologyEvidence(
                source_type="owner_declaration",
                atom_id="e1",
                event_id="event",
                quote="工作选择时我更看重成长",
                timestamp="now",
            )
        ],
    )
    for claim in (old, new):
        claim.source_kind = "self_report"
        claim.declaration = claim.statement
    relation = OntologyRelation(
        id="r",
        version="rv",
        kind="changes",
        source="new",
        target="old",
        source_version="v2",
        target_version="v1",
        description="可能变化",
        evidence_ids=["e1"],
    )
    return PersonalOntology(claims=[old, new], relations=[relation])


@pytest.mark.parametrize("action", ["change", "exception", "reject"])
async def test_owner_resolves_atomically_and_idempotently(action):
    registry = Registry()
    workspace = registry.get_agent("personal").workspace
    doc = document()
    original = doc.claims[0].model_dump()
    await p._save(workspace, doc)
    body = ChangeCommand(
        action=action,
        request_id="review",
        expected_version="rv",
        source_version="v2",
        target_version="v1",
        note="在积蓄足够的工作转换期，优先成长" if action == "exception" else "",
    )
    with r.agent_scope(registry, 1, "personal"):
        assert len(pending_changes(await r.read_role_ontology(registry, 1))) == 1
        assert (await resolve_change(registry, 1, "r", body))["status"] == "ready"
        saved = dict(workspace.files)
        assert (await resolve_change(registry, 1, "r", body))["status"] == "ready"
        assert workspace.files == saved
    result = await p._read(workspace)
    old, new = result.claims
    assert not pending_changes(result)
    if action == "change":
        assert not admitted(old) and admitted(new)
        assert old.history[-1].value["statement"] == original["statement"]
        assert old.evidence[0].quote == original["evidence"][0]["quote"]
    elif action == "exception":
        assert admitted(old) and not admitted(new)
        assert old.statement == original["statement"]
        assert body.note in old.exceptions and original["exceptions"] in old.exceptions
        assert len(old.evidence) == 2
    else:
        assert old.model_dump() == original and new.core_status == "rejected"
    assert result.relations[0].resolution == action
    assert registry.get_agent("work").workspace.files == {}


@pytest.mark.parametrize(
    "mutation", ["old_version", "new_version", "source_withdrawn", "false_evidence"]
)
async def test_stale_or_unverifiable_change_does_not_write(mutation):
    registry = Registry()
    doc = document()
    workspace = registry.get_agent("personal").workspace
    if mutation == "old_version":
        doc.claims[0].version = "edited"
    if mutation == "new_version":
        doc.claims[1].version = "edited"
    if mutation == "source_withdrawn":
        doc.claims[1].evidence[0].available = False
    if mutation == "false_evidence":
        doc.relations[0].evidence_ids = ["not-source"]
    await p._save(workspace, doc)
    before = dict(workspace.files)
    with r.agent_scope(registry, 1, "personal"):
        result = await resolve_change(
            registry,
            1,
            "r",
            ChangeCommand(
                action="change",
                request_id="x",
                expected_version="rv",
                source_version="v2",
                target_version="v1",
            ),
        )
    assert result["status"] == "stale" and workspace.files == before


async def test_generic_admission_cannot_bypass_change_review():
    registry = Registry()
    workspace = registry.get_agent("personal").workspace
    await p._save(workspace, document())
    before = dict(workspace.files)
    with r.agent_scope(registry, 1, "personal"), pytest.raises(OctopError):
        await r.command(
            registry,
            1,
            "new",
            r.RoleCommand(
                action="admit",
                request_id="x",
                expected_version="v2",
                statement="工作选择时我更看重成长",
                kind="value",
            ),
        )
    assert workspace.files == before


async def test_synthesis_generates_reviewable_change_without_admitting_or_editing_old_claim():
    registry = Registry()
    harness = registry.get_agent("personal")
    doc = document()
    doc.claims = doc.claims[:1]
    doc.relations = []
    await p._save(harness.workspace, doc)
    saved = await p._read(harness.workspace)
    harness.model_factory = NS(get=lambda _: None)
    harness.config = NS(pick_default_model_ref=lambda: None)
    source = {
        "atom_id": "e1",
        "event_id": "e1",
        "quote": "工作选择时我更看重成长",
        "timestamp": "now",
        "experience_id": "e1",
        "atom_hash": "hash",
        "raw_hash": "raw",
    }
    payload = {
        "claims": [
            {
                "kind": "value",
                "title": "成长",
                "statement": source["quote"],
                "conditions": "工作选择",
                "exceptions": "尚待核对例外",
                "basis": "owner_statement",
                "evidence_ids": ["e1"],
            }
        ],
        "relations": [
            {
                "source": source["quote"],
                "target": "old",
                "kind": "changes",
                "description": "可能变化",
                "state": "confirmed",
                "resolution": "change",
                "resolved_by": 1,
                "resolved_at": "forged",
                "evidence_ids": ["e1"],
            }
        ],
    }
    with (
        r.agent_scope(registry, 1, "personal"),
        patch.object(
            p,
            "_owned_sources",
            AsyncMock(
                return_value=(
                    {"e1": source},
                    OntologyCoverage(independent_events=1, eligible_sources=1),
                    "fingerprint",
                )
            ),
        ),
        patch.object(p, "ainvoke_text", AsyncMock(return_value=json.dumps(payload))),
    ):
        result = await p.generate_personal_ontology(registry, 1, saved.revision)
    assert result.status == "ready"
    result = await p._read(harness.workspace)
    assert result.claims[0].model_dump() == saved.claims[0].model_dump()
    assert len(result.relations) == 1 and result.relations[0].state == "draft"
    assert result.relations[0].source_version == result.claims[1].version
    assert not admitted(result.claims[1])

    assert result.relations[0].resolution == ""
    assert result.relations[0].resolved_by is None
    assert result.relations[0].resolved_at == ""


async def test_failed_resolution_save_keeps_both_claims_and_allows_retry():
    registry = Registry()
    workspace = registry.get_agent("personal").workspace
    await p._save(workspace, document())
    before = dict(workspace.files)
    body = ChangeCommand(
        action="change",
        request_id="write",
        expected_version="rv",
        source_version="v2",
        target_version="v1",
    )
    with r.agent_scope(registry, 1, "personal"):
        with (
            patch.object(
                workspace, "aupload_bytes", AsyncMock(side_effect=OSError("write failed"))
            ),
            pytest.raises(OSError),
        ):
            await resolve_change(registry, 1, "r", body)
        assert workspace.files == before
        assert (await resolve_change(registry, 1, "r", body))["status"] == "ready"


@pytest.mark.parametrize("note", ["", "x" * 300])
async def test_exception_requires_bounded_context_without_overwriting_previous(note):
    registry = Registry()
    workspace = registry.get_agent("personal").workspace
    await p._save(workspace, document())
    before = dict(workspace.files)
    with r.agent_scope(registry, 1, "personal"), pytest.raises(OctopError):
        await resolve_change(
            registry,
            1,
            "r",
            ChangeCommand(
                action="exception",
                request_id="scope",
                expected_version="rv",
                source_version="v2",
                target_version="v1",
                note=note,
            ),
        )
    assert workspace.files == before
