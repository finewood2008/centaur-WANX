"""Synthetic maintenance verifies real native storage, recovery and isolation."""

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

from octop.infra.agents.memory_maintenance import (
    MaintenanceArchiveCommand,
    MaintenanceCommand,
    MaintenanceTarget,
    bind_maintenance_runtime,
    maintain_archive,
    maintain_memory,
    preview_maintenance,
    read_maintenance,
)
from octop.infra.agents.memory_maintenance_store import NativeStore
from octop.infra.agents.ontology_types import OntologyClaim, PersonalOntology
from octop.infra.agents.personal_ontology import _read, _save
from octop.infra.errors import ErrorCode, OctopError


class Workspace:
    def __init__(self):
        self.files = {}
        self.fail = False

    async def aread_text(self, path):
        return self.files.get(path)

    async def aupload_bytes(self, path, content):
        if self.fail:
            raise OSError("synthetic write failure")
        self.files[path] = content.decode()


@pytest.fixture
def env(tmp_path):
    memory = Memory("owner", backend_config={"db_path": str(tmp_path / "memory.sqlite")})
    atom, entity, _ = memory.create_atom("synthetic apple maintenance", entity_name="test topic")
    other, _, _ = memory.create_atom("unrelated banana", entity_name="other topic")
    workspace = Workspace()
    cache = SimpleNamespace(clear=Mock())
    harness = SimpleNamespace(
        workspace=workspace,
        _memory_runtime=SimpleNamespace(
            memory=memory,
            service=SimpleNamespace(
                _runtime=SimpleNamespace(_recall_cache=cache, _memory=memory, extract=lambda p: {})
            ),
        ),
    )
    row = SimpleNamespace(agent_id="owner", user_id=7, application_id="zhijun")
    registry = SimpleNamespace(
        get_application_profile=lambda uid, app: row,
        get_agent=lambda aid: harness,
        is_agent_active=lambda aid: False,
    )
    yield registry, workspace, memory, atom, entity, other, cache
    memory.backend.close()


async def test_archive_serializes_with_an_inflight_extraction(env):
    from octop_memory.application.runtime import MemoryRuntime

    registry, ws, memory, atom, *_ = env
    started, release = threading.Event(), threading.Event()
    runtime = MemoryRuntime(memory)

    def extracting(params):
        started.set()
        assert release.wait(5)
        return {}

    runtime.extract = extracting
    registry.get_agent("owner")._memory_runtime.service._runtime = runtime
    await bind_maintenance_runtime(registry, 7)
    extraction = asyncio.create_task(asyncio.to_thread(runtime.extract, {}))
    assert await asyncio.to_thread(started.wait, 2)
    operation = asyncio.create_task(archive(env, "atom", atom.id))
    try:
        for _ in range(100):
            if "zhijun/memory-maintenance.json" in ws.files:
                break
            await asyncio.sleep(0.01)
        assert (
            json.loads(ws.files["zhijun/memory-maintenance.json"])["items"][0]["status"]
            == "prepared"
        )
        assert memory.get_atom(atom.id) is not None and not operation.done()
    finally:
        release.set()
    await asyncio.wait_for(extraction, 3)
    _preview, record = await asyncio.wait_for(operation, 3)
    assert record.status == "archived" and memory.get_atom(atom.id) is None
    assert atom.quote_event_id in runtime._memory.blocked


@pytest.mark.parametrize("purge", [False, True])
async def test_restart_extraction_and_model_recall_exclude_retired_sources(env, monkeypatch, purge):
    from octop_memory.application.runtime import MemoryRuntime
    from octop_memory.pipeline.extractor import CandidateExtractor, ExtractionResult

    registry, ws, memory, atom, *_ = env
    memory.backend._conn.execute(
        f'UPDATE "{memory.backend._ns}_raw_events" SET session_id = ?', ("test-session",)
    )
    memory.backend._conn.commit()
    original = memory.get_raw(atom.quote_event_id)
    preview, retired = await archive(env, "atom", atom.id)
    if purge:
        await maintain_archive(
            registry,
            7,
            MaintenanceArchiveCommand(
                archive_id=retired.archive_id, version=preview.version, action="purge"
            ),
        )
    # Restart loses the SDK's in-process extracted IDs, but durable exclusion survives.
    runtime = MemoryRuntime(memory)
    registry.get_agent("owner")._memory_runtime.service._runtime = runtime
    await bind_maintenance_runtime(registry, 7)
    assert memory.get_raw(original.id) is not None  # Native source browser still works.
    assert runtime._memory.get_raw(original.id) is None
    assert not runtime._memory.search_raw("apple")
    assert all(
        r.id != original.id for r in runtime._memory.list_raw(session_id=original.session_id)
    )
    inputs = []

    def extract(self, events, **kwargs):
        inputs.extend(e.id for e in events)
        return ExtractionResult([], failure_reason="synthetic test stops before model inference")

    monkeypatch.setattr(CandidateExtractor, "extract", extract)
    runtime.extract({"session_id": original.session_id, "incremental": False})
    assert inputs and original.id not in inputs
    assert memory.get_atom(atom.id) is None
    assert runtime.memory_search({"query": "apple"})["hits"] == []
    if not purge:
        await maintain_archive(
            registry,
            7,
            MaintenanceArchiveCommand(
                archive_id=retired.archive_id, version=preview.version, action="restore"
            ),
        )
        assert runtime._memory.get_raw(original.id).id == original.id
        assert memory.get_atom(atom.id).id == atom.id
    else:
        stored = json.loads(ws.files["zhijun/memory-maintenance.json"])["items"][0]
        assert stored["snapshot"] == {} and original.id in stored["blocked_raw_ids"]


async def archive(env, kind, target):
    registry = env[0]
    preview = await preview_maintenance(registry, 7, MaintenanceTarget(kind=kind, id=target))
    result = await maintain_memory(
        registry, 7, MaintenanceCommand(kind=kind, id=target, version=preview.version)
    )
    return preview, result


@pytest.mark.parametrize("kind", ["atom", "candidate", "raw", "entity"])
async def test_archive_restore_original_ids_and_unrelated_content(env, kind):
    registry, ws, memory, atom, entity, other, cache = env
    target = {
        "atom": atom.id,
        "candidate": atom.candidate_id,
        "raw": atom.quote_event_id,
        "entity": entity.id,
    }[kind]
    preview, result = await archive(env, kind, target)
    assert result.status == "archived" and memory.get_atom(atom.id) is None
    assert memory.get_atom(other.id).assertion == "unrelated banana"
    assert memory.backend.search_atoms("apple") == []
    cache.clear.assert_called()
    state = await read_maintenance(registry, 7)
    assert state.items[0].status == "archived"
    # Duplicate/timeout retry returns the same operation and never creates another.
    duplicate = await maintain_memory(
        registry, 7, MaintenanceCommand(kind=kind, id=target, version=preview.version)
    )
    assert duplicate.archive_id == result.archive_id
    restored = await maintain_archive(
        registry,
        7,
        MaintenanceArchiveCommand(
            archive_id=result.archive_id, version=result.version, action="restore"
        ),
    )
    assert restored.status == "restored"
    assert memory.get_atom(atom.id).assertion == "synthetic apple maintenance"
    assert memory.backend.search_atoms("apple")[0].id == atom.id
    assert memory.get_candidate(atom.candidate_id) is not None
    assert "snapshot" not in restored.model_dump()


async def test_episode_removal_invalidates_digest_and_preserves_raw(env):
    registry, _, m, atom, *_ = env
    now = datetime.now(UTC)
    episode = Episode(
        "episode",
        [atom.quote_event_id],
        now,
        "apple day",
        "apple",
        atom.quote_event_id,
        "tired",
        3,
        [],
        ["work"],
        "test",
        now,
    )
    m.backend.save_episode(episode)
    digest = DigestRecord(
        "digest",
        "daily",
        "2026-10-02",
        now,
        now + timedelta(days=1),
        "apple diary",
        ["episode"],
        "test",
        now,
        now,
    )
    m.backend.upsert_digest(digest)
    p, r = await archive(env, "episode", "episode")
    assert p.counts["digests"] == 1 and m.backend.get_episode("episode") is None
    assert m.backend.get_digest("daily", "2026-10-02") is None
    assert m.get_raw(atom.quote_event_id) is not None
    await maintain_archive(
        registry,
        7,
        MaintenanceArchiveCommand(archive_id=r.archive_id, version=r.version, action="restore"),
    )
    assert m.backend.get_episode("episode").emotion == "tired"
    assert m.backend.get_digest("daily", "2026-10-02").markdown == "apple diary"


async def test_stale_preview_fails_without_removing_newer_memory(env):
    registry, _, m, atom, *_ = env
    p = await preview_maintenance(registry, 7, MaintenanceTarget(kind="atom", id=atom.id))
    m.backend._conn.execute("UPDATE owner_atoms SET assertion=? WHERE id=?", ("changed", atom.id))
    m.backend._conn.commit()
    with pytest.raises(OctopError) as error:
        await maintain_memory(
            registry, 7, MaintenanceCommand(kind="atom", id=atom.id, version=p.version)
        )
    assert error.value.code == ErrorCode.SELF_MODEL_CONFLICT
    assert m.get_atom(atom.id).assertion == "changed"
    assert (await read_maintenance(registry, 7)).items == []


async def test_archive_write_failure_does_not_remove_native_data(env):
    registry, ws, m, atom, *_ = env
    p = await preview_maintenance(registry, 7, MaintenanceTarget(kind="atom", id=atom.id))
    ws.fail = True
    with pytest.raises(OSError):
        await maintain_memory(
            registry, 7, MaintenanceCommand(kind="atom", id=atom.id, version=p.version)
        )
    assert m.get_atom(atom.id) is not None


async def test_restore_conflict_never_overwrites_and_is_not_false_success(env):
    registry, ws, m, atom, *_ = env
    _, r = await archive(env, "atom", atom.id)
    snapshot = json.loads(ws.files["zhijun/memory-maintenance.json"])["items"][0]["snapshot"]
    # An externally restored/modified original ID must not be overwritten.
    store = NativeStore(m)
    with store.backend.transaction():
        store.restore(snapshot)
    m.backend._conn.execute(
        "UPDATE owner_atoms SET assertion=? WHERE id=?", ("new owner edit", atom.id)
    )
    m.backend._conn.commit()
    with pytest.raises(OctopError):
        await maintain_archive(
            registry,
            7,
            MaintenanceArchiveCommand(archive_id=r.archive_id, version=r.version, action="restore"),
        )
    assert m.get_atom(atom.id).assertion == "new owner edit"
    assert (await read_maintenance(registry, 7)).items[0].status == "restoring"


async def test_purge_removes_recovery_text_and_cannot_restore(env):
    registry, ws, m, atom, *_ = env
    _, r = await archive(env, "raw", atom.quote_event_id)
    result = await maintain_archive(
        registry,
        7,
        MaintenanceArchiveCommand(archive_id=r.archive_id, version=r.version, action="purge"),
    )
    assert result.status == "purged"
    assert "synthetic apple maintenance" not in ws.files["zhijun/memory-maintenance.json"]
    assert m.get_raw(atom.quote_event_id) is None
    with pytest.raises(OctopError):
        await maintain_archive(
            registry,
            7,
            MaintenanceArchiveCommand(archive_id=r.archive_id, version=r.version, action="restore"),
        )


async def test_account_application_and_active_turn_guard(env):
    registry, _, m, atom, *_ = env
    with pytest.raises(OctopError):
        await preview_maintenance(registry, 8, MaintenanceTarget(kind="atom", id=atom.id))
    registry.get_application_profile = lambda uid, app: SimpleNamespace(
        agent_id="owner", user_id=7, application_id="wanx"
    )
    with pytest.raises(OctopError):
        await preview_maintenance(registry, 7, MaintenanceTarget(kind="atom", id=atom.id))
    registry.get_application_profile = lambda uid, app: SimpleNamespace(
        agent_id="owner", user_id=7, application_id="zhijun"
    )
    p = await preview_maintenance(registry, 7, MaintenanceTarget(kind="atom", id=atom.id))
    registry.is_agent_active = lambda aid: True
    with pytest.raises(OctopError) as error:
        await maintain_memory(
            registry, 7, MaintenanceCommand(kind="atom", id=atom.id, version=p.version)
        )
    assert error.value.code == ErrorCode.AGENT_BUSY and m.get_atom(atom.id) is not None


async def test_ontology_remove_restore_and_nontext_tombstone(env):
    registry, ws, *_ = env
    doc = PersonalOntology(
        claims=[
            OntologyClaim(
                id="claim",
                kind="response",
                title="listen",
                statement="Please listen first",
                conditions="when upset",
                exceptions="",
                source_kind="self_report",
                declaration="Please listen first",
            )
        ]
    )
    await _save(ws, doc)
    _, r = await archive(env, "ontology", "claim")
    current = await _read(ws)
    assert not current.claims and current.retired
    await maintain_archive(
        registry,
        7,
        MaintenanceArchiveCommand(archive_id=r.archive_id, version=r.version, action="restore"),
    )
    current = await _read(ws)
    assert current.claims[0].id == "claim" and not current.retired


def test_postgres_adapter_scopes_every_statement():
    from octop_memory.storage.backends.postgres import PostgresMemoryBackend

    calls = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, sql, args=()):
            calls.append((sql, args))
            return self

        def fetchall(self):
            return []

        def fetchone(self):
            return {"n": 0}

    class Connection:
        def cursor(self):
            return Cursor()

        def execute(self, sql, args=()):
            return Cursor().execute(sql, args)

    backend = object.__new__(PostgresMemoryBackend)
    backend._ns = "owner"
    backend._conn = Connection()
    store = NativeStore(SimpleNamespace(backend=backend))
    store.rows("atoms")
    store.delete_row("atoms", {"id": "shared-id"})
    store.delete_row("aliases", {"alias": "User", "entity_id": "shared-id"})
    store.refresh_entities({"atoms": [{"entity_id": "shared-id"}]})
    store.restore({"raw_events": [{"id": "raw", "content": "synthetic", "payload": {}}]})
    for sql, args in calls:
        assert '"octop_memory".' in sql
        if sql.startswith("INSERT"):
            assert '"namespace"' in sql and args[-1] == "owner"
        else:
            assert "namespace = %s" in sql and args[-1] == "owner"


async def test_concurrent_archive_and_restart_recovery(env):
    import asyncio

    registry, ws, m, atom, *_ = env
    p = await preview_maintenance(registry, 7, MaintenanceTarget(kind="atom", id=atom.id))
    command = MaintenanceCommand(kind="atom", id=atom.id, version=p.version)
    results = await asyncio.gather(*(maintain_memory(registry, 7, command) for _ in range(3)))
    assert len({r.archive_id for r in results}) == 1
    assert len((await read_maintenance(registry, 7)).items) == 1
    # Simulate loss of only the final manifest write after an atomic native removal.
    payload = json.loads(ws.files["zhijun/memory-maintenance.json"])
    payload["items"][0]["status"] = "prepared"
    ws.files["zhijun/memory-maintenance.json"] = json.dumps(payload)
    registry._zhijun_ontology_locks = {}
    assert (await read_maintenance(registry, 7)).items[0].status == "archived"


async def test_missing_source_restore_is_retryable_and_never_creates_orphan(env):
    registry, _, m, atom, *_ = env
    _, r = await archive(env, "atom", atom.id)
    raw = m.get_raw(atom.quote_event_id)
    m.backend._conn.execute("DELETE FROM owner_raw_events WHERE id=?", (raw.id,))
    m.backend._conn.commit()
    with pytest.raises(OctopError):
        await maintain_archive(
            registry,
            7,
            MaintenanceArchiveCommand(archive_id=r.archive_id, version=r.version, action="restore"),
        )
    assert m.get_atom(atom.id) is None
    assert (await read_maintenance(registry, 7)).items[0].status == "archived"
