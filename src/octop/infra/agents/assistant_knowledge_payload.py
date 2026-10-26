"""Small model-facing views of already-authorized, protected Starlink results."""

from __future__ import annotations

import json
from typing import Any

MAX_REPLY_BYTES = 20_000


def _pick(value: dict[str, Any], keys: str) -> dict[str, Any]:
    return {k: value[k] for k in keys.split() if k in value}


def _locator(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    output = _pick(value, "page slide sheet cell row column paragraph line bbox")
    positions: list[dict[str, Any]] = []
    for segment in value.get("source_segments", []):
        position = _pick(segment.get("locator", {}), "page slide sheet cell paragraph line")
        if not position:
            continue
        existing = next(
            (p for p in positions if all(p.get(k) == v for k, v in position.items())), None
        )
        if existing is None:
            positions.append(position)
            existing = position
        start, end = segment.get("chunk_char_start"), segment.get("chunk_char_end")
        if isinstance(start, int) and isinstance(end, int):
            existing["char_start"] = min(existing.get("char_start", start), start)
            existing["char_end"] = max(existing.get("char_end", end), end)
    if positions:
        output["positions"] = positions[:20]
        if len(positions) > 20:
            output["positions_truncated"] = True
    return output


def _item(value: dict[str, Any], offset: int, length: int) -> dict[str, Any]:
    output = _pick(
        value,
        "id evidence_id document_id document_name original_name document_format status "
        "size_bytes segment_count score char_start char_end sensitive_status evidence_kind "
        "entity_id entity_type canonical_name subject_entity_id object_entity_id relation_type "
        "fact_id properties_json aliases_json",
    )
    if value.get("locator"):
        output["locator"] = _locator(value["locator"])
    if isinstance(value.get("evidence"), list):
        output["evidence"] = [_item(evidence, 0, length) for evidence in value["evidence"][:3]]
        if len(value["evidence"]) > 3:
            output["evidence_truncated"] = True
    for key in ("text", "excerpt"):
        if isinstance(value.get(key), str):
            text = value[key]
            output[key] = text[offset : offset + length]
            if offset or len(text) > length:
                output["text_offset"] = offset
                output["text_total"] = len(text)
                output["text_truncated"] = offset > 0 or offset + length < len(text)
                if offset + length < len(text):
                    output["next_offset"] = offset + length
    return output


def compact_knowledge(
    value: dict[str, Any], operation: str, *, offset: int = 0, length: int = 2000
) -> dict[str, Any]:
    """Keep excerpts/citations; leave exact provenance and full previews with Starlink.

    Do not re-query, cache authorization, or alter masking. A large result must
    remain visibly partial, rather than turning omitted matches into no matches.
    """
    output: dict[str, Any] = {
        "warehouses": [],
        "unavailable": value.get("unavailable", []),
        "assistant_knowledge_sources": [],
    }
    for group in value.get("warehouses", []):
        raw = group["result"]
        result = _pick(raw, "id name query total offset limit has_more graph_warning")
        if operation == "evidence":
            result.update(_item(raw, offset, length))
        for key in ("items", "nodes", "edges"):
            if isinstance(raw.get(key), list):
                result[key] = [_item(row, 0, length) for row in raw[key]]
        if "graph" in raw:
            result["graph_available"] = True
        if isinstance(raw.get("sensitive"), dict):
            result["sensitive"] = _pick(
                raw["sensitive"], "enabled withheld pending_fields incomplete"
            )
        output["warehouses"].append({"warehouse": group["warehouse"], "result": result})

    def sources() -> None:
        ids = {
            (group["warehouse"]["id"], row.get("evidence_id") or row.get("id"))
            for group in output["warehouses"]
            for row in group["result"].get("items", [])
        }
        output["assistant_knowledge_sources"] = []
        for source in value.get("assistant_knowledge_sources", []):
            if (source.get("warehouse_id"), source.get("evidence_id")) not in ids:
                continue
            entry = _pick(
                source, "warehouse_id warehouse_name evidence_id document_id document_name"
            )
            if source.get("locator"):
                entry["locator"] = _locator(source["locator"])
            output["assistant_knowledge_sources"].append(entry)

    sources()
    while len(json.dumps(output, ensure_ascii=False, indent=2).encode()) > MAX_REPLY_BYTES:
        collections = [
            (group["result"], key)
            for group in output["warehouses"]
            for key in ("items", "nodes", "edges")
            if group["result"].get(key)
        ]
        output["truncated"] = True
        if not collections:
            output["warehouses"].pop()
            output["omitted_warehouses"] = output.get("omitted_warehouses", 0) + 1
        else:
            result, key = max(collections, key=lambda pair: len(str(pair[0][pair[1]])))
            result[key].pop()
            result["has_more"] = True
            if operation == "documents":
                result["next_offset"] = result.get("offset", 0) + len(result[key])
        sources()
    return output
