"""Independent, server-hosted Starlink MCP; warehouse keys stay upstream-scoped."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware, get_access_token
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend, RequireAuthMiddleware
from mcp.server.auth.provider import AccessToken
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from starlette.middleware.authentication import AuthenticationMiddleware

from octop.api.space_mcp import SpaceOriginGuard, mount_transport
from octop.infra.semantica.client import SemanticaClient


async def public_read(
    server: Any,
    key: str,
    path: str,
    *,
    payload: dict[str, Any] | None = None,
    query: dict[str, str] | None = None,
) -> dict[str, Any]:
    # Only fixed public read operations, never the service-token management API.
    if not re.fullmatch(r"xg_[A-Za-z0-9_-]{30,80}", key) or not re.fullmatch(
        r"/(warehouse|documents|graph|search|evidence/[A-Za-z0-9_-]{1,128})", path
    ):
        raise ValueError("ACCESS_KEY_INVALID")

    def address() -> str:
        config_path = server.paths.root / "semantica.json"
        if config_path.stat().st_size > 16384:
            raise ValueError("SEMANTICA_CONFIG_INVALID")
        value = json.loads(config_path.read_text())["service_url"]
        u = urlsplit(value)
        try:
            local = u.hostname == "localhost" or ipaddress.ip_address(u.hostname or "").is_loopback
        except ValueError:
            local = False
        if (
            not local
            or u.scheme != "http"
            or u.username
            or u.password
            or u.query
            or u.fragment
            or u.path not in {"", "/"}
        ):
            raise ValueError("SEMANTICA_CONFIG_INVALID")
        return str(value).rstrip("/")

    base = await asyncio.to_thread(address)
    async with httpx.AsyncClient(timeout=90, trust_env=False, follow_redirects=False) as client:
        response = await client.request(
            "POST" if path == "/search" else "GET",
            base + "/api/open/v1" + path,
            headers={"Authorization": "Bearer " + key},
            params=query,
            json=payload if path == "/search" else None,
        )
    if response.status_code == 401:
        raise ValueError("ACCESS_KEY_INVALID")
    return SemanticaClient.decode(response)


class WarehouseKeyVerifier:
    def __init__(self, server: Any):
        self.server = server

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            await public_read(self.server, token, "/warehouse")
        except Exception:
            return None
        return AccessToken(token=token, client_id="starlink-warehouse-key", scopes=["starlink"])


def mount_starlink_mcp(app: FastAPI, server: Any) -> FastMCP:
    mcp = FastMCP(
        "wanx-starlink",
        instructions="万象·星图 MCP。使用仓库专属 Key，只能读取该 Key 绑定仓的知识与证据。空间资料使用独立的空间 MCP 和 Key。",
        stateless_http=True,
        json_response=True,
        streamable_http_path="/starlink",
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    async def read(
        path: str, *, query: dict[str, str] | None = None, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        access = get_access_token()
        if not access:
            raise ValueError("ACCESS_KEY_REQUIRED")
        try:
            return await public_read(server, access.token, path, query=query, payload=payload)
        except Exception as exc:
            # Never serialize HTTP headers/configuration in a tool error.
            raise ValueError(getattr(exc, "code", "STARLINK_UNAVAILABLE")) from None

    @mcp.tool(description="读取当前仓库 Key 所绑定的星图仓库概况。不能指定其他仓库。")
    async def xingtu_warehouse() -> dict[str, Any]:
        return await read("/warehouse")

    @mcp.tool(description="读取此仓库 Key 获准的材料列表。")
    async def xingtu_documents(
        limit: int = Field(default=100, ge=1, le=200), offset: int = Field(default=0, ge=0)
    ) -> dict[str, Any]:
        return await read("/documents", query={"limit": str(limit), "offset": str(offset)})

    @mcp.tool(description="读取授权仓的真实知识图谱与来源，遵循仓库保护规则。")
    async def xingtu_graph(
        limit: int = Field(default=200, ge=1, le=500),
        entity_id: str = Field(default="", max_length=128),
    ) -> dict[str, Any]:
        return await read(
            "/graph", query={"limit": str(limit), **({"entity_id": entity_id} if entity_id else {})}
        )

    @mcp.tool(description="在授权仓检索证据与引用。")
    async def xingtu_search(
        query: str = Field(min_length=1, max_length=2000),
        limit: int = Field(default=10, ge=1, le=50),
    ) -> dict[str, Any]:
        return await read("/search", payload={"query": query, "limit": limit})

    @mcp.tool(description="读取授权仓内的证据，不能跨仓。")
    async def xingtu_evidence(
        evidence_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$"),
    ) -> dict[str, Any]:
        return await read("/evidence/" + evidence_id)

    transport = mcp.streamable_http_app()
    secured = SpaceOriginGuard(
        AuthenticationMiddleware(
            AuthContextMiddleware(RequireAuthMiddleware(transport, ["starlink"])),
            backend=BearerAuthBackend(WarehouseKeyVerifier(server)),
        ),
        server,
    )
    mount_transport(app, "starlink", secured)
    app.state.starlink_mcp = mcp
    return mcp
