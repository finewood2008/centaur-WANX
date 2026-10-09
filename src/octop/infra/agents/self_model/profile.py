"""Read-only visual projection of the existing memory system, with source types."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

GROUPS = (
    "about_me",
    "current_focus",
    "told_me",
    "entities",
    "emotions",
)


def source_section(memory: Any, atom: Any) -> str:
    candidate = memory.get_candidate(atom.candidate_id)
    kind = candidate.candidate_type if candidate else None
    if kind == "Preference":
        return "about_me"
    if kind in {"Fact", "Decision"}:
        return "told_me"
    if kind == "Task" and atom.created_at >= datetime.now(UTC) - timedelta(days=7):
        return "current_focus"
    return "unassigned"


def profile_projection(memory: Any) -> dict[str, Any]:
    from octop_memory.application import dashboard_data as data

    # Public handlers retain the memory system's own filtering and serialization.
    # Explicit coverage prevents a bounded visual window being mistaken for all data.
    coverage: dict[str, Any] = {}

    def items(kind: str, handler: Any, **params: Any) -> list[dict[str, Any]]:
        result = handler(memory, {"limit": 500, **params})
        coverage[kind] = {
            "shown": len(result["items"]),
            "total": result["total"],
            "has_more": result["has_more"],
        }
        return list(result["items"])

    memories = []
    for atom in items("memory", data.list_atoms):
        source = memory.get_atom(atom["id"])
        memories.append({**atom, "section": source_section(memory, source)})
    entities = items("entity", data.list_entities)
    records = []
    for kind, section, handler in (
        ("episode", "emotions", data.list_episodes),
        ("pending", "pending", data.list_candidates),
    ):
        for row in items(kind, handler):
            if kind == "pending" and row.get("status") not in {
                "pending",
                "needs_review",
                "conflict",
            }:
                continue
            records.append(
                {
                    "id": f"{kind}:{row['id']}",
                    "source_id": row["id"],
                    "node_kind": kind,
                    "section": (
                        {
                            "Preference": "about_me",
                            "Task": "current_focus",
                            "Fact": "told_me",
                            "Decision": "told_me",
                        }.get(row.get("candidate_type", ""), "unassigned")
                        if kind == "pending"
                        else section
                    ),
                    "content": row.get("summary")
                    or row.get("assertion")
                    or row.get("content")
                    or row.get("target_summary")
                    or row.get("note")
                    or row.get("action")
                    or "",
                    "quote": row.get("verbatim_quote")
                    or (row.get("content", "") if kind == "raw" else ""),
                    "timestamp": row.get("occurred_at")
                    or row.get("timestamp")
                    or row.get("created_at"),
                    "emotion": row.get("emotion"),
                    "intensity": row.get("intensity"),
                    "people": row.get("people", []),
                    "topics": row.get("topics", []),
                    "entity_id": row.get("target_entity_id"),
                    "action": row.get("action"),
                    "status": row.get("status"),
                }
            )
    return {
        "groups": list(GROUPS),
        "memories": memories,
        "entities": entities,
        "records": records,
        "coverage": coverage,
        "counts": data.stats_counts(memory, {}),
        "error": None,
    }


def source_documents(profile: dict[str, Any]) -> list[dict[str, Any]]:
    """Canonical source identities shared by radar, reflection and correction checks."""
    return [
        *[
            {
                "id": f"memory:{m['id']}",
                "content": m["assertion"],
                "section": m["section"],
                "quote": m["verbatim_quote"],
                "timestamp": m["created_at"],
                "node_kind": "memory",
            }
            for m in profile.get("memories", [])
        ],
        *[
            {
                "id": f"entity:{e['id']}",
                "content": e["canonical_name"],
                "section": "entities",
                "node_kind": "entity",
                "entity_type": e["entity_type"],
            }
            for e in profile.get("entities", [])
        ],
        *profile.get("records", []),
    ]
