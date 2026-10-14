"""Delete a conversation's native memory before discarding its retry handle."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from octop.infra.agents.memory_maintenance import (
    MaintenanceMemoryView,
    _archives,
    _bind_runtime,
    _clear_recall,
    _purge_vectors,
    _write,
)
from octop.infra.agents.memory_maintenance_store import NativeStore, digest
from octop.infra.agents.personal_ontology import _lock, _read, _save
from octop.infra.errors import ErrorCode, OctopError


def _references(value: Any, source_ids: set[str]) -> bool:
    """Match structured provenance only, never incidental text or another user."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"event_id", "quote_event_id", "atom_id", "candidate_id"}:
                if item in source_ids:
                    return True
            elif key in {"raw_event_ids", "native_ids", "evidence_ids", "blocked_raw_ids"}:
                import json

                ids = json.loads(item) if isinstance(item, str) else item
                if set(ids or []) & source_ids:
                    return True
            elif _references(item, source_ids):
                return True
    elif isinstance(value, list):
        return any(_references(item, source_ids) for item in value)
    return False


async def _clear_projections(workspace: Any, snapshot: dict[str, Any], thread_id: str) -> None:
    archives = await _archives(workspace)
    retired = [
        item
        for item in archives
        if any(
            event.get("thread_id") == thread_id
            or (not event.get("thread_id") and event.get("session_id") == thread_id)
            for event in item.get("snapshot", {}).get("raw_events", [])
        )
    ]
    snapshots = [snapshot, *(item.get("snapshot", {}) for item in retired)]
    ids = {
        row["id"]
        for source in snapshots
        for table in ("raw_events", "atoms", "candidates", "episodes")
        for row in source.get(table, [])
    }
    if not ids:
        return
    document = await _read(workspace)
    removed = {item.id for item in document.claims if _references(item.model_dump(), ids)} | {
        item.id for item in document.nodes if _references(item.model_dump(), ids)
    }
    # Synthesis may cite an earlier interpretation rather than raw evidence.
    while True:
        dependent = {
            claim.id
            for claim in document.claims
            if set(claim.source_claim_ids + claim.context_ids) & removed
        }
        if dependent <= removed:
            break
        removed.update(dependent)
    relations = [
        item
        for item in document.relations
        if not {item.source, item.target} & removed and not set(item.evidence_ids) & ids
    ]
    links = [
        item
        for item in document.links
        if not {item.source, item.target} & removed and not set(item.evidence_ids) & ids
    ]
    if removed or relations != document.relations or links != document.links:
        document.claims = [item for item in document.claims if item.id not in removed]
        document.nodes = [item for item in document.nodes if item.id not in removed]
        document.relations = relations
        document.links = links
        document.core_operations = {
            key: value for key, value in document.core_operations.items() if key not in removed
        }
        document.outdated = True
        await _save(workspace, document)
    retained = [
        item
        for item in archives
        if item not in retired
        and item.get("id") not in ids | removed
        and not _references(item, ids)
    ]
    if retained != archives:
        # A previously archived source must not restore a deleted conversation.
        await _write(workspace, retained)


def _snapshot(memory: Any, thread_id: str) -> dict[str, Any]:
    store = NativeStore(memory)
    with store.backend.transaction():
        store.lock_transaction()
        return store.thread_snapshot(thread_id)


def _remove(memory: Any, snapshot: dict[str, Any], thread_id: str) -> None:
    # If vector removal fails the native sources remain addressable for retry.
    _purge_vectors(memory, snapshot)
    store = NativeStore(memory)
    with store.backend.transaction():
        store.lock_transaction()
        if digest(store.thread_snapshot(thread_id)) != digest(snapshot):
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        store.remove(snapshot)


async def _worker(function: Callable[..., Any], *args: Any) -> Any:
    """A cancelled HTTP request must not release locks ahead of its DB worker."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


@asynccontextmanager
async def thread_memory_cleanup(
    registry: Any, agent_id: str, thread_id: str
) -> AsyncIterator[None]:
    """Reserve the agent until memory, checkpoints and thread metadata are gone.

    Reuse the existing history mutation reservation so new chat turns wait and
    active turns fail explicitly. The extraction mutex spans source snapshots,
    workspace projections and deletion, preventing delayed model writes.
    """
    reserve = getattr(registry, "try_begin_history_backfill", None)
    reserved = callable(reserve)
    if reserved:
        assert callable(reserve)
        if not reserve(agent_id):
            raise OctopError.localized(ErrorCode.AGENT_BUSY)
    elif callable(getattr(registry, "is_agent_active", None)) and registry.is_agent_active(
        agent_id
    ):
        raise OctopError.localized(ErrorCode.AGENT_BUSY)
    try:
        harness = registry.get_agent(agent_id)
        runtime = getattr(harness, "_memory_runtime", None)
        memory = getattr(runtime, "memory", None) if runtime is not None else None
        if memory is None:
            yield
            return
        async with _lock(registry, agent_id):
            _bind_runtime(registry, agent_id, await _archives(harness.workspace))
            service_runtime = getattr(getattr(runtime, "service", None), "_runtime", None)
            view = getattr(service_runtime, "_memory", None)
            if not isinstance(view, MaintenanceMemoryView):
                raise OctopError.localized(ErrorCode.WORKSPACE_OP_UNSUPPORTED)
            # Nonblocking acquisition avoids a cancelled request leaving a worker
            # thread to acquire this mutex later with nobody available to release it.
            while not view.lock.acquire(blocking=False):
                await asyncio.sleep(0.01)
            try:
                snapshot = await _worker(_snapshot, memory, thread_id)
                await _clear_projections(harness.workspace, snapshot, thread_id)
                await _worker(_remove, memory, snapshot, thread_id)
                # Only this thread's sources are blocked; mixed-source conclusions
                # must not suppress unrelated conversations' surviving originals.
                view.blocked.update(row["id"] for row in snapshot.get("raw_events", []))
                _clear_recall(registry, agent_id)
                yield
            finally:
                view.lock.release()
    finally:
        if reserved:
            registry.end_history_backfill(agent_id)
