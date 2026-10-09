"""Personal principles require independent, current owner evidence and explicit review."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage

from octop.infra.agents.personal_ontology import (
    OntologyReview,
    generate_personal_ontology,
    read_personal_ontology,
    review_personal_ontology,
)
from octop.infra.errors import OctopError


class Workspace:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    async def aread_text(self, path: str) -> str | None:
        return self.files.get(path)

    async def aupload_bytes(self, path: str, content: bytes) -> None:
        self.files[path] = content.decode()


def proposal() -> dict[str, object]:
    return {
        "kind": "principle",
        "title": "先看行动再投入",
        "statement": "合作时，我倾向先看责任是否落实，再决定投入。",
        "conditions": "涉及较大合作投入时",
        "exceptions": "尚待核对例外",
        "evidence_ids": ["a1", "a2"],
    }


@pytest.fixture
def ontology_env(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[SimpleNamespace, SimpleNamespace, Workspace]:
    from octop_memory.application import dashboard_data as data

    atoms = {
        f"a{i}": {
            "id": f"a{i}",
            "candidate_id": f"c{i}",
            "assertion": q,
            "verbatim_quote": q,
            "deprecated_at": None,
        }
        for i, q in enumerate(["先看分工有没有落实", "想等他们拿出行动再决定投入"], start=1)
    }
    events = {
        f"r{i}": SimpleNamespace(
            id=f"r{i}",
            user="7",
            event_type="user_message",
            thread_id=f"experience-{i}",
            content=a["assertion"],
            timestamp=datetime.now(UTC),
        )
        for i, a in enumerate(atoms.values(), start=1)
    }
    candidates = {
        f"c{i}": SimpleNamespace(subject_entity_type="User", quote_event_id=f"r{i}") for i in (1, 2)
    }
    memory = SimpleNamespace(
        atoms=atoms,
        events=events,
        candidates=candidates,
        get_raw=events.get,
        get_candidate=candidates.get,
        get_atom=lambda aid: (
            SimpleNamespace(
                deprecated_at=atoms[aid]["deprecated_at"], candidate_id=atoms[aid]["candidate_id"]
            )
            if aid in atoms
            else None
        ),
    )
    monkeypatch.setattr(
        data,
        "list_atoms",
        lambda _m, _p: {
            "items": [a for a in atoms.values() if a["deprecated_at"] is None],
            "total": len(atoms),
            "has_more": False,
        },
    )
    monkeypatch.setattr(data, "get_atom", lambda _m, p: atoms[p["id"]])
    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=AIMessage(content=json.dumps({"claims": [proposal()]}, ensure_ascii=False))
        )
    )
    workspace = Workspace()
    harness = SimpleNamespace(
        workspace=workspace,
        _memory_runtime=SimpleNamespace(memory=memory),
        config=SimpleNamespace(pick_default_model_ref=lambda: "own/default"),
        model_factory=SimpleNamespace(get=Mock(return_value=llm)),
    )
    row = SimpleNamespace(agent_id="own", user_id=7, application_id="zhijun")
    registry = SimpleNamespace(
        get_application_profile=lambda _uid, _app: row, get_agent=Mock(return_value=harness)
    )
    return registry, harness, workspace


async def test_generate_persist_review_restart_and_source_deprecation(ontology_env: tuple) -> None:
    registry, harness, workspace = ontology_env
    initial = await read_personal_ontology(registry, 7)
    assert initial.claims == []
    harness.model_factory.get.assert_not_called()
    result = await generate_personal_ontology(registry, 7, initial.revision)
    assert result.status == "ready"
    claim = result.ontology.claims[0]
    assert claim.state == "draft" and len(claim.evidence) == 2
    assert len(workspace.files) == 1
    reviewed = await review_personal_ontology(
        registry, 7, claim.id, OntologyReview(revision=result.ontology.revision, action="confirm")
    )
    assert reviewed.ontology.claims[0].state == "confirmed"
    assert (await read_personal_ontology(registry, 7)).claims[0].state == "confirmed"
    updated = await generate_personal_ontology(registry, 7, reviewed.ontology.revision)
    assert len(updated.ontology.claims) == 1 and updated.ontology.claims[0].state == "confirmed"
    harness._memory_runtime.memory.atoms["a1"]["deprecated_at"] = "changed"
    stale = await read_personal_ontology(registry, 7)
    assert stale.outdated and not stale.claims[0].evidence_valid
    assert harness._memory_runtime.memory.atoms["a2"]["assertion"] == "想等他们拿出行动再决定投入"


@pytest.mark.parametrize(
    "bad", ["unknown", "one_event", "invalid_json", "document", "other_user", "assistant"]
)
async def test_invalid_or_unowned_evidence_never_replaces_document(
    ontology_env: tuple, bad: str
) -> None:
    registry, harness, workspace = ontology_env
    first = await generate_personal_ontology(registry, 7, "empty")
    saved = dict(workspace.files)
    memory = harness._memory_runtime.memory
    p = proposal()
    if bad == "unknown":
        p["evidence_ids"] = ["a1", "foreign"]
    if bad == "one_event":
        memory.candidates["c2"].quote_event_id = "r1"
    if bad == "document":
        memory.events["r2"].content = "只讨论资料\n[上传资料] 手册\n想等他们拿出行动再决定投入"
    if bad == "other_user":
        memory.events["r2"].user = "8"
    if bad == "assistant":
        memory.events["r2"].event_type = "assistant_message"
    harness.model_factory.get.return_value.ainvoke.return_value = AIMessage(
        content="broken"
        if bad == "invalid_json"
        else json.dumps({"claims": [p]}, ensure_ascii=False)
    )
    result = await generate_personal_ontology(registry, 7, first.ontology.revision)
    assert result.status in {"unavailable", "insufficient"}
    assert workspace.files == saved


async def test_revision_conflict_never_overwrites_review(ontology_env: tuple) -> None:
    registry, _harness, workspace = ontology_env
    generated = await generate_personal_ontology(registry, 7, "empty")
    claim = generated.ontology.claims[0]
    await review_personal_ontology(
        registry,
        7,
        claim.id,
        OntologyReview(revision=generated.ontology.revision, action="dismiss"),
    )
    saved = dict(workspace.files)
    result = await generate_personal_ontology(registry, 7, generated.ontology.revision)
    assert result.status == "stale" and workspace.files == saved
    assert result.ontology.claims[0].state == "dismissed"


async def test_source_change_during_model_call_discards_output(ontology_env: tuple) -> None:
    registry, harness, workspace = ontology_env

    async def changed(_messages: object) -> AIMessage:
        harness._memory_runtime.memory.atoms["a1"]["assertion"] = "新的说法"
        return AIMessage(content=json.dumps({"claims": [proposal()]}, ensure_ascii=False))

    harness.model_factory.get.return_value.ainvoke.side_effect = changed
    result = await generate_personal_ontology(registry, 7, "empty")
    assert result.status == "stale" and workspace.files == {}


async def test_foreign_owner_rejected_before_model_or_workspace(ontology_env: tuple) -> None:
    registry, harness, workspace = ontology_env
    with pytest.raises(OctopError):
        await generate_personal_ontology(registry, 8, "empty")
    registry.get_agent.assert_not_called()
    harness.model_factory.get.assert_not_called()
    assert not workspace.files
