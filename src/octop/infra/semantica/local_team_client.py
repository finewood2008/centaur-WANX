"""Finite local-data child reader; never creates a legacy Semantica bearer."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from centuarai_local_data_gate.client import GateContext
from centuarai_local_data_gate.protocol import DataProtocolError

from .client import SemanticaClient, SemanticaError

_UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
_SCOPED = re.compile(r"/warehouses/(?P<warehouse>" + _UUID + r")(?P<path>/.*)?")
_READ = re.compile(
    r"/(?:capabilities|status|graph|evidence/[A-Za-z0-9_-]{1,128}|documents(?:/[A-Za-z0-9_-]{1,128}(?:/text)?)?)"
)
_QUERY = frozenset(
    {
        "limit",
        "offset",
        "keyword",
        "version_id",
        "start",
        "end",
        "length",
        "segment_offset",
        "segment_limit",
        "expected_sha256",
        "expected_origin_revision",
        "expected_version_id",
        "page_number",
    }
)
_SEARCH = frozenset({"query", "document_ids", "entity_types", "limit"})


def _selectors(value: Any) -> None:
    if isinstance(value, dict):
        if set(value) & {
            "workspace_id",
            "workspace_ids",
            "workspaceId",
            "workspaceIds",
            "warehouse_id",
            "warehouseId",
            "owner",
            "owner_view",
            "ownerView",
            "actor_id",
            "principalId",
        }:
            raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
        for child in value.values():
            _selectors(child)
    elif isinstance(value, list):
        for child in value:
            _selectors(child)


class LocalSemanticaClient:
    """Uses only a verified live parent and its previously frozen read grants.

    ``/warehouses/<uuid>/...`` selects an explicit team resource; the broker
    independently checks that resource against the parent/task frozen grants.
    A plain path selects only the current principal's private Semantica scope.
    """

    def __init__(self, context: GateContext, config: dict[str, Any]):
        if not isinstance(context, GateContext) or context.claims["audience"] != "octop":
            raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
        context.check_cached()
        address = urlsplit(str(config.get("service_url", "")))
        try:
            local = ipaddress.ip_address(address.hostname or "").is_loopback
        except ValueError:
            local = False
        if (
            address.scheme != "http"
            or not local
            or address.username
            or address.password
            or address.query
            or address.fragment
            or address.path not in {"", "/"}
        ):
            raise SemanticaError("SEMANTICA_CONFIG_INVALID")
        self.base_url = str(config["service_url"]).rstrip("/")
        self.context = context

    @classmethod
    def from_file(cls, context: GateContext, path: Path) -> LocalSemanticaClient:
        try:
            if path.is_symlink() or path.stat().st_size > 16384:
                raise ValueError("invalid config")
            config = json.loads(path.read_bytes())
        except (OSError, ValueError):
            raise SemanticaError("SEMANTICA_NOT_CONFIGURED") from None
        if not isinstance(config, dict):
            raise SemanticaError("SEMANTICA_CONFIG_INVALID")
        return cls(context, config)

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        warehouse = None
        if match := _SCOPED.fullmatch(path):
            warehouse = match["warehouse"]
            if match["path"] is not None:
                path = match["path"]
        metadata = warehouse is not None and path == "/warehouses/" + warehouse
        searching = method == "POST" and path == "/search"
        if not searching and not (method == "GET" and (_READ.fullmatch(path) or metadata)):
            raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 403)
        body = dict(payload or {})
        _selectors(body)
        _selectors(query or {})
        if (
            method == "GET"
            and payload is not None
            or set(query or {}) - _QUERY
            or any(not isinstance(value, str) for value in (query or {}).values())
            or searching
            and set(body) - _SEARCH
        ):
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        if searching:
            body["delivery_mode"] = "masked"
        raw = (
            json.dumps(
                body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            ).encode()
            if searching
            else b""
        )
        if len(raw) > 65536:
            raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
        target = "/api/integration" + path
        if query:
            target += "?" + urlencode(sorted(query.items()))
        headers = {"Content-Type": "application/json"} if raw else {}
        if warehouse is not None:
            headers["X-Wanx-Data-Context"] = "team:knowledge:" + warehouse
        try:
            signed = await asyncio.to_thread(
                self.context.child_headers,
                audience="semantica",
                method=method,
                raw_target=target,
                headers=headers,
                body=raw,
            )
            # Proof bytes and observed request bytes are the same. Never allow
            # an HTTP library to reserialize JSON/query or follow a redirect.
            async with (
                httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=45) as client,
                client.stream(
                    method, self.base_url + target, headers=signed, content=raw
                ) as stream,
            ):
                content = bytearray()
                async for chunk in stream.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 4 * 1024 * 1024:
                        raise SemanticaError("SEMANTICA_INVALID_RESPONSE")
                response = httpx.Response(
                    stream.status_code, headers=stream.headers, content=bytes(content)
                )
            await asyncio.to_thread(self.context.require_live)
        except DataProtocolError:
            raise SemanticaError("SEMANTICA_RESOURCE_FORBIDDEN", 403) from None
        except httpx.HTTPError:
            raise SemanticaError("SEMANTICA_SERVICE_UNAVAILABLE") from None
        return SemanticaClient.decode(response)

    async def search(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.request("POST", "/search", payload=payload)
