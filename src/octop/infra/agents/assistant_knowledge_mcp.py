"""Native read-only Starlink MCP scoped to one explicit assistant grant."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from octop.config import load_config
from octop.i18n import tr
from octop.infra.agents.assistant_knowledge import KnowledgeReader
from octop.infra.db.factory import open_database
from octop.infra.utils.paths import PathLayout


def build_mcp(reader: KnowledgeReader, locale: str = "zh") -> FastMCP:
    server = FastMCP(
        "wanx-assistant-knowledge", instructions=tr("assistant.knowledge_instructions", locale)
    )
    readonly = ToolAnnotations(
        readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
    )

    @server.tool(
        annotations=readonly, description=tr("assistant.knowledge_tools.warehouses", locale)
    )
    async def xingtu_warehouses() -> dict[str, Any]:
        return await reader.selected("warehouse")

    @server.tool(
        annotations=readonly, description=tr("assistant.knowledge_tools.documents", locale)
    )
    async def xingtu_documents(
        warehouse_id: str, limit: int = 100, offset: int = 0
    ) -> dict[str, Any]:
        return await reader.selected("documents", warehouse_id, limit=limit, offset=offset)

    @server.tool(annotations=readonly, description=tr("assistant.knowledge_tools.graph", locale))
    async def xingtu_graph(warehouse_id: str, limit: int = 120) -> dict[str, Any]:
        return await reader.selected("graph", warehouse_id, limit=limit)

    @server.tool(annotations=readonly, description=tr("assistant.knowledge_tools.search", locale))
    async def xingtu_search(query: str, warehouse_id: str = "", limit: int = 10) -> dict[str, Any]:
        return await reader.selected("search", warehouse_id, query=query, limit=limit)

    @server.tool(annotations=readonly, description=tr("assistant.knowledge_tools.evidence", locale))
    async def xingtu_evidence(warehouse_id: str, evidence_id: str) -> dict[str, Any]:
        return await reader.selected("evidence", warehouse_id, evidence_id=evidence_id)

    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument("--grant-id", required=True)
    parser.add_argument("--locale", choices=["zh", "en"], default="zh")
    args = parser.parse_args()
    paths = PathLayout(args.home)
    database = open_database(load_config(paths.config), paths)
    try:
        build_mcp(
            KnowledgeReader(args.home, database, args.user_id, args.grant_id), args.locale
        ).run()
    finally:
        database.close()
