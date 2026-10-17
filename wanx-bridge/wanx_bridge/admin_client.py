"""Private loopback admin HTTP client, shared by WANX setup and identity bridge."""

from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path
from typing import Any

import httpx

from .oidc import loopback_origin


class BridgeUpstreamError(RuntimeError):
    def __init__(self, code: str, status: int = 503) -> None:
        self.code, self.status = code, status
        super().__init__(code)


def _credentials(path: Path) -> dict[str, str]:
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                raise ValueError()
            if os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.geteuid()):
                raise ValueError()
            data = json.loads(stream.read(4097))
        if not isinstance(data, dict) or set(data) != {"username", "password"}:
            raise ValueError()
        if not all(isinstance(data[k], str) and data[k] for k in data):
            raise ValueError()
        return data
    except (OSError, ValueError, TypeError) as exc:
        raise BridgeUpstreamError("BOX_UPSTREAM_CREDENTIALS_INVALID") from exc


class AdminClient:
    """Use ordinary upstream APIs without exposing the administrator session."""

    def __init__(
        self,
        base_url: str,
        credentials_file: str | Path,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = loopback_origin(base_url)
        self.credentials_file = Path(credentials_file)
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(15),
        )
        self._admin_token = ""
        self._admin_id: int | None = None

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        # Only fixed paths generated here are accepted; no URL from a peer is fetched.
        if not path.startswith("/api/") or path.startswith("//"):
            raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")
        try:
            async with asyncio.timeout(20), self._client.stream(method, path, **kwargs) as response:
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > 2 * 1024 * 1024:
                        raise BridgeUpstreamError("BOX_UPSTREAM_RESPONSE_TOO_LARGE")
                return httpx.Response(
                    response.status_code,
                    headers=response.headers,
                    content=bytes(chunks),
                    request=response.request,
                )
        except (httpx.HTTPError, TimeoutError) as exc:
            raise BridgeUpstreamError("BOX_UPSTREAM_UNAVAILABLE") from exc

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        if response.status_code not in {200, 201}:
            raise BridgeUpstreamError("BOX_UPSTREAM_AUTH_FAILED")
        try:
            data = response.json()
        except ValueError as exc:
            raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID") from exc
        if not isinstance(data, dict):
            raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")
        return data

    async def _admin_login(self) -> None:
        captcha = self._json(await self._request("GET", "/api/auth/captcha"))
        if captcha.get("provider") != "slider":
            raise BridgeUpstreamError("BOX_UPSTREAM_CAPTCHA_REQUIRED")
        credentials = await asyncio.to_thread(_credentials, self.credentials_file)
        data = self._json(await self._request("POST", "/api/auth/login", json=credentials))
        user = data.get("user", {})
        token = data.get("access_token")
        if (
            not isinstance(token, str)
            or not token
            or not isinstance(user, dict)
            or user.get("role") != "admin"
            or type(user.get("id")) is not int
        ):
            raise BridgeUpstreamError("BOX_UPSTREAM_ADMIN_REQUIRED")
        self._admin_token, self._admin_id = token, user["id"]

    async def _admin(
        self, method: str, path: str, *, retry_auth: bool = True, **kwargs: Any
    ) -> httpx.Response:
        if not self._admin_token:
            await self._admin_login()
        response = await self._request(
            method, path, headers={"Authorization": "Bearer " + self._admin_token}, **kwargs
        )
        if response.status_code == 401 and retry_auth:
            await self._admin_login()
            response = await self._request(
                method, path, headers={"Authorization": "Bearer " + self._admin_token}, **kwargs
            )
        renewed = response.headers.get("X-Octop-Access-Token")
        if renewed and response.is_success:
            self._admin_token = renewed
        return response

    async def request(
        self, method: str, path: str, *, retry_auth: bool = True, **kwargs: Any
    ) -> dict[str, Any]:
        return self._json(await self._admin(method, path, retry_auth=retry_auth, **kwargs))

    async def close(self) -> None:
        self._admin_token = ""
        await self._client.aclose()
