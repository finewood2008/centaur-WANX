"""Conversation deletion removes source-bound memory, not other conversations."""

from __future__ import annotations

import asyncio
import json
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from octop_memory import Memory
from octop_memory.types import DigestRecord, Episode

from octop.infra.agents.memory_maintenance import _bind_runtime
from octop.infra.agents.memory_maintenance_store import NativeStore
from octop.infra.agents.ontology_types import (
    OntologyClaim,
    OntologyContextLink,
    OntologyEvidence,
    OntologyRelation,
    PersonalOntology,
)
from octop.infra.agents.personal_ontology import _read, _save
from octop.infra.agents.thread_memory_cleanup import thread_memory_cleanup
from octop.infra.errors import ErrorCode, OctopError


class Workspace:
    def __init__(self):
        self.files = {}
        self.fail = False

    async def aread_text(self, path):
        return self.files.get(path)

    async def aupload_bytes(self, path, content):
        if self.fail:
            raise OSError("workspace unavailable")
        self.files[path] = content.decode()


@pytest.fixture
def env(tmp_path):
    memory = Memory("owner", backend_config={"db_path": str(tmp_path / "memory.sqlite")})
    atom, entity, _ = memory.create_atom("deleted apple", entity_name="shared topic")
    other, _, _ = memory.create_atom("retained banana", entity_name="shared topic")
    for source, thread in ((atom.quote_event_id, "deleted"), (other.quote_event_id, "other")):
        memory.backend._conn.execute(
            'UPDATE "owner_raw_events" SET thread_id = ?, session_id = ? WHERE id = ?',
            (thread, thread, source),
        )
    memory.backend._conn.commit()
    workspace = Workspace()
    runtime = SimpleNamespace(_memory=memory, _recall_cache=Mock(), extract=lambda params: {})
    harness = SimpleNamespace(
        workspace=workspace,
        _memory_runtime=SimpleNamespace(memory=memory, service=SimpleNamespace(_runtime=runtime)),
    )
    registry = SimpleNamespace(
        get_agent=lambda aid: harness,
        is_agent_active=lambda aid: False,
        try_begin_history_backfill=Mock(return_value=True),
        end_history_backfill=Mock(),
    )
    yield registry, workspace, memory, atom, other, runtime
    memory.backend.close()


async def test_deletion_cascades_sources_and_mixed_conclusions_without_other_raw(env):
    registry, _, memory, atom, other, runtime = env
    assistant = memory.add_raw(
        "assistant apple", event_type="assistant_message", thread_id="deleted"
    )
    fallback = memory.add_raw("session only", event_type="user_message", session_id="deleted")
    shared_session = memory.add_raw(
        "other thread", event_type="user_message", thread_id="other", session_id="deleted"
    )
    # A mixed assertion must not survive with its old deleted text. Its other
    # source and independent assertion must remain available for new extraction.
    mixed, _, _ = memory.create_atom("mixed apple and banana", entity_name="shared topic")
    memory.backend._conn.execute(
        'UPDATE "owner_atoms" SET raw_event_ids = ? WHERE id = ?',
        (json.dumps([atom.quote_event_id, other.quote_event_id]), mixed.id),
    )
    memory.backend._conn.commit()
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        assert memory.get_raw(atom.quote_event_id) is None
        assert memory.get_raw(assistant.id) is None
        assert memory.get_raw(fallback.id) is None
        assert memory.get_atom(atom.id) is None
        assert memory.get_candidate(atom.candidate_id) is None
        assert memory.get_atom(mixed.id) is None
        assert memory.get_raw(other.quote_event_id) is not None
        assert memory.get_raw(shared_session.id) is not None
        assert memory.get_atom(other.id) is not None
        assert other.quote_event_id not in runtime._memory.blocked
    registry.end_history_backfill.assert_called_once_with("owner")
    runtime._recall_cache.clear.assert_called()
    # A repeat before the metadata disappears is harmless.
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass


async def test_ontology_and_archive_copies_removed_independent_self_report_survives(env):
    registry, workspace, memory, atom, other, _ = env
    evidence = OntologyEvidence(
        atom_id=atom.id, event_id=atom.quote_event_id, quote="apple", timestamp="now"
    )
    claim = OntologyClaim(
        id="inferred",
        kind="value",
        title="apple",
        statement="apple and banana",
        conditions="test",
        exceptions="test",
        evidence=[evidence],
    )
    declared = OntologyClaim(
        id="declared",
        kind="value",
        title="manual",
        statement="owner declaration",
        conditions="test",
        exceptions="test",
        source_kind="self_report",
    )
    await _save(workspace, PersonalOntology(claims=[claim, declared]))
    workspace.files["zhijun/memory-maintenance.json"] = json.dumps(
        {
            "items": [
                {
                    "id": atom.quote_event_id,
                    "status": "archived",
                    "snapshot": {
                        "raw_events": [{"id": atom.quote_event_id, "thread_id": "deleted"}],
                    },
                }
            ]
        }
    )
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass
    doc = await _read(workspace)
    assert [claim.id for claim in doc.claims] == ["declared"]
    assert "apple" not in workspace.files["zhijun/personal-ontology.json"]
    assert json.loads(workspace.files["zhijun/memory-maintenance.json"])["items"] == []
    assert memory.get_atom(other.id) is not None


async def test_cleanup_failure_keeps_native_sources_and_does_not_enter_delete_body(env):
    registry, workspace, memory, atom, _, _ = env
    await _save(
        workspace,
        PersonalOntology(
            claims=[
                OntologyClaim(
                    id="claim",
                    kind="value",
                    title="apple",
                    statement="apple",
                    conditions="t",
                    exceptions="t",
                    evidence=[OntologyEvidence(atom_id=atom.id, quote="apple", timestamp="now")],
                )
            ]
        ),
    )
    workspace.fail = True
    with pytest.raises(OSError, match="workspace unavailable"):
        async with thread_memory_cleanup(registry, "owner", "deleted"):
            pytest.fail("metadata deletion must not run")
    assert memory.get_raw(atom.quote_event_id) is not None
    registry.end_history_backfill.assert_called_once()
    workspace.fail = False
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass
    assert memory.get_raw(atom.quote_event_id) is None


async def test_waits_for_background_extraction_without_blocking_loop(env):
    registry, _, memory, atom, _, runtime = env
    entered, release = threading.Event(), threading.Event()

    def extract(params):
        entered.set()
        assert release.wait(5)
        # Simulate a conclusion arriving after DELETE was requested.
        memory.backend._conn.execute(
            'UPDATE "owner_atoms" SET assertion = ? WHERE id = ?', ("late apple", atom.id)
        )
        memory.backend._conn.commit()
        return {}

    runtime.extract = extract
    _bind_runtime(registry, "owner", [])
    extraction = asyncio.create_task(asyncio.to_thread(runtime.extract, {}))
    assert await asyncio.to_thread(entered.wait, 2)

    async def remove():
        async with thread_memory_cleanup(registry, "owner", "deleted"):
            pass

    task = asyncio.create_task(remove())
    await asyncio.sleep(0.05)
    assert not task.done()
    release.set()
    await asyncio.wait_for(asyncio.gather(extraction, task), 3)
    assert memory.get_atom(atom.id) is None


async def test_busy_rejected_before_source_changes(env):
    registry, _, memory, atom, *_ = env
    registry.try_begin_history_backfill.return_value = False
    with pytest.raises(OctopError) as error:
        async with thread_memory_cleanup(registry, "owner", "deleted"):
            pass
    assert error.value.code == ErrorCode.AGENT_BUSY
    assert memory.get_raw(atom.quote_event_id) is not None
    registry.end_history_backfill.assert_not_called()


async def test_agent_without_memory_still_allows_checkpoint_deletion(env):
    registry, *_ = env
    registry.get_agent = lambda aid: SimpleNamespace(_memory_runtime=None)
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass


async def test_episode_digest_and_entity_summary_are_cleared(env):
    registry, _, memory, atom, other, _ = env
    now = datetime.now(UTC)
    episode = Episode(
        "episode",
        [atom.quote_event_id],
        now,
        "apple diary",
        "apple",
        atom.quote_event_id,
        "tired",
        3,
        [],
        ["work"],
        "test",
        now,
    )
    memory.backend.save_episode(episode)
    memory.backend.upsert_digest(
        DigestRecord(
            "digest",
            "daily",
            "2026-10-14",
            now,
            now + timedelta(days=1),
            "apple digest",
            ["episode"],
            "test",
            now,
            now,
        )
    )
    memory.backend._conn.execute(
        'UPDATE "owner_entity_pages" SET summary_markdown = ?, headline = ? WHERE entity_id = ?',
        ("apple summary", "apple", atom.entity_id),
    )
    memory.backend._conn.commit()
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass
    assert memory.backend.get_episode("episode") is None
    assert memory.backend.get_digest("daily", "2026-10-14") is None
    pages = NativeStore(memory).rows("entity_pages")
    assert all(
        not r["summary_markdown"] and not r["headline"]
        for r in pages
        if r["entity_id"] == atom.entity_id
    )
    assert memory.get_atom(other.id) is not None


async def test_cancelled_request_waits_for_delete_worker_before_unlock(env, monkeypatch):
    from octop.infra.agents import thread_memory_cleanup as module

    registry, _, _, _, _, runtime = env
    entered, release = threading.Event(), threading.Event()
    original = module._remove

    def remove(*args):
        entered.set()
        assert release.wait(5)
        original(*args)

    monkeypatch.setattr(module, "_remove", remove)

    async def operation():
        async with thread_memory_cleanup(registry, "owner", "deleted"):
            pytest.fail("cancelled request cannot delete metadata")

    task = asyncio.create_task(operation())
    assert await asyncio.to_thread(entered.wait, 2)
    task.cancel()
    await asyncio.sleep(0.05)
    assert runtime._memory.lock.locked()
    registry.end_history_backfill.assert_not_called()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not runtime._memory.lock.locked()
    registry.end_history_backfill.assert_called_once()


async def test_same_thread_id_in_another_namespace_is_untouched(env, tmp_path):
    registry, _, memory, _, _, _ = env
    other = Memory("other_owner", backend_config={"db_path": str(tmp_path / "memory.sqlite")})
    try:
        source = other.add_raw(
            "other owner's private text", event_type="user_message", thread_id="deleted"
        )
        async with thread_memory_cleanup(registry, "owner", "deleted"):
            pass
        assert other.get_raw(source.id) is not None
        assert memory.list_raw(thread_id="deleted") == []
    finally:
        other.backend.close()


async def test_stopped_agent_fails_before_metadata_delete(env):
    registry, *_ = env

    def unavailable(aid):
        raise OctopError.localized(ErrorCode.AGENT_NOT_RUNNING)

    registry.get_agent = unavailable
    with pytest.raises(OctopError) as error:
        async with thread_memory_cleanup(registry, "owner", "deleted"):
            pytest.fail("cannot verify offline memory")
    assert error.value.code == ErrorCode.AGENT_NOT_RUNNING
    registry.end_history_backfill.assert_called_once()


async def test_source_bound_relations_removed_without_removing_independent_endpoints(env):
    registry, workspace, _, atom, other, _ = env
    claims = [
        OntologyClaim(
            id=name,
            kind="value",
            title=name,
            statement="independent owner declaration",
            conditions="test",
            exceptions="test",
            source_kind="self_report",
        )
        for name in ("first", "second")
    ]
    relation = OntologyRelation(
        id="deleted-relation",
        source="first",
        target="second",
        kind="supports",
        description="deleted apple relation",
        evidence_ids=[atom.quote_event_id],
    )
    link = OntologyContextLink(
        id="deleted-link",
        source="first",
        target="second",
        kind="related",
        description="deleted apple link",
        evidence_ids=[atom.id],
    )
    kept = link.model_copy(
        update={
            "id": "retained-link",
            "description": "retained banana link",
            "evidence_ids": [other.quote_event_id],
        }
    )
    await _save(
        workspace, PersonalOntology(claims=claims, relations=[relation], links=[link, kept])
    )
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass
    document = await _read(workspace)
    assert {claim.id for claim in document.claims} == {"first", "second"}
    assert document.relations == []
    assert [item.id for item in document.links] == ["retained-link"]
    assert "deleted apple" not in workspace.files["zhijun/personal-ontology.json"]


async def test_archived_source_with_unrelated_archive_id_cannot_restore_thread(env):
    registry, workspace, _, _, _, _ = env
    deleted_archive = {
        "id": "stable-archive-id",
        "status": "archived",
        "snapshot": {
            "raw_events": [
                {
                    "id": "already-removed-raw",
                    "thread_id": "deleted",
                    "content": "private old source",
                }
            ],
        },
    }
    other_archive = {
        "id": "other-archive",
        "status": "archived",
        "snapshot": {
            "raw_events": [{"id": "other-raw", "thread_id": "other", "content": "keep"}],
        },
    }
    workspace.files["zhijun/memory-maintenance.json"] = json.dumps(
        {"items": [deleted_archive, other_archive]}
    )
    async with thread_memory_cleanup(registry, "owner", "deleted"):
        pass
    assert json.loads(workspace.files["zhijun/memory-maintenance.json"])["items"] == [other_archive]
