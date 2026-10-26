"""Model payload size must not require reading offloaded provenance files."""

from __future__ import annotations

import copy
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from octop.infra.agents.assistant_knowledge_mcp import build_mcp
from octop.infra.agents.assistant_knowledge_payload import MAX_REPLY_BYTES, compact_knowledge


def payload(count: int = 5, text: str = "[MASKED] 合成原文。") -> dict:
    locator = {
        "source_segments": [
            {"canonical_hash": "x" * 500, "locator": {"slide": n % 7 + 1, "shape": str(n)}}
            for n in range(66)
        ]
    }
    return {
        "warehouses": [
            {
                "warehouse": {"id": "warehouse-a", "name": "合成资料"},
                "result": {
                    "query": "合成问题",
                    "index": {"internal": "x" * 5000},
                    "items": [
                        {
                            "id": str(n),
                            "original_name": "合成材料.pptx",
                            "text": text,
                            "locator": locator,
                            "sensitive_status": "masked",
                        }
                        for n in range(count)
                    ],
                    "graph": {"nodes": [{"internal": "x" * 5000}]},
                    "sensitive": {
                        "enabled": True,
                        "withheld": 2,
                        "incomplete": True,
                        "confirmation_token": "must-never-reach-the-model",
                    },
                },
            }
        ],
        "assistant_knowledge_sources": [
            {
                "warehouse_id": "warehouse-a",
                "warehouse_name": "合成资料",
                "evidence_id": str(n),
                "document_name": "合成材料.pptx",
                "locator": locator,
            }
            for n in range(count)
        ],
        "unavailable": [{"warehouse_id": "warehouse-b", "code": "ASSISTANT_KNOWLEDGE_DENIED"}],
    }


def test_compact_search_keeps_quotes_ranking_masking_and_citations() -> None:
    raw = payload()
    before = copy.deepcopy(raw)
    result = compact_knowledge(raw, "search")
    body = result["warehouses"][0]["result"]
    assert [r["id"] for r in body["items"]] == [str(n) for n in range(5)]
    assert body["items"][0]["text"] == "[MASKED] 合成原文。"
    assert body["items"][0]["sensitive_status"] == "masked"
    assert body["items"][0]["locator"] == {"positions": [{"slide": n} for n in range(1, 8)]}
    assert body["sensitive"] == {"enabled": True, "withheld": 2, "incomplete": True}
    assert "index" not in body and "graph" not in body and body["graph_available"]
    assert result["unavailable"] == raw["unavailable"]
    assert [s["evidence_id"] for s in result["assistant_knowledge_sources"]] == [
        str(n) for n in range(5)
    ]
    assert len(json.dumps(result, ensure_ascii=False, indent=2).encode()) < 8000
    assert raw == before


def test_budget_is_explicit_partial_and_only_keeps_returned_citations() -> None:
    result = compact_knowledge(payload(50, "证据" * 2000), "search")
    body = result["warehouses"][0]["result"]
    assert result["truncated"] and body["has_more"]
    assert 0 < len(body["items"]) < 50
    assert body["items"][0]["text_truncated"]
    assert body["items"][0]["next_offset"] == 2000
    assert {s["evidence_id"] for s in result["assistant_knowledge_sources"]} == {
        r["id"] for r in body["items"]
    }
    assert len(json.dumps(result, ensure_ascii=False, indent=2).encode()) <= MAX_REPLY_BYTES


def test_evidence_pages_reassemble_exact_protected_excerpt() -> None:
    text = "[MASKED] " + "合成证据正文。" * 50
    raw = {"warehouses": [{"warehouse": {"id": "a"}, "result": {"id": "proof-a", "excerpt": text}}]}
    chunks = []
    offset = 0
    while True:
        page = compact_knowledge(raw, "evidence", offset=offset, length=37)["warehouses"][0][
            "result"
        ]
        assert page["id"] == "proof-a"
        chunks.append(page["excerpt"])
        if "next_offset" not in page:
            break
        offset = page["next_offset"]
    assert "".join(chunks) == text
    assert raw["warehouses"][0]["result"]["excerpt"] == text


def test_compact_page_locations_keep_character_ranges_for_exact_quotes() -> None:
    raw = payload(1)
    raw["warehouses"][0]["result"]["items"][0]["locator"] = {
        "source_segments": [
            {"locator": {"slide": 1, "shape": "a"}, "chunk_char_start": 0, "chunk_char_end": 4},
            {"locator": {"slide": 1, "shape": "b"}, "chunk_char_start": 5, "chunk_char_end": 10},
            {"locator": {"slide": 2, "shape": "c"}, "chunk_char_start": 11, "chunk_char_end": 20},
        ]
    }
    item = compact_knowledge(raw, "search")["warehouses"][0]["result"]["items"][0]
    assert item["locator"]["positions"] == [
        {"slide": 1, "char_start": 0, "char_end": 10},
        {"slide": 2, "char_start": 11, "char_end": 20},
    ]


def test_graph_retains_properties_and_protected_evidence() -> None:
    raw = {
        "warehouses": [
            {
                "warehouse": {"id": "a"},
                "result": {
                    "nodes": [
                        {
                            "id": "node",
                            "canonical_name": "合成实体",
                            "properties_json": '{"role":"instructor"}',
                        }
                    ],
                    "edges": [
                        {
                            "id": "relation",
                            "relation_type": "teaches",
                            "evidence": [
                                {
                                    "id": "proof",
                                    "excerpt": "[MASKED] 合成证据",
                                    "locator": {"slide": 2},
                                }
                            ],
                        }
                    ],
                },
            }
        ]
    }
    body = compact_knowledge(raw, "graph")["warehouses"][0]["result"]
    assert body["nodes"][0]["properties_json"] == '{"role":"instructor"}'
    assert body["edges"][0]["evidence"][0] == {
        "id": "proof",
        "excerpt": "[MASKED] 合成证据",
        "locator": {"slide": 2},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args,operation,kwargs",
    [
        ("xingtu_search", {"query": "合成问题"}, "search", {"query": "合成问题", "limit": 5}),
        (
            "xingtu_documents",
            {"warehouse_id": "warehouse-a"},
            "documents",
            {"limit": 20, "offset": 0},
        ),
        ("xingtu_documents", {}, "documents", {"limit": 20, "offset": 0}),
    ],
)
async def test_mcp_returns_compact_payload_with_bounded_defaults(
    name, args, operation, kwargs
) -> None:
    reader = MagicMock()
    reader.selected = AsyncMock(return_value=payload())
    result = await build_mcp(reader).call_tool(name, args)
    if isinstance(result, tuple):
        result = result[1]
    if not isinstance(result, dict):
        result = json.loads(result[0].text)
    reader.selected.assert_awaited_once_with(operation, args.get("warehouse_id", ""), **kwargs)
    assert result["assistant_knowledge_sources"][0]["evidence_id"] == "0"
    assert "index" not in result["warehouses"][0]["result"]
