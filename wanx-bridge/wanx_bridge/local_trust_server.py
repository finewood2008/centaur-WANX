"""HTTPS-only management routes. No bearer login, roster import or proxy."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

from .local_trust_config import LocalTrustError, strict_object
from .local_trust_protocol import BindingProtocolError
from .local_trust_service import OPERATIONS, LocalTrustService

PREFIX = "/local-trust/v1"
BODY_TIMEOUT = 5


def _status(code: str) -> int:
    if "CAPACITY" in code or "RATE_LIMIT" in code:
        return 429
    if any(
        word in code for word in ("CLOCK", "BOOT", "CORRUPT", "UNAVAILABLE", "MISSING", "CONFIG")
    ):
        return 503
    if any(word in code for word in ("DENIED", "FORBIDDEN", "SIGNATURE", "NOT_FOUND")):
        return 403
    if any(word in code for word in ("CONFLICT", "CANCELLED", "EXPIRED", "USED", "OWNED", "REUSE")):
        return 409
    return 400


async def _body(request: Request, operation: str) -> dict:
    if (
        len(request.headers.getlist("content-type")) != 1
        or request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        != "application/json"
    ):
        raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400)
    limit = (
        131072
        if operation == "v2/mutations/commit"
        else 65536
        if operation == "first-root/commit"
        else 18432
    )
    if operation.startswith("v2/backup-io/"):
        limit = 1420000 if operation == "v2/backup-io/source.append" else 32768
    raw = bytearray()
    try:
        async with asyncio.timeout(BODY_TIMEOUT):
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > limit:
                    raise LocalTrustError("LOCAL_TRUST_BODY_TOO_LARGE", 413)
        body = strict_object(raw)
    except TimeoutError:
        raise LocalTrustError("LOCAL_TRUST_BODY_TIMEOUT", 408) from None
    except ClientDisconnect:
        raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400) from None
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400) from None
    fields = OPERATIONS[operation][1]
    if set(body) != set(fields):
        raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400)
    for field, value in body.items():
        if (operation == "v2/mutations/challenge" and field == "actor") or (
            operation.startswith("v2/backup-io/") and field == "body"
        ):
            if not isinstance(value, dict):
                raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400)
            continue
        if operation == "v2/mutations/commit" and field != "mutationProof" and value is None:
            continue
        if not isinstance(value, str) or not value.isascii() or not 1 <= len(value) <= 16384:
            raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400)
        if field == "requestId" and not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
            raise LocalTrustError("LOCAL_TRUST_INVALID_REQUEST", 400)
    return body


def create_app(service: LocalTrustService, *, authority: str) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_):
        try:
            yield
        finally:
            await service.close()

    app = FastAPI(
        docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False, lifespan=lifespan
    )

    @app.middleware("http")
    async def boundary(request, call_next):
        if (
            request.scope.get("scheme") != "https"
            or [host.lower() for host in request.headers.getlist("host")] != [authority]
            or request.url.query
            or any(name in request.headers for name in ("authorization", "cookie", "origin"))
        ):
            response = JSONResponse({"code": "LOCAL_TRUST_TRANSPORT_DENIED"}, status_code=403)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(LocalTrustError)
    async def local_error(_, exc):
        return JSONResponse({"code": exc.code}, status_code=exc.status)

    @app.exception_handler(BindingProtocolError)
    async def protocol_error(request, exc):
        if (
            request.url.path == PREFIX + "/state"
            and exc.code == "LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED"
        ):
            # A fixed protocol-version hint contains no identity or roster. Keep
            # it distinguishable so a migrated client uses its v2 key proof;
            # ordinary read denials must never be treated as an upgrade signal.
            return JSONResponse({"code": exc.code}, status_code=409)
        if request.url.path in {
            PREFIX + "/state",
            PREFIX + "/requests/read",
            "/local-trust/v2/read",
        }:
            # Unknown IDs, bad keys and inaccessible principals are externally
            # indistinguishable; never disclose record existence before proof.
            return JSONResponse({"code": "LOCAL_TRUST_READ_DENIED"}, status_code=403)
        return JSONResponse({"code": exc.code}, status_code=_status(exc.code))

    @app.exception_handler(HTTPException)
    async def http_error(_, exc):
        return JSONResponse({"code": "LOCAL_TRUST_ROUTE_UNAVAILABLE"}, status_code=exc.status_code)

    def route(operation):
        async def handle(request: Request):
            try:
                source = str(ipaddress.ip_address(request.client.host)) if request.client else ""
            except ValueError:
                source = ""
            if not source:
                raise LocalTrustError("LOCAL_TRUST_SOURCE_INVALID", 400)
            async with service.admission(source, operation) as admission:
                body = await _body(request, operation)
                result = await service.invoke(admission, operation, body)
                if operation.startswith("v2/backup-io/"):
                    encoded = json.dumps(result, separators=(",", ":")).encode("ascii")
                    limit = 1420000 if operation == "v2/backup-io/archive.read" else 32768
                    if len(encoded) > limit:
                        raise LocalTrustError("LOCAL_TRUST_RESPONSE_TOO_LARGE", 503)
                    return Response(encoded, media_type="application/json")
                return Response(result, media_type="application/jose")

        return handle

    for operation in OPERATIONS:
        path = (
            "/local-trust/v2/" + operation[3:]
            if operation.startswith("v2/")
            else PREFIX + "/" + operation
        )
        app.add_api_route(path, route(operation), methods=["POST"])
    return app
