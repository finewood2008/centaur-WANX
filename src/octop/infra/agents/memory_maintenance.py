"""Owner-operated archive and removal of isolated Zhijun memory."""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import nullcontext
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from octop.infra.agents.memory_maintenance_store import NativeStore, digest
from octop.infra.agents.personal_ontology import _lock, _owned, _read, _save
from octop.infra.errors import ErrorCode, OctopError

Kind = Literal["raw", "atom", "episode", "candidate", "entity", "ontology"]
_PATH = "zhijun/memory-maintenance.json"


class MaintenanceTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    id: str = Field(min_length=1, max_length=200)


class MaintenanceCommand(MaintenanceTarget):
    version: str = Field(description="Exact preview version; rejects changed content.")
    action: Literal["archive", "purge"] = "archive"


class MaintenanceArchiveCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archive_id: str
    version: str
    action: Literal["restore", "purge"]


class MaintenancePreview(MaintenanceTarget):
    title: str
    content: str = ""
    version: str
    counts: dict[str, int]


class MaintenanceRecord(MaintenancePreview):
    model_config = ConfigDict(extra="ignore")
    archive_id: str
    at: str
    status: Literal["prepared", "archived", "restoring", "restored", "purged"]


class MaintenanceState(BaseModel):
    items: list[MaintenanceRecord] = Field(default_factory=list)


def _runtime(registry: Any, uid: int) -> tuple[Any, Any, Any]:
    row = _owned(registry, uid)
    harness = registry.get_agent(row.agent_id)
    if harness is None or getattr(harness, "_memory_runtime", None) is None:
        raise OctopError.localized(ErrorCode.AGENT_NOT_RUNNING)
    return row, harness.workspace, harness._memory_runtime.memory


async def _archives(workspace: Any) -> list[dict[str, Any]]:
    text = await workspace.aread_text(_PATH)
    return json.loads(text).get("items", []) if text else []


async def _write(workspace: Any, items: list[dict[str, Any]]) -> None:
    text = json.dumps({"schema": 1, "items": items}, ensure_ascii=False, sort_keys=True)
    await workspace.aupload_bytes(_PATH, text.encode())
    if await workspace.aread_text(_PATH) != text:
        raise OctopError.localized(ErrorCode.INTERNAL_ERROR)


def _native_snapshot(memory: Any, kind: str, target: str) -> dict[str, Any]:
    store = NativeStore(memory)
    with store.backend.transaction():
        return store.snapshot(kind, target)


async def _snapshot(workspace: Any, memory: Any, target: MaintenanceTarget) -> dict[str, Any]:
    if target.kind != "ontology":
        return await asyncio.to_thread(_native_snapshot, memory, target.kind, target.id)
    doc = await _read(workspace)
    claim = next((c for c in doc.claims if c.id == target.id), None)
    if claim is None:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return {
        "ontology": [claim.model_dump()],
        "relations": [r.model_dump() for r in doc.relations if target.id in {r.source, r.target}],
    }


def _preview(target: MaintenanceTarget, snapshot: dict[str, Any]) -> MaintenancePreview:
    table = {
        "raw": "raw_events",
        "atom": "atoms",
        "episode": "episodes",
        "candidate": "candidates",
        "entity": "entities",
        "ontology": "ontology",
    }[target.kind]
    row = next(r for r in snapshot[table] if r["id"] == target.id)
    content = str(
        next(
            (
                row[k]
                for k in ("statement", "assertion", "summary", "canonical_name", "content")
                if row.get(k)
            ),
            target.id,
        )
    )
    return MaintenancePreview(
        **target.model_dump(),
        title=content[:240],
        content=content,
        version=digest(snapshot),
        counts={k: len(v) for k, v in snapshot.items() if v},
    )


async def preview_maintenance(
    registry: Any, uid: int, target: MaintenanceTarget
) -> MaintenancePreview:
    row, workspace, memory = _runtime(registry, uid)
    async with _lock(registry, row.agent_id):
        return _preview(target, await _snapshot(workspace, memory, target))


async def _reconcile(workspace: Any, memory: Any, items: list[dict[str, Any]]) -> None:
    changed = False
    for item in items:
        if item["status"] not in {"prepared", "restoring"}:
            continue
        present = True
        try:
            await _snapshot(
                workspace,
                memory,
                MaintenanceTarget.model_validate({k: item[k] for k in ("kind", "id")}),
            )
        except OctopError as error:
            if error.code != ErrorCode.NOT_FOUND:
                raise
            present = False
        state = "restored" if present else "absent"
        if item["kind"] != "ontology":
            state = await asyncio.to_thread(NativeStore(memory).recovery_state, item["snapshot"])
        elif present and item["status"] == "restoring":
            current = await _snapshot(
                workspace, memory, MaintenanceTarget(kind="ontology", id=item["id"])
            )
            if digest(current) != item["version"]:
                state = "unknown"
        if item["status"] == "prepared" and state == "absent":
            item["status"] = "archived"
            changed = True
        elif item["status"] == "restoring" and state == "restored":
            item["status"] = "restored"
            item["snapshot"] = {}
            changed = True
        elif item["status"] == "restoring" and state == "absent":
            item["status"] = "archived"
            changed = True
    if changed:
        await _write(workspace, items)


async def read_maintenance(registry: Any, uid: int) -> MaintenanceState:
    row, workspace, memory = _runtime(registry, uid)
    async with _lock(registry, row.agent_id):
        items = await _archives(workspace)
        await _reconcile(workspace, memory, items)
        return MaintenanceState(items=[MaintenanceRecord.model_validate(i) for i in items])


def _mutate_native(
    memory: Any,
    kind: str,
    target: str,
    version: str,
    snapshot: dict[str, Any],
    restore: bool = False,
    view: Any = None,
) -> None:
    store = NativeStore(memory)
    with view.lock if isinstance(view, MaintenanceMemoryView) else nullcontext():
        with store.backend.transaction():
            store.lock_transaction()
            if restore:
                store.restore(snapshot)
            else:
                if digest(store.snapshot(kind, target)) != version:
                    raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
                store.remove(snapshot)
        if isinstance(view, MaintenanceMemoryView) and not restore:
            view.blocked.update(_source_ids(snapshot))


def _clear_recall(registry: Any, aid: str) -> None:
    service = getattr(registry.get_agent(aid)._memory_runtime, "service", None)
    runtime = getattr(service, "_runtime", None)
    cache = getattr(runtime, "_recall_cache", None)
    if cache is not None:
        cache.clear()


def _source_ids(snapshot: dict[str, Any]) -> list[str]:
    ids = {r["id"] for r in snapshot.get("raw_events", [])}
    for table in ("atoms", "candidates", "episodes"):
        for row in snapshot.get(table, []):
            value = row.get("raw_event_ids") or []
            ids.update(json.loads(value) if isinstance(value, str) else value)
            if row.get("quote_event_id"):
                ids.add(row["quote_event_id"])
    return sorted(ids)


class MaintenanceMemoryView:
    """Exclude retired sources from model recall and repeated extraction.

    The native dashboard still reads the original memory, so retained sources
    remain inspectable. Only the Agent's service runtime uses this view.
    """

    def __init__(self, memory: Any, blocked: set[str]) -> None:
        self.memory = memory
        self.blocked = blocked
        self.lock = threading.Lock()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.memory, name)

    def list_raw(self, **kwargs: Any) -> list[Any]:
        return [r for r in self.memory.list_raw(**kwargs) if r.id not in self.blocked]

    def search_raw(self, query: str, **kwargs: Any) -> list[Any]:
        return [r for r in self.memory.search_raw(query, **kwargs) if r.id not in self.blocked]

    def get_raw(self, event_id: str) -> Any:
        return None if event_id in self.blocked else self.memory.get_raw(event_id)


def _bind_runtime(registry: Any, aid: str, items: list[dict[str, Any]]) -> None:
    service = getattr(registry.get_agent(aid)._memory_runtime, "service", None)
    runtime = getattr(service, "_runtime", None)
    if runtime is None:
        return
    blocked = {
        source
        for item in items
        if item["status"] != "restored"
        for source in item.get("blocked_raw_ids", _source_ids(item.get("snapshot", {})))
    }
    view = getattr(runtime, "_memory", None)
    if isinstance(view, MaintenanceMemoryView):
        view.blocked = blocked
    elif view is not None:
        view = MaintenanceMemoryView(view, blocked)
        runtime._memory = view
        extract = runtime.extract

        def guarded_extract(params: dict[str, Any]) -> Any:
            with view.lock:
                return extract(params)

        runtime.extract = guarded_extract
    _clear_recall(registry, aid)


async def bind_maintenance_runtime(registry: Any, uid: int) -> None:
    row, workspace, _memory = _runtime(registry, uid)
    _bind_runtime(registry, row.agent_id, await _archives(workspace))


def _purge_vectors(memory: Any, snapshot: dict[str, Any]) -> None:
    index = getattr(memory, "_vector_index", None)
    if index is not None:
        for atom in snapshot.get("atoms", []):
            index.delete(atom["id"])


async def _mutate_ontology(workspace: Any, item: dict[str, Any], restore: bool) -> None:
    from octop.infra.agents.ontology_types import OntologyClaim, OntologyRelation

    doc = await _read(workspace)
    target = item["id"]
    if restore:
        if any(c.id == target for c in doc.claims):
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        doc.claims.append(OntologyClaim.model_validate(item["snapshot"]["ontology"][0]))
        doc.relations.extend(
            OntologyRelation.model_validate(r)
            for r in item["snapshot"]["relations"]
            if r["source"] in {c.id for c in doc.claims}
            and r["target"] in {c.id for c in doc.claims}
        )
        doc.retired = [r for r in doc.retired if r.get("archive_id") != item["archive_id"]]
    else:
        fresh = await _snapshot(workspace, None, MaintenanceTarget(kind="ontology", id=target))
        if digest(fresh) != item["version"]:
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        claim = fresh["ontology"][0]
        doc.retired.append(
            {
                "archive_id": item["archive_id"],
                "kind": claim["kind"],
                "evidence_ids": [e["atom_id"] for e in claim["evidence"]],
                "statement_hash": digest(claim["statement"]),
            }
        )
        doc.claims = [c for c in doc.claims if c.id != target]
        doc.relations = [r for r in doc.relations if target not in {r.source, r.target}]
    await _save(workspace, doc)


async def maintain_memory(
    registry: Any, uid: int, command: MaintenanceCommand
) -> MaintenanceRecord:
    row, workspace, memory = _runtime(registry, uid)
    if callable(getattr(registry, "is_agent_active", None)) and registry.is_agent_active(
        row.agent_id
    ):
        raise OctopError.localized(ErrorCode.AGENT_BUSY)
    async with _lock(registry, row.agent_id):
        items = await _archives(workspace)
        await _reconcile(workspace, memory, items)
        _bind_runtime(registry, row.agent_id, items)
        view = getattr(
            registry.get_agent(row.agent_id)._memory_runtime.service._runtime, "_memory", None
        )
        archive_id = digest([row.agent_id, command.kind, command.id, command.version])[:32]
        item = next((i for i in items if i["archive_id"] == archive_id), None)
        if item is None or item["status"] in {"restored", "prepared"}:
            target = MaintenanceTarget(kind=command.kind, id=command.id)
            snapshot = await _snapshot(workspace, memory, target)
            preview = _preview(target, snapshot)
            if preview.version != command.version:
                raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
            new_item = {
                **preview.model_dump(),
                "archive_id": archive_id,
                "at": datetime.now(UTC).isoformat(),
                "status": "prepared",
                "snapshot": snapshot,
                "blocked_raw_ids": _source_ids(snapshot),
            }
            items = [i for i in items if i["archive_id"] != archive_id] + [new_item]
            item = new_item
            await _write(workspace, items)  # Durable backup precedes native removal.
            if command.kind == "ontology":
                await _mutate_ontology(workspace, item, False)
            else:
                await asyncio.to_thread(
                    _mutate_native,
                    memory,
                    command.kind,
                    command.id,
                    command.version,
                    snapshot,
                    False,
                    view,
                )
            item["status"] = "archived"
        if command.action == "purge" and item["status"] == "archived":
            await asyncio.to_thread(_purge_vectors, memory, item["snapshot"])
            item.update(snapshot={}, title="", content="", counts={}, status="purged")
        await _write(workspace, items)
        _bind_runtime(registry, row.agent_id, items)
        return MaintenanceRecord.model_validate(item)


async def maintain_archive(
    registry: Any, uid: int, command: MaintenanceArchiveCommand
) -> MaintenanceRecord:
    row, workspace, memory = _runtime(registry, uid)
    if callable(getattr(registry, "is_agent_active", None)) and registry.is_agent_active(
        row.agent_id
    ):
        raise OctopError.localized(ErrorCode.AGENT_BUSY)
    async with _lock(registry, row.agent_id):
        items = await _archives(workspace)
        await _reconcile(workspace, memory, items)
        _bind_runtime(registry, row.agent_id, items)
        view = getattr(
            registry.get_agent(row.agent_id)._memory_runtime.service._runtime, "_memory", None
        )
        item = next((i for i in items if i["archive_id"] == command.archive_id), None)
        if item is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if item["version"] != command.version:
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        if command.action == "purge" and item["status"] in {"archived", "purged"}:
            await asyncio.to_thread(_purge_vectors, memory, item["snapshot"])
            item.update(snapshot={}, title="", content="", counts={}, status="purged")
        elif command.action == "restore" and item["status"] in {"archived", "restoring"}:
            item["status"] = "restoring"
            await _write(workspace, items)
            if item["kind"] == "ontology":
                await _mutate_ontology(workspace, item, True)
            else:
                await asyncio.to_thread(
                    _mutate_native,
                    memory,
                    item["kind"],
                    item["id"],
                    item["version"],
                    item["snapshot"],
                    True,
                    view,
                )
            item.update(snapshot={}, status="restored")
        elif not (command.action == "restore" and item["status"] == "restored"):
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        await _write(workspace, items)
        _bind_runtime(registry, row.agent_id, items)
        return MaintenanceRecord.model_validate(item)
