"""STARLINK wire contract and WANX-issued workspace grants; no backend imports."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from .config import DEFAULT_URL, upstream_origin

APPS = {"wanx", "semantica", "centaurai.wanx.semantica"}
NAMESPACE = uuid.UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514")
ID = r"[A-Za-z0-9_-]{1,128}"
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
SKILL = r"[a-z][a-z0-9-]{0,119}"
REASON = r"(?:discover|prepare|reference|scope|search|evidence|read-document|coverage)"
PAGE = frozenset({"limit", "offset"})
GRAPH = frozenset({"limit", "entity_id"})
BLOB = frozenset(
    {
        "offset",
        "length",
        "page_number",
        "expected_sha256",
        "expected_origin_revision",
        "expected_version_id",
    }
)


class DesktopError(Exception):
    def __init__(self, code: str, status: int = 503, message: str | None = None):
        self.code, self.status, self.message = code, status, message
        super().__init__(code)


@dataclass(frozen=True)
class DesktopConfig:
    service_url: str
    service_token: str = field(repr=False)
    box_id: str
    application_id: str

    def __post_init__(self) -> None:
        try:
            if not isinstance(self.service_url, str):
                raise ValueError()
            object.__setattr__(self, "service_url", upstream_origin(self.service_url))
            if not isinstance(self.service_token, str) or (
                self.service_token
                and (
                    len(self.service_token) < 32
                    or not self.service_token.isascii()
                    or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in self.service_token)
                )
            ):
                raise ValueError()
            for value in (self.box_id, self.application_id):
                if (
                    not isinstance(value, str)
                    or not 1 <= len(value) <= 120
                    or value != value.strip()
                ):
                    raise ValueError()
        except (ValueError, TypeError) as exc:
            raise DesktopError("SEMANTICA_CONFIG_INVALID") from exc

    @classmethod
    def load(
        cls, path: Path, service_url: str | None = None, box_id: str | None = None
    ) -> DesktopConfig:
        """Reuse legacy identities; new installations use the WANX device identity."""
        try:
            with path.open("rb") as stream:
                raw = stream.read(16385)
            if len(raw) > 16384:
                raise ValueError()
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError()
            return cls(
                service_url or data.get("service_url", DEFAULT_URL),
                data.get("service_token", ""),
                data["box_id"],
                data["application_id"],
            )
        except FileNotFoundError as exc:
            if box_id:
                return cls(service_url or DEFAULT_URL, "", box_id, "semantica")
            raise DesktopError("SEMANTICA_NOT_CONFIGURED") from exc
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise DesktopError("SEMANTICA_CONFIG_INVALID") from exc

    def headers(
        self,
        user_id: int,
        app: str,
        operation: str | None = None,
        warehouse: str | None = None,
        *,
        owner_view: bool = False,
        ttl: int = 120,
    ) -> dict[str, str]:
        # Keep the legacy identity algorithm byte-for-byte compatible with existing data.
        if type(user_id) is not int or user_id < 1 or app not in APPS:
            raise DesktopError("SEMANTICA_RESOURCE_FORBIDDEN", 403)
        actor = f"{app}:{user_id}"
        resource = f"personal:{actor}"

        def workspace_for(value: str) -> str:
            identity = json.dumps([self.box_id, self.application_id, value], separators=(",", ":"))
            return str(uuid.uuid5(NAMESPACE, identity))

        workspace = workspace_for(resource)
        if warehouse and warehouse != workspace:
            if not re.fullmatch(UUID, warehouse):
                raise DesktopError("SEMANTICA_INVALID_REQUEST", 422)
            resource += ":warehouse:" + warehouse
            workspace = workspace_for(resource)
        claims = {
            "box_id": self.box_id,
            "application_id": self.application_id,
            "actor_id": actor,
            "workspace_id": workspace,
            "workspace_bindings": {workspace: resource},
            "ownership_epoch": 0,
            "permissions": ["read", "write"] if operation else ["read"],
            "owner_view": owner_view,
            "request_id": str(uuid.uuid4()),
            "operation_id": operation,
            "expires_at": int(time.time()) + min(ttl, 300),
        }
        encoded = (
            base64.urlsafe_b64encode(
                json.dumps(
                    claims,
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                ).encode()
            )
            .decode()
            .rstrip("=")
        )
        if not self.service_token:
            return {"x-semantica-scope": encoded}
        # Preserve explicit legacy managed integrations; standalone needs no signature.
        return {
            "authorization": "Bearer " + self.service_token,
            "x-semantica-scope": encoded,
            "x-semantica-signature": hmac.new(
                self.service_token.encode(), encoded.encode(), hashlib.sha256
            ).hexdigest(),
        }


# Exact method/path pairs; processing/authorize belongs only to the private model relay.
RULES = [
    ("GET", r"/(?:status|capabilities|retrieval/status|sensitive/settings)", frozenset()),
    ("GET", r"/(?:documents|jobs)", PAGE),
    ("GET", r"/(?:graph|owner/graph)", GRAPH),
    ("GET", rf"/documents/{ID}", frozenset({"segment_offset", "segment_limit"})),
    ("GET", rf"/documents/{ID}/text", frozenset({"version_id", "start", "end"})),
    ("GET", rf"/documents/{ID}/blob", BLOB),
    ("GET", rf"/(?:jobs|evidence|operations)/{ID}", frozenset()),
    ("GET", r"/skills", PAGE | {"keyword"}),
    ("GET", rf"/skills/{SKILL}", frozenset({"path"})),
    ("GET", rf"/skills/{SKILL}/download", frozenset()),
    ("POST", r"/search", frozenset()),
    ("POST", r"/(?:imports|retrieval/indexes|skills/import)", frozenset()),
    ("PATCH", rf"/imports/{ID}", frozenset()),
    ("POST", rf"/imports/{ID}/commit", frozenset()),
    ("PUT", r"/sensitive/settings", frozenset()),
    ("POST", rf"/documents/{ID}/(?:correction|extraction)", frozenset()),
    ("POST", rf"/jobs/{ID}/(?:retry|cancel)", frozenset()),
    ("POST", rf"/skills/{SKILL}/delete", frozenset()),
    ("POST", rf"/reasoning/{REASON}", frozenset()),
]
ROOT_RULES = [
    ("GET", r"/warehouses(?:/runtime|/transfers)?", frozenset()),
    ("GET", rf"/warehouses/transfers/{UUID}", frozenset()),
    ("GET", rf"/warehouses/transfers/{UUID}/blob", frozenset({"offset", "length"})),
    ("GET", rf"/warehouses/{UUID}(?:/keys)?", frozenset()),
    ("POST", r"/warehouses(?:/imports)?", frozenset()),
    ("PATCH", rf"/warehouses/imports/{UUID}", frozenset()),
    ("POST", rf"/warehouses/imports/{UUID}/commit", frozenset()),
    (
        "POST",
        rf"/warehouses/{UUID}/(?:exports|clear(?:/prepare)?|delete(?:/prepare)?|keys(?:/{UUID}/revoke)?)",
        frozenset(),
    ),
    ("GET", r"/processing", frozenset({"warehouse_id"})),
    ("GET", r"/processing/catalog", frozenset()),
    ("PUT", r"/processing", frozenset()),
    ("POST", r"/processing/(?:check|reprocess)", frozenset()),
]
PUBLIC_RULES = [
    ("GET", r"/warehouse", frozenset()),
    ("GET", r"/documents", PAGE),
    ("GET", r"/graph", GRAPH),
    ("GET", rf"/evidence/{ID}", frozenset()),
    ("POST", r"/search", frozenset()),
    ("POST", rf"/reasoning/{REASON}", frozenset()),
]


@dataclass(frozen=True)
class Operation:
    path: str
    query_keys: frozenset[str]
    warehouse: str | None = None
    public: bool = False

    @property
    def body_limit(self) -> int:
        return (
            128 * 1024
            if self.public
            else 6 * 1024 * 1024
            if self.path == "/skills/import"
            else 2 * 1024 * 1024
        )

    @property
    def timeout(self) -> int:
        if self.path in {"/processing", "/processing/check"} or self.path.startswith("/reasoning/"):
            # Semantica accepts grants for at most 300 s and rechecks at completion.
            # Leave time for delivery; STARLINK's outer timeout remains 330 s.
            return 285
        return 85 if self.path == "/search" else 45


def resolve(method: str, path: str) -> Operation:
    if any(c in path for c in ("%", "\\", "//")) or any(p in {".", ".."} for p in path.split("/")):
        raise DesktopError("SEMANTICA_OPERATION_NOT_ALLOWED", 404)
    if any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise DesktopError("SEMANTICA_OPERATION_NOT_ALLOWED", 404)
    public = path.startswith("/open/v1/")
    if public:
        path = path[len("/open/v1") :]
        rules, warehouse = PUBLIC_RULES, None
    else:
        warehouse = None
        # Warehouse management binds the personal owner scope, not a warehouse scope.
        root = any(re.fullmatch(pattern, path) for _, pattern, _ in ROOT_RULES)
        if not root and (scoped := re.fullmatch(rf"/warehouses/(?P<id>{UUID})(?P<path>/.*)", path)):
            warehouse, path = scoped["id"], scoped["path"]
        rules = ROOT_RULES if root else RULES
    matched_path = False
    for allowed_method, pattern, keys in rules:
        if re.fullmatch(pattern, path):
            matched_path = True
            if method == allowed_method:
                return Operation(path, frozenset(keys), warehouse, public)
    raise DesktopError("SEMANTICA_OPERATION_NOT_ALLOWED", 405 if matched_path else 404)


def _selects_workspace(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            k in {"workspace_id", "workspace_ids"} or _selects_workspace(v)
            for k, v in value.items()
        )
    return isinstance(value, list) and any(_selects_workspace(v) for v in value)


def prepare(
    operation: Operation, method: str, body: dict[str, Any] | None, query: dict[str, str]
) -> tuple[dict[str, Any] | None, str | None]:
    if set(query) - operation.query_keys:
        raise DesktopError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
    if _selects_workspace(body):
        raise DesktopError("SEMANTICA_SCOPE_NOT_SELECTABLE", 403)
    if "warehouse_id" in query and not re.fullmatch(UUID, query["warehouse_id"]):
        raise DesktopError("SEMANTICA_INVALID_REQUEST", 422)
    payload = dict(body or {})
    if operation.path.startswith("/processing") and payload.get("warehouse_id") is not None:
        if not isinstance(payload["warehouse_id"], str) or not re.fullmatch(
            UUID, payload["warehouse_id"]
        ):
            raise DesktopError("SEMANTICA_INVALID_REQUEST", 422)
    if method == "GET":
        return None, None
    if operation.public or operation.path == "/search":
        keys = (
            {"arguments"}
            if operation.path.startswith("/reasoning/")
            else {"query", "document_ids", "entity_types", "limit"}
        )
        if set(payload) - keys:
            raise DesktopError("SEMANTICA_QUERY_NOT_ALLOWED", 422)
        if not operation.public:
            payload["delivery_mode"] = "masked"
        return payload, None
    op = payload.get("operation_id")
    if not isinstance(op, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", op):
        raise DesktopError("SEMANTICA_OPERATION_ID_REQUIRED", 422)
    if method == "PATCH":
        payload.pop("operation_id")
    return payload, op


def strict_json(raw: bytes | str) -> Any:
    def invalid_constant(value):
        raise ValueError(value)

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(value)
        return number

    try:
        return json.loads(raw, parse_constant=invalid_constant, parse_float=finite_float)
    except RecursionError as exc:
        raise ValueError("JSON nesting too deep") from exc


def decode(status: int, raw: bytes, *, public: bool = False) -> dict[str, Any]:
    if status == 401:
        raise (
            DesktopError("ACCESS_KEY_INVALID", 403)
            if public
            else DesktopError("SEMANTICA_SERVICE_AUTH_FAILED")
        )
    try:
        value = strict_json(raw)
    except (ValueError, UnicodeError):
        value = None
    if not 200 <= status < 300:
        error = value if isinstance(value, dict) else {}
        error = error.get("detail") if isinstance(error.get("detail"), dict) else error
        code, message = error.get("code"), error.get("message")
        if (
            isinstance(code, str)
            and re.fullmatch(
                r"(?:WAREHOUSE|MIGRATION|ACCESS_KEY|MODEL|SKILL|REASONING)_[A-Z_]+", code
            )
            and 400 <= status < 600
        ):
            raise DesktopError(
                code, status, message if isinstance(message, str) and len(message) <= 200 else None
            )
        codes = {
            403: "RESOURCE_FORBIDDEN",
            404: "RESOURCE_NOT_FOUND",
            409: "VERSION_CONFLICT",
            413: "FILE_TOO_LARGE",
            422: "INVALID_REQUEST",
            429: "SERVICE_BUSY",
        }
        raise DesktopError(
            "SEMANTICA_" + codes.get(status, "SERVICE_ERROR"), status if status in codes else 503
        )
    if not isinstance(value, dict):
        raise DesktopError("SEMANTICA_INVALID_RESPONSE", 502)
    return value


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict | None = None,
    query: dict | None = None,
    timeout: int = 45,
    public: bool = False,
) -> tuple[int, dict[str, Any]]:
    """Bound decoded JSON, suppress cookies and redirects, and close on cancellation."""
    request = client.build_request(
        method,
        url,
        headers=headers,
        params=query,
        json=payload if payload is not None else None,
        timeout=timeout,
    )
    request.headers.pop("cookie", None)
    try:
        response = await client.send(request, stream=True)
        try:
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > 16 * 1024 * 1024:
                    raise DesktopError("SEMANTICA_RESPONSE_TOO_LARGE", 502)
            return response.status_code, decode(response.status_code, bytes(raw), public=public)
        finally:
            await response.aclose()
    except httpx.HTTPError as exc:
        raise DesktopError("SEMANTICA_SERVICE_UNAVAILABLE") from exc
