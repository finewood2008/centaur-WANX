"""Bulk review runs entirely in synthetic in-memory workspaces."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from tests.unit.agents.test_role_ontology import Registry

from octop.infra.agents import personal_ontology as p
from octop.infra.agents import role_ontology as r
from octop.infra.agents import zhijun_batch_review as b
from octop.infra.agents.ontology_admission import admitted
from octop.infra.agents.ontology_types import OntologyEvidence, OntologyRelation
from octop.infra.errors import OctopError


@pytest.fixture
def registry():
    reg = Registry()
    reg.reserved = False

    def reserve(_):
        if reg.reserved:
            return False
        reg.reserved = True
        return True

    reg.try_begin_history_backfill = reserve
    reg.end_history_backfill = lambda _: setattr(reg, "reserved", False)
    return reg


async def seed(reg):
    with r.agent_scope(reg, 1, "personal"):
        for i, statement in enumerate(
            ["我先核对需求再开始", "工作中我在意诚信", "我希望留时间给家人"]
        ):
            doc = await r.read_role_ontology(reg, 1)
            await r.command(
                reg,
                1,
                "new",
                r.RoleCommand(
                    request_id=f"seed-{i}",
                    expected_version=doc.revision,
                    action="add",
                    statement=statement,
                    conditions="工作选择",
                    exceptions="紧急情况除外",
                    importance=3,
                    affinity=4,
                ),
            )
        return await b.review_page(reg, 1)


def request(page, actions=None):
    return b.BatchReview(
        request_id="one-batch",
        items=[
            b.ReviewChoice(
                id=i.claim.id,
                expected_version=i.claim.version,
                token=i.token,
                action=actions[n] if actions else "admit",
            )
            for n, i in enumerate(page.items)
        ],
    )


async def test_read_only_and_mixed_outcomes_preserve_fields_and_history(registry):
    page = await seed(registry)
    workspace = registry.get_agent("personal").workspace
    before = dict(workspace.files)
    with r.agent_scope(registry, 1, "personal"):
        assert (await b.review_page(registry, 1)) == page
        assert workspace.files == before
        result = await b.batch_review(registry, 1, request(page, ["admit", "reject", "admit"]))
        assert [x.status for x in result.results] == ["confirmed", "rejected", "confirmed"]
        doc = await r.read_role_ontology(registry, 1)
    for i, c in enumerate(doc.claims):
        assert c.conditions == "工作选择" and c.exceptions == "紧急情况除外"
        assert (c.importance, c.affinity) == (3, 4)
        assert c.history[-1].version == page.items[i].claim.version
        assert admitted(c) == (i != 1)
    assert not registry.get_agent("work").workspace.files
    assert not registry.reserved


async def test_source_or_version_changed_only_affects_that_item(registry):
    page = await seed(registry)
    ws = registry.get_agent("personal").workspace
    doc = await p._read(ws)
    doc.claims[0].version = "new-version"
    doc.claims[1].valid_until = "2020-01-01T00:00:00+00:00"
    await p._save(ws, doc)
    with r.agent_scope(registry, 1, "personal"):
        result = await b.batch_review(registry, 1, request(page))
    assert [x.status for x in result.results] == ["stale", "stale", "confirmed"]


async def test_retry_lost_response_no_duplicate_write_and_later_edit_not_success(registry):
    page = await seed(registry)
    body = request(page)
    ws = registry.get_agent("personal").workspace
    with r.agent_scope(registry, 1, "personal"):
        first = await b.batch_review(registry, 1, body)
        stored = dict(ws.files)
        assert await b.batch_review(registry, 1, body) == first
        assert ws.files == stored
        doc = await p._read(ws)
        doc.claims[0].version = "later"
        await p._save(ws, doc)
        assert (await b.batch_review(registry, 1, body)).results[0].status == "stale"


async def test_ambiguous_write_reconciles_same_receipt(registry, monkeypatch):
    page = await seed(registry)
    ws = registry.get_agent("personal").workspace
    upload = ws.aupload_bytes
    calls = 0

    async def ambiguous(path, data):
        nonlocal calls
        await upload(path, data)
        calls += 1
        if calls == 1:
            raise OSError("lost write response")

    monkeypatch.setattr(ws, "aupload_bytes", ambiguous)
    with r.agent_scope(registry, 1, "personal"):
        result = await b.batch_review(registry, 1, request(page))
        assert [x.status for x in result.results] == ["unverified", "confirmed", "confirmed"]
        result = await b.batch_review(registry, 1, request(page))
        assert all(x.status == "confirmed" for x in result.results)
        doc = await p._read(ws)
        assert all(len(c.history) == 2 for c in doc.claims)
    assert calls == 3  # Retry only reads durable receipts.


async def test_write_failure_not_success_and_retry_preserves_other_items(registry, monkeypatch):
    page = await seed(registry)
    ws = registry.get_agent("personal").workspace
    upload = ws.aupload_bytes
    monkeypatch.setattr(ws, "aupload_bytes", AsyncMock(side_effect=OSError("offline")))
    with r.agent_scope(registry, 1, "personal"):
        result = await b.batch_review(registry, 1, request(page))
        assert all(x.status == "unverified" for x in result.results)
        assert not any(admitted(c) for c in (await p._read(ws)).claims)
        monkeypatch.setattr(ws, "aupload_bytes", upload)
        assert all(
            x.status == "confirmed"
            for x in (await b.batch_review(registry, 1, request(page))).results
        )


async def test_busy_owner_and_primary_boundaries(registry):
    page = await seed(registry)
    with pytest.raises(OctopError), r.agent_scope(registry, 2, "personal"):
        await b.review_page(registry, 2)
    with r.agent_scope(registry, 1, "personal"):
        registry.reserved = True
        with pytest.raises(OctopError):
            await b.batch_review(registry, 1, request(page))
        registry.reserved = False
        registry.rows["personal"].config_json = "{}"
        with pytest.raises(OctopError):
            await b.review_page(registry, 1)


async def test_concurrent_same_request_is_idempotent_or_busy(registry):
    page = await seed(registry)
    with r.agent_scope(registry, 1, "personal"):
        results = await asyncio.gather(
            *(b.batch_review(registry, 1, request(page)) for _ in range(2)), return_exceptions=True
        )
    assert any(isinstance(x, b.BatchResult) for x in results)
    assert all(isinstance(x, (b.BatchResult, OctopError)) for x in results)
    assert all(
        len(c.history) == 2
        for c in (await p._read(registry.get_agent("personal").workspace)).claims
    )


async def test_change_candidates_and_expired_sources_cannot_bypass_individual_review(registry):
    await seed(registry)
    ws = registry.get_agent("personal").workspace
    doc = await p._read(ws)
    source, target, expired = doc.claims
    source.evidence = [
        OntologyEvidence(
            source_type="owner_declaration", atom_id="quote", quote=source.statement, timestamp=""
        )
    ]
    target.state, target.core_status = "confirmed", "admitted"
    target.admitted_at, target.admitted_by, target.admitted_version = "now", 1, target.version
    expired.valid_until = "2020-01-01T00:00:00+00:00"
    doc.relations.append(
        OntologyRelation(
            id="change",
            description="合成变化",
            kind="changes",
            source=source.id,
            target=target.id,
            source_version=source.version,
            target_version=target.version,
            evidence_ids=["quote"],
        )
    )
    await p._save(ws, doc)
    with r.agent_scope(registry, 1, "personal"):
        fresh = await b.review_page(registry, 1)
        assert len(fresh.items) == 2
        assert all(not i.eligible for i in fresh.items)
        before = dict(ws.files)
        result = await b.batch_review(registry, 1, request(fresh, ["reject", "admit"]))
        assert all(i.status == "blocked" for i in result.results)
        assert ws.files == before


async def test_bounds_duplicate_ids_and_forbidden_edits(registry):
    page = await seed(registry)
    item = request(page).items[0].model_dump()
    for items in [
        [],
        [item, item],
        [{**item, "id": str(i)} for i in range(21)],
        [{**item, "statement": "forged"}],
        [{**item, "action": "restore"}],
    ]:
        with pytest.raises(ValidationError):
            b.BatchReview(request_id="x", items=items)


async def test_withdrawn_material_authorization_is_rechecked_before_bulk_save(
    registry, monkeypatch
):
    from types import SimpleNamespace as NS

    from tests.unit.agents.test_zhijun_owner_documents import Knowledge, action

    from octop.infra.agents import zhijun_owner_documents as materials

    harness = registry.get_agent("personal")
    harness.config = NS(pick_default_model_ref=lambda: "synthetic/model")
    harness.model_factory = NS(get=lambda _: object())
    knowledge = Knowledge()
    monkeypatch.setattr(materials, "_knowledge", lambda _: knowledge)
    model = AsyncMock(
        return_value='{"claims":[{"kind":"value","statement":"工作选择时，我更看重诚信。","quote":"工作选择时，我更看重诚信。"}]}'
    )
    monkeypatch.setattr(materials, "ainvoke_text", model)
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        await action(registry, "generate")
        page = await b.review_page(registry, 1)
        assert len(page.items) == 1 and page.items[0].eligible
        await action(registry, "revoke")
        saved = dict(harness.workspace.files)
        assert (await b.batch_review(registry, 1, request(page))).results[0].status == "stale"
        assert not (await b.review_page(registry, 1)).items[0].eligible
        assert harness.workspace.files == saved
        assert model.await_count == 1  # Bulk review does not invoke a model.


async def test_later_edit_between_write_and_readback_is_not_reported_current(registry, monkeypatch):
    page = await seed(registry)
    original = b.command

    async def changed_after_write(*args, **kwargs):
        result = await original(*args, **kwargs)
        # Simulate a competing owner edit becoming visible on readback.
        next(c for c in result["ontology"].claims if c.id == args[2]).version = "later-edit"
        return result

    monkeypatch.setattr(b, "command", changed_after_write)
    with r.agent_scope(registry, 1, "personal"):
        result = await b.batch_review(registry, 1, request(page))
        assert all(x.status == "stale" for x in result.results)
