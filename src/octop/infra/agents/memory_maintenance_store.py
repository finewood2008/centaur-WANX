"""Version-pinned native memory maintenance adapter; no new memory schema.

octop-memory 1.x exposes deprecation but not reversible removal. Keep the
backend-specific operations here, including PostgreSQL namespace predicates.
Snapshots are stored by the caller through BackendWorkspace, never in this DB.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any

from octop.infra.errors import ErrorCode, OctopError

TABLES = (
    "raw_events",
    "entities",
    "aliases",
    "candidates",
    "atoms",
    "entity_pages",
    "thread_active_entities",
    "memory_nodes",
    "episodes",
    "digests",
    "journal",
)
TARGETS = {
    "raw": "raw_events",
    "atom": "atoms",
    "episode": "episodes",
    "candidate": "candidates",
    "entity": "entities",
}
KEYS = {"aliases": ("alias", "entity_id"), "thread_active_entities": ("thread_id", "entity_id")}
GENERATED = {"namespace", "fts_tsv", "content_tsv"}


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def _json(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json(v) for v in value]
    return value


def _ids(value: Any) -> set[str]:
    if isinstance(value, str):
        value = json.loads(value or "[]")
    return set(value or [])


def _metadata(value: Any) -> dict[str, Any]:
    return json.loads(value or "{}") if isinstance(value, str) else (value or {})


class NativeStore:
    def __init__(self, memory: Any):
        from octop_memory.storage.backends.sqlite import SqliteMemoryBackend

        self.backend = memory.backend
        self.pg = False
        if not isinstance(self.backend, SqliteMemoryBackend):
            from octop_memory.storage.backends.postgres import PostgresMemoryBackend

            if not isinstance(self.backend, PostgresMemoryBackend):
                raise OctopError.localized(ErrorCode.WORKSPACE_OP_UNSUPPORTED)
            self.pg = True
        self.ns = self.backend._ns

    def table(self, name: str) -> str:
        assert name in TABLES
        return f'"octop_memory"."{name}"' if self.pg else f'"{self.ns}_{name}"'

    def rows(self, name: str) -> list[dict[str, Any]]:
        query = f"SELECT * FROM {self.table(name)}"
        params: tuple[Any, ...] = ()
        if self.pg:
            query += " WHERE namespace = %s"
            params = (self.ns,)
        with self.backend._conn.cursor() if self.pg else _Cursor(self.backend._conn) as cur:
            cur.execute(query, params)
            return [
                {k: _json(v) for k, v in dict(row).items() if k not in GENERATED}
                for row in cur.fetchall()
            ]

    def snapshot(self, kind: str, target: str) -> dict[str, list[dict[str, Any]]]:
        rows = {name: self.rows(name) for name in TABLES}
        table = TARGETS[kind]
        chosen: dict[str, list[dict[str, Any]]] = {name: [] for name in TABLES}
        chosen[table] = [r for r in rows[table] if r["id"] == target]
        if not chosen[table]:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        raw = {target} if kind == "raw" else set()
        entity = {target} if kind == "entity" else set()
        # An atom's promoted candidate must also leave the active store, otherwise
        # re-promotion could recreate the removed conclusion from the same draft.
        candidate = {r["candidate_id"] for r in chosen["atoms"]}
        candidate.update({target} if kind == "candidate" else set())
        chosen["candidates"] = [
            r
            for r in rows["candidates"]
            if (
                r["id"] in candidate
                or r["target_entity_id"] in entity
                or bool(_ids(r["raw_event_ids"]) & raw)
                or r["quote_event_id"] in raw
            )
        ]
        candidate.update(r["id"] for r in chosen["candidates"])
        chosen["atoms"] = [
            r
            for r in rows["atoms"]
            if (
                (kind == "atom" and r["id"] == target)
                or r["entity_id"] in entity
                or r["candidate_id"] in candidate
                or bool(_ids(r["raw_event_ids"]) & raw)
                or r["quote_event_id"] in raw
            )
        ]
        atoms = {r["id"] for r in chosen["atoms"]}
        chosen["episodes"] = [
            r
            for r in rows["episodes"]
            if (
                (kind == "episode" and r["id"] == target)
                or bool(_ids(r["raw_event_ids"]) & raw)
                or r["quote_event_id"] in raw
            )
        ]
        episodes = {r["id"] for r in chosen["episodes"]}
        chosen["digests"] = [r for r in rows["digests"] if _ids(r["episode_ids"]) & episodes]
        chosen["memory_nodes"] = [
            r
            for r in rows["memory_nodes"]
            if r["atom_id"] in atoms or _metadata(r["metadata"]).get("entity_id") in entity
        ]
        chosen["journal"] = [
            r
            for r in rows["journal"]
            if (
                r["target_atom_id"] in atoms
                or r["target_candidate_id"] in candidate
                or r["target_entity_id"] in entity
            )
        ]
        for name in ("aliases", "entity_pages", "thread_active_entities"):
            chosen[name] = [r for r in rows[name] if r["entity_id"] in entity]
        return {
            name: sorted(items, key=lambda r: digest(r)) for name, items in chosen.items() if items
        }

    def remove(self, snapshot: dict[str, list[dict[str, Any]]]) -> None:
        for name in reversed(TABLES):
            for row in snapshot.get(name, []):
                self.delete_row(name, row)
        self.refresh_entities(snapshot)

    def delete_row(self, name: str, row: dict[str, Any]) -> None:
        keys = KEYS.get(name, ("id",))
        params = [row[k] for k in keys]
        ph = "%s" if self.pg else "?"
        where = " AND ".join(f'"{key}" = {ph}' for key in keys)
        if self.pg:
            where += " AND namespace = %s"
            params.append(self.ns)
        self.backend._conn.execute(f"DELETE FROM {self.table(name)} WHERE {where}", params)

    def restore(self, snapshot: dict[str, list[dict[str, Any]]]) -> None:
        # Refuse all conflicts before the first insert; never overwrite newer data.
        for name, rows in snapshot.items():
            keys = KEYS.get(name, ("id",))
            existing = {tuple(r[k] for k in keys) for r in self.rows(name)}
            if any(tuple(r[k] for k in keys) in existing for r in rows):
                raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        current_entities = self.rows("entities")
        if any(
            r["entity_type"] == e["entity_type"] and r["canonical_name"] == e["canonical_name"]
            for r in snapshot.get("entities", [])
            for e in current_entities
        ):
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        entity_ids = {r["id"] for r in current_entities + snapshot.get("entities", [])}
        node_ids = {r["id"] for r in self.rows("memory_nodes") + snapshot.get("memory_nodes", [])}
        raw_ids = {r["id"] for r in self.rows("raw_events") + snapshot.get("raw_events", [])}
        if (
            any(r["entity_id"] not in entity_ids for r in snapshot.get("atoms", []))
            or any(
                r["parent_id"] and r["parent_id"] not in node_ids
                for r in snapshot.get("memory_nodes", [])
            )
            or any(
                not _ids(r["raw_event_ids"]).issubset(raw_ids)
                for name in ("atoms", "candidates", "episodes")
                for r in snapshot.get(name, [])
            )
        ):
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        for name in TABLES:
            for row in snapshot.get(name, []):
                values = dict(row)
                if self.pg:
                    from psycopg.types.json import Jsonb

                    values = {
                        k: Jsonb(v) if isinstance(v, (dict, list)) else v for k, v in values.items()
                    }
                    values["namespace"] = self.ns
                cols = ", ".join(f'"{key}"' for key in values)
                ph = ", ".join(["%s" if self.pg else "?"] * len(values))
                self.backend._conn.execute(
                    f"INSERT INTO {self.table(name)} ({cols}) VALUES ({ph})", list(values.values())
                )
        self.refresh_entities(snapshot)

    def refresh_entities(self, snapshot: dict[str, list[dict[str, Any]]]) -> None:
        # A cached summary can contain removed assertions. Blank it immediately;
        # native regeneration will rebuild it from the remaining active atoms.
        entities = {r["entity_id"] for r in snapshot.get("atoms", [])}
        ph = "%s" if self.pg else "?"
        scope = " AND namespace = %s" if self.pg else ""
        for entity in entities:
            args = [entity, self.ns] if self.pg else [entity]
            count = self.backend._conn.execute(
                f"SELECT COUNT(*) AS n FROM {self.table('atoms')} WHERE entity_id = {ph} AND deprecated_at IS NULL{scope}",
                args,
            ).fetchone()["n"]
            self.backend._conn.execute(
                f"UPDATE {self.table('entities')} SET atom_count = {ph} WHERE id = {ph}{scope}",
                [count, *args],
            )
            self.backend._conn.execute(
                f"UPDATE {self.table('entity_pages')} SET summary_markdown = '', headline = '', dirty = {ph} WHERE entity_id = {ph}{scope}",
                [True if self.pg else 1, *args],
            )

    def lock_transaction(self) -> None:
        if self.pg:
            # Prevent concurrent native inserts from escaping a dependency snapshot.
            # The lock lasts only this local maintenance transaction, never model IO.
            tables = ", ".join(self.table(name) for name in TABLES)
            self.backend._conn.execute(f"LOCK TABLE {tables} IN SHARE ROW EXCLUSIVE MODE")

    def recovery_state(self, snapshot: dict[str, list[dict[str, Any]]]) -> str:
        matches = 0
        present = 0
        total = sum(len(items) for items in snapshot.values())
        for name, items in snapshot.items():
            keys = KEYS.get(name, ("id",))
            existing = {tuple(r[k] for k in keys): r for r in self.rows(name)}
            for row in items:
                current = existing.get(tuple(row[k] for k in keys))
                if current is not None:
                    present += 1
                    # Native refresh deliberately clears stale summaries/counts.
                    ignored = {"atom_count"} if name == "entities" else set()
                    if name == "entity_pages":
                        ignored = {"summary_markdown", "headline", "dirty"}
                    if digest({k: v for k, v in row.items() if k not in ignored}) == digest(
                        {k: v for k, v in current.items() if k not in ignored}
                    ):
                        matches += 1
        return "absent" if present == 0 else "restored" if matches == total else "unknown"


class _Cursor:
    def __init__(self, conn: Any):
        self.cur = conn.cursor()

    def __enter__(self) -> Any:
        return self.cur

    def __exit__(self, *args: Any) -> None:
        self.cur.close()
