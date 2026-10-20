"""Short-lived service-signed resource grants, independent of MCP tool arguments."""
from __future__ import annotations

import base64
from contextvars import ContextVar
import hashlib
import hmac
import json
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, ValidationError
from uuid import UUID, uuid5
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from app.config import Settings

_WORKSPACE_NAMESPACE = UUID("8ae54f40-4054-4bba-a2e2-06e1c43d7514")
_CAPABILITIES = "__capabilities__"


class IntegrationScope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    box_id: str = Field(min_length=1, max_length=120)
    application_id: str = Field(min_length=1, max_length=120)
    actor_id: str = Field(min_length=1, max_length=120)
    workspace_id: str = Field(min_length=1, max_length=120)
    workspace_ids: list[str] = Field(default_factory=list, max_length=32)
    workspace_bindings: dict[str, str] = Field(default_factory=dict, max_length=33)
    ownership_epoch: int = Field(ge=0)
    permissions: list[Literal["read", "write"]] = Field(min_length=1, max_length=2)
    # Explicitly signed for private browsing by the warehouse owner only.
    owner_view: bool = False
    request_id: str = Field(min_length=1, max_length=120)
    operation_id: str | None = Field(default=None, max_length=120)
    expires_at: int
    _bindings_required: bool = PrivateAttr(default=False)

    def validate_bindings(self, *, required: bool = False) -> None:
        self._bindings_required = self._bindings_required or required
        if not self.workspace_bindings and not self._bindings_required:
            return
        workspaces = {self.workspace_id, *self.workspace_ids}
        if set(self.workspace_bindings) != workspaces:
            raise PermissionError("workspace bindings do not match signed scope")
        for workspace, resource in self.workspace_bindings.items():
            if not resource or len(resource) > 120 or resource != resource.strip():
                raise PermissionError("invalid workspace binding")
            identity = json.dumps([self.box_id, self.application_id, resource], separators=(",", ":"))
            if workspace != str(uuid5(_WORKSPACE_NAMESPACE, identity)):
                raise PermissionError("workspace belongs to another application")
        if _CAPABILITIES in self.workspace_bindings.values() and (
                len(workspaces) != 1 or self.permissions != ["read"] or self.operation_id is not None):
            raise PermissionError("capabilities scope must be read-only and exclusive")

    def is_capabilities_scope(self) -> bool:
        return self.workspace_bindings.get(self.workspace_id) == _CAPABILITIES

    def require(self, workspace_id: str, *, write: bool = False,
                operation_id: str | None = None, capability: bool = False) -> None:
        self.validate_bindings()
        if self.is_capabilities_scope() and (not capability or write):
            raise PermissionError("capabilities scope cannot access knowledge resources")
        if self.expires_at <= time.time():
            raise PermissionError("scope expired")
        if workspace_id not in {self.workspace_id, *self.workspace_ids}:
            raise PermissionError("workspace is outside the signed scope")
        if ("write" if write else "read") not in self.permissions:
            raise PermissionError("scope does not permit this operation")
        if write and (not operation_id or operation_id != self.operation_id):
            raise PermissionError("write operation does not match signed operation_id")


request_scope: ContextVar[IntegrationScope | None] = ContextVar("semantica_scope", default=None)
request_auth_headers: ContextVar[dict[str, str]] = ContextVar("semantica_headers", default={})


def signed_headers(settings: Settings, claims: dict) -> dict[str, str]:
    """Shared wire algorithm; callers must first perform their business ACL checks."""
    encoded = base64.urlsafe_b64encode(json.dumps(
        claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()).decode().rstrip("=")
    tokens = settings.application_tokens()
    secret = tokens[claims["application_id"]] if tokens else settings.integration_service_token.get_secret_value()
    return {"Authorization": f"Bearer {secret}", "X-Semantica-Scope": encoded,
            "X-Semantica-Signature": hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()}


def authenticate(headers: Headers, settings: Settings) -> IntegrationScope:
    # Standalone may run without bridge credentials; only its integration
    # surface needs them. Never accept a weak or partially configured principal.
    if (len(settings.integration_service_token.get_secret_value()) < 32
            or not settings.integration_box_id.strip()
            or not settings.integration_application_id.strip()):
        raise PermissionError("integration credentials are not configured correctly")
    try:
        tokens = settings.application_tokens()
    except ValueError as exc:
        raise PermissionError("integration credentials are not configured correctly") from exc
    credentials = tokens or {settings.integration_application_id: settings.integration_service_token.get_secret_value()}
    authorization = headers.get("authorization", "").encode()
    principal = next((app for app, token in credentials.items()
                      if hmac.compare_digest(authorization, f"Bearer {token}".encode())), None)
    secret = credentials.get(principal, "")
    if not secret:
        raise PermissionError("service authentication required")
    encoded = headers.get("x-semantica-scope", "")
    signature = headers.get("x-semantica-signature", "")
    if len(encoded) > 8192 or not hmac.compare_digest(signature.encode(), hmac.new(
        secret.encode(), encoded.encode(), hashlib.sha256).hexdigest().encode()):
        raise PermissionError("invalid signed scope")
    try:
        claims = IntegrationScope.model_validate_json(base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
    except (ValueError, ValidationError) as exc:
        raise PermissionError("invalid signed scope") from exc
    if (claims.box_id != settings.integration_box_id
            or claims.application_id != principal
            or not time.time() < claims.expires_at <= time.time() + 300):
        raise PermissionError("scope identity or expiration is invalid")
    claims.validate_bindings(required=bool(tokens))
    return claims


class ManagedAuthMiddleware:
    """Authenticate integration in both modes; gate native REST/MCP only in managed."""
    def __init__(self, app, *, settings: Settings, surface: str):
        self.app, self.settings, self.surface = app, settings, surface

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        managed = self.settings.integration_mode == "managed"
        if self.surface == "mcp" and not managed:
            return await self.app(scope, receive, send)
        path = scope["path"]
        health = path in ({"/health"} if self.surface == "mcp" else {"/api/health/live", "/api/health/ready"})
        if health:
            return await self.app(scope, receive, send)
        if self.surface == "workbench" and scope["path"].startswith("/api/open/v1/"):
            if Headers(scope=scope).get("origin") is not None:
                return await JSONResponse({"code": "ACCESS_KEY_ORIGIN_DENIED"}, 403)(scope, receive, send)
            raw = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                raw.extend(message.get("body", b""))
                if len(raw) > 128 * 1024:
                    return await JSONResponse({"code": "REQUEST_TOO_LARGE"}, 413)(scope, receive, send)
                if not message.get("more_body", False):
                    break
            delivered = False

            async def public_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(raw), "more_body": False}
                return await receive()

            async def public_send(message):
                if message["type"] == "http.response.start":
                    message = {**message, "headers": [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"] + [(b"cache-control", b"no-store")]}
                await send(message)
            return await self.app(scope, public_receive, public_send)
        if self.surface == "workbench" and not path.startswith("/api/integration/"):
            if not managed:
                return await self.app(scope, receive, send)
            return await JSONResponse({"detail": "native workbench routes are disabled in managed mode"}, 403)(scope, receive, send)
        headers = Headers(scope=scope)
        # A browser origin is never a trusted service principal, including loopback pages.
        if headers.get("origin") is not None:
            return await JSONResponse({"detail": "browser origins are not permitted"}, 403)(scope, receive, send)
        try:
            grant = authenticate(headers, self.settings)
            if grant.is_capabilities_scope() and self.surface == "workbench" and not (
                    scope["method"] == "GET" and path == "/api/integration/capabilities"):
                raise PermissionError("capabilities scope cannot access knowledge resources")
        except PermissionError as exc:
            return await JSONResponse({"detail": str(exc)}, 401)(scope, receive, send)
        if self.surface == "workbench":
            # All integration operations are bounded JSON envelopes; large files
            # arrive through 1 MiB import chunks rather than a giant JSON body.
            raw = bytearray()
            original_receive = receive
            while True:
                message = await original_receive()
                if message["type"] == "http.disconnect":
                    return
                raw.extend(message.get("body", b""))
                if len(raw) > (6 * 1024 * 1024 if path == '/api/integration/skills/import' else 2 * 1024 * 1024):
                    return await JSONResponse({"error": {"code": "REQUEST_TOO_LARGE"}}, 413)(scope, original_receive, send)
                if not message.get("more_body", False):
                    break
            delivered = False

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(raw), "more_body": False}
                return await original_receive()

            receive = bounded_receive
        token = request_scope.set(grant)
        header_token = request_auth_headers.set({key: headers[key] for key in (
            "authorization", "x-semantica-scope", "x-semantica-signature")})
        try:
            await self.app(scope, receive, send)
        finally:
            request_scope.reset(token)
            request_auth_headers.reset(header_token)
