"""Standalone native API transport, separate from the existing desktop contract.

The native workbench is an instance-wide administrative surface, not an
account-scoped warehouse API. Check the current WANX administrator through its
public HTTP API; never import its implementation or accept a caller's identity.
"""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import httpx
from fastapi import APIRouter, Request, Response, WebSocket

from ..config import BridgeAuthError
from .config import upstream_origin

PREFIX = "/api/semantica/native"
_RESOURCES = frozenset(
    {
        "health",
        "settings",
        "jobs",
        "documents",
        "ontologies",
        "knowledge",
        "search",
        "graph",
        "evidence",
        "sensitive",
        "skills",
        "reasoning",
    }
)


def _field(session: Any, name: str) -> Any:
    return session[name] if isinstance(session, Mapping) else getattr(session, name)


def _native_path(path: str) -> bool:
    return (
        path.split("/", 1)[0] in _RESOURCES
        and not any(part in {".", ".."} for part in path.split("/"))
        and not any(value in path for value in ("\\", "%", "//"))
        and not any(ord(character) < 32 or ord(character) == 127 for character in path)
    )


def request_headers(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    return [
        (key, value)
        for key, value in headers
        if key.lower() not in {"origin", "referer", "x-xingtu-key", "x-skill-admin-token"}
        and not key.lower().startswith(("x-semantica-", "x-wanx-", "x-octop-", "x-starklink-"))
    ]


def response_headers(headers: dict[str, str]) -> dict[str, str]:
    """Keep redirects inside the registered native API namespace."""
    headers["cache-control"] = "no-store"
    if "location" in headers:
        location = urlsplit(headers["location"])
        if location.scheme or location.netloc or not location.path.startswith("/api/"):
            raise BridgeAuthError("SEMANTICA_NATIVE_REDIRECT_DENIED", 502)
        try:
            path = unquote(location.path[5:], errors="strict")
        except UnicodeError as exc:
            raise BridgeAuthError("SEMANTICA_NATIVE_REDIRECT_DENIED", 502) from exc
        if not _native_path(path):
            raise BridgeAuthError("SEMANTICA_NATIVE_REDIRECT_DENIED", 502)
        headers["location"] = PREFIX + "/" + quote(path, safe="/")
        if location.query:
            headers["location"] += "?" + location.query
    return headers


def create_router(
    *,
    service_url: str,
    octop_url: str,
    client: httpx.AsyncClient,
    authorize: Callable[[Request], Awaitable[Any]],
    forward: Callable[..., Awaitable[Response]],
) -> APIRouter:
    origin = upstream_origin(service_url)
    router = APIRouter(prefix=PREFIX, tags=["semantica-native"])

    @router.api_route(
        "",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        summary="Access the independent Semantica native API",
    )
    @router.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        summary="Proxy an independent Semantica native API operation",
        description="Requires a live WANX administrator session. Preserves native bodies and responses.",
    )
    async def native(request: Request, path: str = "") -> Response:
        session = await authorize(request)
        # Refuse aliases before HTTPX can normalize them into another namespace.
        if not _native_path(path):
            raise BridgeAuthError("SEMANTICA_NATIVE_ROUTE_NOT_FOUND", 404)

        identity_request = client.build_request(
            "GET",
            octop_url + "/api/auth/me",
            headers={"Authorization": "Bearer " + _field(session, "upstream_token")},
            timeout=10,
        )
        identity_request.headers.pop("cookie", None)
        identity = await client.send(identity_request)
        if identity.status_code != 200:
            raise BridgeAuthError(
                "SEMANTICA_NATIVE_IDENTITY_UNAVAILABLE",
                identity.status_code if identity.status_code in {401, 403} else 502,
            )
        try:
            profile = identity.json()
        except ValueError as exc:
            raise BridgeAuthError("SEMANTICA_NATIVE_IDENTITY_UNAVAILABLE", 502) from exc
        if (
            not isinstance(profile, dict)
            or profile.get("id") != _field(session, "user").get("id")
            or profile.get("role") != "admin"
            or profile.get("application_id", "wanx")
            not in {"wanx", "semantica", "centaurai.wanx.semantica"}
        ):
            raise BridgeAuthError("SEMANTICA_NATIVE_ADMIN_REQUIRED", 403)

        return await forward(
            request,
            path="/api/" + path,
            target_origin=origin,
            session=session,
            token=None,
            guard_resources=False,
            filter_request_headers=request_headers,
            filter_response_headers=response_headers,
        )

    @router.websocket("")
    @router.websocket("/{path:path}")
    async def unsupported_websocket(websocket: WebSocket) -> None:
        await websocket.close(code=4403)

    return router
