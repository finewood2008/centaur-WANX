"""WANX signs user-scoped grants; Semantica remains the sole document owner."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

_NAMESPACE = uuid.UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514")
_READ = re.compile(
    r"^/(?:skills(?:/[a-z][a-z0-9-]{0,119}(?:/download)?)?|processing(?:/catalog)?|status|capabilities|documents|jobs|graph|owner/graph|retrieval/status|sensitive/settings|documents/[a-zA-Z0-9_-]{1,128}(?:/(?:text|blob))?|jobs/[a-zA-Z0-9_-]{1,128}|evidence/[a-zA-Z0-9_-]{1,128}|operations/[a-zA-Z0-9_-]{1,128})$"
)
_WRITE = re.compile(
    r"^/(?:skills/(?:import|[a-z][a-z0-9-]{0,119}/delete)|reasoning/(?:discover|prepare|reference|scope|search|evidence|read-document|coverage)|processing(?:/check|/authorize|/reprocess)?|imports(?:/[a-zA-Z0-9_-]{1,128}(?:/commit)?)?|retrieval/indexes|documents/[a-zA-Z0-9_-]{1,128}/(?:correction|extraction)|jobs/[a-zA-Z0-9_-]{1,128}/(?:retry|cancel)|sensitive/settings)$"
)
_UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
_MANAGE_READ = re.compile(
    r"^/warehouses(?:/runtime|/transfers|/transfers/"
    + _UUID
    + r"(?:/blob)?|/"
    + _UUID
    + r"(?:/keys)?)?$"
)
_MANAGE_WRITE = re.compile(
    r"^/warehouses(?:/imports(?:/"
    + _UUID
    + r"(?:/commit)?)?|/"
    + _UUID
    + r"/(?:exports|clear(?:/prepare)?|delete(?:/prepare)?|keys(?:/"
    + _UUID
    + r"/revoke)?))?$"
)
_SCOPED = re.compile(r"^/warehouses/(?P<warehouse>" + _UUID + r")(?P<path>/.*)$")
_PUBLIC = re.compile(
    r"^/(?:warehouse|documents|graph|search|evidence/[a-zA-Z0-9_-]{1,128}|reasoning/(?:discover|prepare|reference|scope|search|evidence|read-document|coverage))$"
)


class SemanticaError(Exception):
    def __init__(self, code: str, status: int = 503, message: str | None = None):
        self.code, self.status, self.message = code, status, message
        super().__init__(code)


class SemanticaClient:
    def __init__(
        self,
        config: dict[str, Any],
        actor_id: int,
        application_id: str = "wanx",
        *,
        team: bool = False,
    ):
        self.config = config
        address = urlsplit(str(config.get("service_url", "")))
        try:
            local = (
                address.hostname == "localhost"
                or ipaddress.ip_address(address.hostname or "").is_loopback
            )
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
        if (
            len(str(config.get("service_token", ""))) < 32
            or not config.get("box_id")
            or not config.get("application_id")
        ):
            raise SemanticaError("SEMANTICA_CONFIG_INVALID")
        self.base_url = str(config["service_url"]).rstrip("/")
        self.actor = f"{application_id}:{actor_id}"
        self.team = team
        self.resource = "team:wanx" if team else f"personal:{self.actor}"
        identity = json.dumps(
            [config["box_id"], config["application_id"], self.resource], separators=(",", ":")
        )
        self.workspace = str(uuid.uuid5(_NAMESPACE, identity))

    @classmethod
    def from_file(
        cls, path: Path, actor_id: int, application_id: str = "wanx", *, team: bool = False
    ) -> SemanticaClient:
        try:
            if path.stat().st_size > 16384:
                raise ValueError("invalid config")
            config = json.loads(path.read_text())
        except (OSError, ValueError):
            raise SemanticaError("SEMANTICA_NOT_CONFIGURED") from None
        return cls(config, actor_id, application_id, team=team)

    def headers(
        self,
        operation_id: str | None = None,
        warehouse_id: str | None = None,
        *,
        owner_view: bool = False,
    ) -> dict[str, str]:
        resource, workspace = self.resource, self.workspace
        if warehouse_id and warehouse_id != self.workspace:
            if not re.fullmatch(_UUID, warehouse_id):
                raise SemanticaError("SEMANTICA_INVALID_REQUEST", 422)
            resource += ":warehouse:" + warehouse_id
            workspace = str(
                uuid.uuid5(
                    _NAMESPACE,
                    json.dumps(
                        [self.config["box_id"], self.config["application_id"], resource],
                        separators=(",", ":"),
                    ),
                )
            )
        claims = {
            "box_id": self.config["box_id"],
            "application_id": self.config["application_id"],
            "actor_id": self.actor,
            "workspace_id": workspace,
            "workspace_bindings": {workspace: resource},
            "ownership_epoch": 0,
            "permissions": ["read", "write"] if operation_id else ["read"],
            "owner_view": owner_view,
            "request_id": str(uuid.uuid4()),
            "operation_id": operation_id,
            "expires_at": int(time.time()) + 120,
        }
        if self.team:
            claims["resource_owner"] = "team:wanx"
        encoded = (
            base64.urlsafe_b64encode(
                json.dumps(
                    claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                ).encode()
            )
            .decode()
            .rstrip("=")
        )
        secret = str(self.config["service_token"])
        return {
            "authorization": f"Bearer {secret}",
            "x-semantica-scope": encoded,
            "x-semantica-signature": hmac.new(
                secret.encode(), encoded.encode(), hashlib.sha256
            ).hexdigest(),
        }

    async def request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        warehouse_id = None
        managed = (_MANAGE_WRITE if method != "GET" else _MANAGE_READ).fullmatch(path)
        if not managed and (scoped := _SCOPED.fullmatch(path)):
            warehouse_id, path = scoped["warehouse"], scoped["path"]
        searching = method == "POST" and path == "/search"
        write = method in {"POST", "PUT", "PATCH", "DELETE"} and not searching
        if not managed and not searching and not (_WRITE if write else _READ).fullmatch(path):
            raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 404)
        if method not in {"GET", "POST", "PUT", "PATCH"}:
            raise SemanticaError("SEMANTICA_OPERATION_NOT_ALLOWED", 405)
        body = dict(payload or {})
        operation = body.get("operation_id") if write else None
        if write and (
            not isinstance(operation, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,120}", operation)
        ):
            raise SemanticaError("SEMANTICA_OPERATION_ID_REQUIRED", 422)
        if "workspace_id" in body or "workspace_ids" in body:
            raise SemanticaError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
        allowed_query = {
            "limit",
            "offset",
            "entity_id",
            "segment_offset",
            "segment_limit",
            "version_id",
            "start",
            "end",
            "length",
            "page_number",
            "expected_sha256",
            "expected_origin_revision",
            "expected_version_id",
            "warehouse_id",
            "keyword",
            "path",
        }
        if set(query or {}) - allowed_query:
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        if searching:
            if set(body) - {"query", "document_ids", "entity_types", "limit"}:
                raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
            body["delivery_mode"] = "masked"
        if method == "PATCH" and (
            path.startswith("/imports/") or path.startswith("/warehouses/imports/")
        ):
            body.pop("operation_id")
        try:
            async with httpx.AsyncClient(
                timeout=320
                if path.startswith(("/processing", "/reasoning"))
                else 90
                if searching
                else 45,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = await client.request(
                    method,
                    self.base_url + "/api/integration" + path,
                    headers=self.headers(
                        operation, warehouse_id, owner_view=path == "/owner/graph"
                    ),
                    params=query,
                    json=body if method != "GET" else None,
                )
        except httpx.HTTPError:
            raise SemanticaError("SEMANTICA_SERVICE_UNAVAILABLE") from None
        return self.decode(response)

    async def search(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self.request("POST", "/search", payload=payload)

    async def public_read(
        self,
        method: str,
        path: str,
        token: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if (
            not _PUBLIC.fullmatch(path)
            or method != ("POST" if path == "/search" or path.startswith("/reasoning/") else "GET")
            or not isinstance(token, str)
            or not re.fullmatch(r"xg_[A-Za-z0-9_-]{30,80}", token)
        ):
            raise SemanticaError("ACCESS_KEY_INVALID", 403)
        if set(query or {}) - {"limit", "offset", "entity_id"}:
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        if payload is not None and set(payload) - (
            {"arguments"}
            if path.startswith("/reasoning/")
            else {
                "query",
                "document_ids",
                "entity_types",
                "limit",
            }
        ):
            raise SemanticaError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        try:
            async with httpx.AsyncClient(
                timeout=320 if path.startswith("/reasoning/") else 90,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = await client.request(
                    method,
                    self.base_url + "/api/open/v1" + path,
                    headers={"Authorization": "Bearer " + token},
                    params=query,
                    json=payload if method == "POST" else None,
                )
        except httpx.HTTPError:
            raise SemanticaError("SEMANTICA_SERVICE_UNAVAILABLE") from None
        if response.status_code == 401:
            raise SemanticaError("ACCESS_KEY_INVALID", 403)
        return self.decode(response)

    @staticmethod
    def decode(response: httpx.Response) -> dict[str, Any]:
        if response.status_code == 401:
            # Service authentication failure must never revoke the WANX user's Host session.
            raise SemanticaError("SEMANTICA_SERVICE_AUTH_FAILED")
        if response.status_code >= 400 or 300 <= response.status_code < 400:
            try:
                error = response.json()
                detail = error.get("detail")
                error = detail if isinstance(detail, dict) else error
                code = error.get("code", "")
                if re.fullmatch(
                    r"(?:WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|SKILL|REASONING)_[A-Z_]+", code
                ):
                    message = error.get("message")
                    raise SemanticaError(
                        code,
                        response.status_code,
                        message if isinstance(message, str) and len(message) <= 200 else None,
                    )
            except (ValueError, AttributeError):
                pass
            codes = {
                403: "SEMANTICA_RESOURCE_FORBIDDEN",
                404: "SEMANTICA_RESOURCE_NOT_FOUND",
                409: "SEMANTICA_VERSION_CONFLICT",
                413: "SEMANTICA_FILE_TOO_LARGE",
                422: "SEMANTICA_INVALID_REQUEST",
            }
            raise SemanticaError(
                codes.get(response.status_code, "SEMANTICA_SERVICE_ERROR"),
                response.status_code if response.status_code in codes else 503,
            )
        try:
            value = response.json()
            if not isinstance(value, dict):
                raise ValueError("not an object")
        except ValueError:
            raise SemanticaError("SEMANTICA_INVALID_RESPONSE") from None
        return value
