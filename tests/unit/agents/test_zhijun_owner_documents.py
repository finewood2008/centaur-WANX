"""Synthetic, in-memory material only; real user stores are never opened."""

import asyncio
import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest
from tests.unit.agents.test_role_ontology import Registry

from octop.infra.agents import personal_ontology as p
from octop.infra.agents import role_ontology as r
from octop.infra.agents import zhijun_owner_documents as m
from octop.infra.agents.ontology_admission import admitted
from octop.infra.errors import OctopError


class Knowledge:
    def __init__(self):
        self.text = "这篇笔记是我自己写的。工作选择时，我更看重诚信。"
        self.version = "original-v1"
        self.owner = 1
        self.shared = False
        self.deleted = False
        self.ready = True

    def require_owner(self, kb, *, actor_user_id):
        if kb != "private" or actor_user_id != self.owner or self.deleted:
            raise LookupError()
        return NS(shared=self.shared)

    def read_document_text_page(self, kb, did, *, actor_user_id, start, limit, source_version):
        self.require_owner(kb, actor_user_id=actor_user_id)
        if did != "note":
            raise LookupError()
        return {
            "status": "ready" if self.ready and source_version in {None, self.version} else "stale",
            "text": self.text[start : start + limit],
            "source_version": self.version,
            "total_chars": len(self.text),
            "start": start,
            "end": min(len(self.text), start + limit),
            "filename": "合成笔记.md",
            "extracted_hash": p._digest(self.text),
        }


@pytest.fixture
def setup(monkeypatch):
    registry = Registry()
    harness = registry.get_agent("personal")
    harness.config = NS(pick_default_model_ref=lambda: "synthetic/model")
    harness.model_factory = NS(get=lambda ref: object())
    knowledge = Knowledge()
    model = AsyncMock(
        return_value=json.dumps(
            {
                "claims": [
                    {
                        "kind": "value",
                        "statement": "工作选择时，我更看重诚信。",
                        "quote": knowledge.text,
                    }
                ]
            },
            ensure_ascii=False,
        )
    )
    monkeypatch.setattr(m, "_knowledge", lambda _: knowledge)
    monkeypatch.setattr(m, "ainvoke_text", model)
    return registry, knowledge, model


async def action(registry, name, *, request=None, version=None):
    view = await m.read_material(registry, 1, "private", "note")
    return await m.material_command(
        registry,
        1,
        "private",
        "note",
        m.MaterialCommand(
            action=name,
            expected_version=version or view.record.version,
            request_id=request or name + view.record.version,
            source_version=view.source_version,
            model_ref=view.model_ref,
        ),
    )


async def test_preview_does_not_write_or_call_model(setup):
    registry, _, model = setup
    with r.agent_scope(registry, 1, "personal"):
        view = await m.read_material(registry, 1, "private", "note")
        assert not view.current and view.record.version == "empty"
    assert registry.get_agent("personal").workspace.files == {}
    model.assert_not_called()


async def test_mark_generate_confirm_and_revoke_keep_history_and_other_spaces(setup):
    registry, knowledge, model = setup
    workspace = registry.get_agent("personal").workspace
    workspace.files["USER.md"] = "synthetic original"
    with r.agent_scope(registry, 1, "personal"):
        marked = await action(registry, "mark")
        assert marked.current
        model.assert_not_called()
        generated = await action(registry, "generate")
        assert generated.record.offset == len(knowledge.text)
        doc = await r.read_role_ontology(registry, 1)
        claim = doc.claims[0]
        assert claim.evidence_valid and not admitted(claim)
        e = claim.evidence[0]
        assert e.quote == knowledge.text[e.start : e.end] and e.source_type == "owner_document"
        assert e.filename == "合成笔记.md" and e.source_version == knowledge.version
        confirmed = await r.command(
            registry,
            1,
            claim.id,
            r.RoleCommand(
                action="admit",
                request_id="admit",
                expected_version=claim.version,
                statement=claim.statement,
                kind=claim.kind,
            ),
        )
        assert admitted(confirmed["ontology"].claims[0])
        await action(registry, "revoke")
        disabled = await r.read_role_ontology(registry, 1)
        assert not admitted(disabled.claims[0]) and not disabled.claims[0].evidence[0].available
        assert disabled.claims[0].statement == claim.statement and disabled.claims[0].history
        # Re-marking cannot resurrect an old grant or rejected interpretation.
        await action(registry, "mark")
        assert not (await r.read_role_ontology(registry, 1)).claims[0].evidence_valid
    assert workspace.files["USER.md"] == "synthetic original"
    assert registry.get_agent("work").workspace.files == {}
    assert set(workspace.files) == {"USER.md", p._PATH}


@pytest.mark.parametrize("change", ["edited", "deleted", "shared", "owner", "unready"])
async def test_changed_source_invalidates_pending_and_admitted_material(setup, change):
    registry, knowledge, _ = setup
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        await action(registry, "generate")
        if change == "edited":
            knowledge.version = "new-version"
        elif change == "deleted":
            knowledge.deleted = True
        elif change == "shared":
            knowledge.shared = True
        elif change == "owner":
            knowledge.owner = 2
        else:
            knowledge.ready = False
        doc = await r.read_role_ontology(registry, 1)
        c = doc.claims[0]
        assert not c.evidence_valid and not c.evidence[0].available
        result = await r.command(
            registry,
            1,
            c.id,
            r.RoleCommand(
                action="admit",
                request_id="try",
                expected_version=c.version,
                statement=c.statement,
                kind=c.kind,
            ),
        )
        assert result["status"] == "stale"


async def test_unmarked_or_wrong_model_cannot_send_material(setup):
    registry, _, model = setup
    with r.agent_scope(registry, 1, "personal"):
        with pytest.raises(OctopError):
            await action(registry, "generate")
        await action(registry, "mark")
        registry.get_agent("personal").config.pick_default_model_ref = lambda: "changed/model"
        with pytest.raises(OctopError):
            await action(registry, "generate")
    model.assert_not_called()


@pytest.mark.parametrize(
    "raw",
    ["not json", '{"claims":[{"kind":"value","statement":"我追求财富","quote":"原文没有这句话"}]}'],
)
async def test_ungrounded_or_invalid_model_output_saves_nothing(setup, raw):
    registry, _, model = setup
    model.return_value = raw
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        before = dict(registry.get_agent("personal").workspace.files)
        with pytest.raises(OctopError):
            await action(registry, "generate")
        assert registry.get_agent("personal").workspace.files == before


async def test_idempotent_retry_does_not_generate_or_duplicate(setup):
    registry, _, model = setup
    with r.agent_scope(registry, 1, "personal"):
        marked = await action(registry, "mark")
        body = m.MaterialCommand(
            action="generate",
            expected_version=marked.record.version,
            request_id="once",
            source_version=marked.source_version,
            model_ref=marked.model_ref,
        )
        first = await m.material_command(registry, 1, "private", "note", body)
        assert first == await m.material_command(registry, 1, "private", "note", body)
        assert len((await p._read(registry.get_agent("personal").workspace)).claims) == 1
        assert model.await_count == 1


async def test_revoke_during_inference_discards_result(setup):
    registry, _, model = setup
    started, release = asyncio.Event(), asyncio.Event()

    async def delayed(*args, **kwargs):
        started.set()
        await release.wait()
        return '{"claims":[]}'

    model.side_effect = delayed
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        task = asyncio.create_task(action(registry, "generate"))
        await started.wait()
        await action(registry, "revoke")
        release.set()
        with pytest.raises(OctopError):
            await task
        doc = await p._read(registry.get_agent("personal").workspace)
        assert not doc.claims and not next(iter(doc.owner_documents.values())).active


async def test_pagination_progress_and_restart_are_durable(setup):
    registry, knowledge, model = setup
    knowledge.text = "测试材料。" * 3000
    model.return_value = '{"claims":[]}'
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        first = await action(registry, "generate")
        assert first.record.offset == 12000
        # Read from the persisted state, rather than retaining a service object.
        assert (await m.read_material(registry, 1, "private", "note")).record.offset == 12000
        second = await action(registry, "generate")
        assert second.record.offset == len(knowledge.text)
        assert not (await p._read(registry.get_agent("personal").workspace)).claims


async def test_scope_rejects_nonprimary_other_owner_and_shared_library(setup):
    registry, knowledge, model = setup
    with pytest.raises(OctopError), r.agent_scope(registry, 2, "personal"):
        await m.read_material(registry, 2, "private", "note")
    registry.rows["personal"].config_json = "{}"
    with r.agent_scope(registry, 1, "personal"), pytest.raises(OctopError):
        await m.read_material(registry, 1, "private", "note")
    registry.rows["personal"].config_json = '{"zhijun_profile":{"version":1,"primary":true}}'
    knowledge.shared = True
    with r.agent_scope(registry, 1, "personal"), pytest.raises(OctopError):
        await action(registry, "mark")
    model.assert_not_called()


async def test_model_receives_only_selected_material_not_private_understanding(setup):
    registry, _, model = setup
    from octop.infra.agents.ontology_types import OntologyClaim, PersonalOntology

    workspace = registry.get_agent("personal").workspace
    secret = "synthetic private understanding not consented for material processing"
    await p._save(
        workspace,
        PersonalOntology(
            claims=[
                OntologyClaim(
                    id="old",
                    kind="value",
                    title="old",
                    statement=secret,
                    conditions="",
                    exceptions="",
                )
            ]
        ),
    )
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        await action(registry, "generate")
    assert secret not in str(model.call_args)


async def test_save_failure_preserves_original_material_and_no_progress_is_reported(
    setup, monkeypatch
):
    registry, knowledge, _ = setup
    with r.agent_scope(registry, 1, "personal"):
        await action(registry, "mark")
        workspace = registry.get_agent("personal").workspace
        before = dict(workspace.files)
        monkeypatch.setattr(
            workspace, "aupload_bytes", AsyncMock(side_effect=OSError("isolated failure"))
        )
        with pytest.raises(OSError):
            await action(registry, "generate")
        assert workspace.files == before
        assert knowledge.text == "这篇笔记是我自己写的。工作选择时，我更看重诚信。"
