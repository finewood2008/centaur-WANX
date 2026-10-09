"""One model-facing recall entry and provenance policy for Zhijun."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any, Literal

from langchain_core.tools import BaseTool, tool

from octop.infra.agents.ontology_admission import admitted, pending
from octop.infra.agents.ontology_types import OntologyClaim


def recall_record(
    value: dict[str, Any],
    *,
    kind: Literal["ontology", "native", "source"] = "native",
    origin: str = "model_extraction",
    confirmed: bool = False,
) -> dict[str, Any]:
    """Native promotion is not owner confirmation or an owner declaration."""
    if kind == "ontology":
        confirmed = admitted(OntologyClaim.model_validate(value))
        declared = confirmed and value.get("source_kind") == "self_report"
        statement_kind = "user_statement" if declared else "inference"
        origin = "owner_declaration" if declared else "model_inference"
    else:
        statement_kind = "source_quote" if kind == "source" else "inference"
    if confirmed and statement_kind == "inference":
        statement_kind = "confirmed_understanding"
    return {
        **{k: v for k, v in value.items() if k != "role_hint"},
        "statement_kind": statement_kind,
        "confirmation": "user_confirmed" if confirmed else "unconfirmed",
        "evidence_origin": origin,
    }


def ontology_context_payload(value: dict[str, Any]) -> dict[str, Any]:
    """Use the same policy for automatic context and explicit recall."""
    from octop.infra.agents.ontology_graph import node_payload
    from octop.infra.agents.ontology_types import OntologyContextNode

    claims = [c for c in value["claims"] if admitted(OntologyClaim.model_validate(c))]
    ids = {c["id"] for c in claims} | {n["id"] for n in value.get("nodes", [])}
    return {
        **{
            k: v
            for k, v in value.items()
            if k
            in {
                "revision",
                "turn_id",
                "available",
                "supplied_at",
                "reply_hash",
                "user_text_hash",
                "understanding_lines",
                "candidate_discussion",
            }
        },
        "claims": [recall_record(c, kind="ontology") for c in claims],
        "nodes": [
            node_payload(OntologyContextNode.model_validate(n)) for n in value.get("nodes", [])
        ],
        "relations": [
            r
            for r in value.get("relations", [])
            if r["state"] == "confirmed" and r["source"] in ids and r["target"] in ids
        ],
        "links": [
            r
            for r in value.get("links", [])
            if (r["state"] == "confirmed" or r.get("source_kind") == "native")
            and r["source"] in ids
            and r["target"] in ids
        ],
    }


def _native_record(memory: Any, value: dict[str, Any], path: str) -> dict[str, Any]:
    parts = path.strip("/").split("/")
    source_id = parts[-1].removesuffix(".md")
    origin, confirmed = "model_extraction", False
    kind: Literal["native", "source"] = "native"
    if parts[0] in {"atom", "atoms"}:
        atom = memory.get_atom(source_id)
        candidate = memory.get_candidate(atom.candidate_id) if atom else None
        raw = memory.get_raw(candidate.quote_event_id) if candidate else None
        if raw:
            origin = str(raw.event_type)
        confirmed = bool(candidate and candidate.decided_by == "user")
    elif parts[0] in {"raw", "raw_events"}:
        kind = "source"
        raw = memory.get_raw(source_id)
        origin = str(raw.event_type) if raw else "unknown"
    return recall_record(value, kind=kind, origin=origin, confirmed=confirmed)


def build_recall_tool(
    registry: Any,
    service_for_agent: Callable[[], Any],
    memory_for_agent: Callable[[], Any],
    *,
    agent_id: str,
    user_id: int | None,
    time_zone: str = "Asia/Shanghai",
) -> BaseTool:
    from octop.infra.agents.memory.zhijun_tools import read_episode, search_episodes

    @tool
    async def zhijun_memory_recall(
        scope: Literal["memory", "episodes", "ontology"] = "memory",
        action: Literal["search", "get"] = "search",
        query: str = "",
        path: str = "",
        date_from: str | None = None,
        date_to: str | None = None,
        emotion: str | None = None,
        offset: int = 0,
        limit: int = 8,
    ) -> str:
        """Recall owned memory, episodes or personal understandings through one entry.

        For get, use a path returned by search. Episode date-only bounds include
        the whole end day in the server timezone. Paginate before summarizing.
        Respect statement_kind and confirmation: unconfirmed extraction is an
        inference, never something the owner told you. source_quote preserves
        speaker provenance; an assistant quote is not a user declaration.
        """
        from langgraph.config import get_config

        from octop.infra.agents.ontology_graph import node_payload
        from octop.infra.agents.personal_ontology import read_personal_ontology

        cfg = get_config().get("configurable") or {}
        if (
            cfg.get("agent_id") != agent_id
            or user_id is None
            or str(cfg.get("user") or "") != str(user_id)
            or cfg.get("source") in {"peer", "ask_agent", "inbox"}
        ):
            raise PermissionError("profile ownership required")
        limit, offset = max(1, min(100, limit)), max(0, offset)
        result: dict[str, Any]
        if scope == "ontology":
            doc = await read_personal_ontology(registry, user_id, check_changes=False)
            claims = [
                c
                for c in doc.claims
                if c.evidence_valid
                and (
                    admitted(c)
                    or (
                        pending(c)
                        and c.discussion_thread_id
                        and c.discussion_thread_id == str(cfg.get("thread_id") or "")
                    )
                )
                and (action != "get" or path == f"/ontology/{c.id}")
                and (not query or query in f"{c.statement} {c.conditions}")
            ]
            nodes = [
                n
                for n in doc.nodes
                if n.state == "active"
                and n.evidence_valid
                and not n.merged_into
                and (action != "get" or path == f"/ontology/context/{n.id}")
                and (not query or query in f"{n.statement} {n.conditions} {' '.join(n.aliases)}")
            ]
            page: list[tuple[str, Any]] = [("claim", c) for c in claims] + [
                ("node", n) for n in nodes
            ]
            sliced = page[offset : offset + limit]
            result = {
                "ok": True,
                "revision": doc.revision,
                "claims": [
                    recall_record(
                        {**c.model_dump(exclude={"history"}), "path": f"/ontology/{c.id}"},
                        kind="ontology",
                    )
                    for kind, c in sliced
                    if kind == "claim"
                ],
                "total": len(page),
                "has_more": offset + limit < len(page),
                "nodes": [
                    {**node_payload(n), "path": f"/ontology/context/{n.id}"}
                    for kind, n in sliced
                    if kind == "node"
                ],
            }
        elif scope == "episodes":
            if action == "get":
                if not path.startswith("/episodes/"):
                    raise ValueError("An episode path is required")
                result = await read_episode(memory_for_agent(), path.split("/")[-1])
                result["episode"] = recall_record(result["episode"])
                result["sources"] = [
                    recall_record(row, kind="source", origin=str(row.get("event_type", "unknown")))
                    for row in result["sources"]
                ]
                result["raw_events"] = result["sources"]
            else:
                result = await search_episodes(
                    memory_for_agent(),
                    query=query,
                    date_from=date_from,
                    date_to=date_to,
                    emotion=emotion,
                    offset=offset,
                    limit=limit,
                    time_zone=time_zone,
                )
                result["items"] = [recall_record(row) for row in result["items"]]
        else:
            service, memory = service_for_agent(), memory_for_agent()
            if service is None or memory is None:
                raise RuntimeError("memory is unavailable")

            def read() -> dict[str, Any]:
                if action == "get":
                    if not path:
                        raise ValueError("A memory path is required")
                    data = service.get(path)
                    if data.get("error"):
                        raise RuntimeError("memory lookup failed")
                    return {"ok": True, **_native_record(memory, {**data, "path": path}, path)}
                data = service.search(query, max_results=limit)
                if data.get("error"):
                    raise RuntimeError("memory lookup failed")
                return {
                    "ok": True,
                    **data,
                    "hits": [_native_record(memory, row, row["path"]) for row in data["hits"]],
                }

            result = await asyncio.to_thread(read)
            from octop.infra.agents.ontology_graph import current_native_record

            if registry is not None:
                doc = await read_personal_ontology(registry, user_id, check_changes=False)
                if action == "get":
                    result = current_native_record(doc, result, path)
                else:
                    result["hits"] = [
                        current_native_record(doc, row, row["path"]) for row in result["hits"]
                    ]
                    stopped_hits = [
                        row for row in result["hits"] if row.get("current_use") is False
                    ]
                    result["hits"] = [
                        row for row in result["hits"] if row.get("current_use") is not False
                    ]
                    result["excluded_stopped_count"] = len(stopped_hits)
        if scope == "episodes" and registry is not None:
            from octop.infra.agents.ontology_graph import current_native_record

            doc = await read_personal_ontology(registry, user_id, check_changes=False)
            if action == "get":
                result["episode"] = current_native_record(doc, result["episode"], path)
                result["sources"] = [
                    current_native_record(doc, row, row["path"]) for row in result["sources"]
                ]
                result["raw_events"] = result["sources"]
            else:
                result["items"] = [
                    current_native_record(doc, row, row.get("path", f"/episodes/{row['id']}"))
                    for row in result["items"]
                ]
                stopped_items = [row for row in result["items"] if row.get("current_use") is False]
                result["items"] = [
                    row for row in result["items"] if row.get("current_use") is not False
                ]
                result["excluded_stopped_count"] = len(stopped_items)
                result["total_scope"] = "native_before_excluding_stopped"
        return json.dumps(result, ensure_ascii=False)

    return zhijun_memory_recall
