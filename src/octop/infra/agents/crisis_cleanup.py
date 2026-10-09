"""Content-free, read-only preview; no purge while capture policy is unavailable."""

from __future__ import annotations

import asyncio
from typing import Any

from octop.infra.agents.disclosure import CRISIS, classify
from octop.infra.agents.memory_maintenance import _runtime
from octop.infra.agents.memory_maintenance_store import NativeStore, digest


def _preview(memory: Any, uid: int) -> dict[str, Any]:
    store = NativeStore(memory)
    with store.backend.transaction():
        raw_ids = [
            row["id"]
            for row in store.rows("raw_events")
            if str(row.get("user")) == str(uid)
            and row["event_type"] == "user_message"
            and classify(row["content"]) == CRISIS
        ]
        affected: dict[str, dict[str, dict[str, Any]]] = {}
        for raw_id in raw_ids:
            for table, rows in store.snapshot("raw", raw_id).items():
                affected.setdefault(table, {}).update({digest(row): row for row in rows})
        # Do not include source text, names, quotes, or reversible snapshots.
        return {
            "raw_event_ids": raw_ids,
            "counts": {table: len(rows) for table, rows in affected.items()},
            "version": digest(affected),
            "purge_ready": False,
            "pending": [
                "capture_policy_hook",
                "assistant_turn_pairing",
                "workspace_projections_and_archives",
                "checkpoint_jsonl_and_exported_digest_copies",
            ],
        }


async def preview_crisis_cleanup(registry: Any, uid: int) -> dict[str, Any]:
    """Inspect only the owned Zhijun namespace; never mutate real history."""
    row, _, memory = _runtime(registry, uid)
    preview = await asyncio.to_thread(_preview, memory, uid)
    return {"agent_id": row.agent_id, **preview}
