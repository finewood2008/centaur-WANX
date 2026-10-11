"""Authenticate with an unmodified Octop using only its supported HTTP APIs."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

from .oidc import OidcError, OidcProvider, loopback_origin


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


class OctopAdapter:
    """Private server-side OIDC login; no Octop imports, DB or signing-secret access."""

    def __init__(
        self,
        base_url: str,
        provider: OidcProvider,
        credentials_file: str | Path,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = loopback_origin(base_url)
        self.provider = provider
        self.credentials_file = Path(credentials_file)
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=httpx.Timeout(15),
        )
        self._lock = asyncio.Lock()
        self._admin_token = ""
        self._admin_id: int | None = None
        self._initialized = False
        self._users: dict[str, int] = {}

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

    async def _admin(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if not self._admin_token:
            await self._admin_login()
        response = await self._request(
            method, path, headers={"Authorization": "Bearer " + self._admin_token}, **kwargs
        )
        if response.status_code == 401:
            await self._admin_login()
            response = await self._request(
                method, path, headers={"Authorization": "Bearer " + self._admin_token}, **kwargs
            )
        renewed = response.headers.get("X-Octop-Access-Token")
        if renewed and response.is_success:
            self._admin_token = renewed
        return response

    async def initialize(self) -> None:
        async with self._lock:
            config = self._json(await self._admin("GET", "/api/auth/oidc/config"))
            issuer, client_id = config.get("issuer"), config.get("client_id")
            if (issuer or client_id) and (
                issuer != self.provider.issuer or client_id != self.provider.client_id
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_CONFLICT")
            data = self._json(
                await self._admin(
                    "PUT",
                    "/api/auth/oidc/config",
                    json={
                        "enabled": True,
                        "display_name": "万象账号",
                        "issuer": self.provider.issuer,
                        "client_id": self.provider.client_id,
                        "client_secret": self.provider.client_secret,
                        "scopes": "openid profile",
                        "dashboard_origin": self.base_url,
                    },
                )
            )
            if (
                not data.get("enabled")
                or data.get("issuer") != self.provider.issuer
                or data.get("client_id") != self.provider.client_id
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_CONFLICT")
            self._initialized = True

    async def login(self, claims: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            if not self._initialized:
                raise BridgeUpstreamError("BOX_UPSTREAM_NOT_READY")
            subject, role = claims.get("sub"), claims.get("role")
            if not isinstance(subject, str) or not subject or role not in {"admin", "user"}:
                raise BridgeUpstreamError("BOX_UPSTREAM_IDENTITY_INVALID", 403)
            # Do not let concurrent logins replace another request's state cookie.
            self._client.cookies.clear()
            start_response = await self._request(
                "POST", "/api/auth/oidc/start", json={"redirect_after": "/"}
            )
            started = self._json(start_response)
            url = urlsplit(str(started.get("authorization_url", "")))
            query = parse_qs(url.query, keep_blank_values=True)
            if any(len(v) != 1 for v in query.values()):
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_INVALID")
            fields = {k: v[0] for k, v in query.items()}
            callback = self.base_url + "/api/auth/oidc/callback"
            state = started.get("state")
            if (
                f"{url.scheme}://{url.netloc}{url.path}" != self.provider.issuer + "/authorize"
                or url.fragment
                or fields.get("client_id") != self.provider.client_id
                or fields.get("response_type") != "code"
                or fields.get("code_challenge_method") != "S256"
                or fields.get("redirect_uri") != callback
                or not isinstance(state, str)
                or not state
                or fields.get("state") != state
                or start_response.cookies.get("octop_sso_state") != state
                or not fields.get("nonce")
                or not fields.get("code_challenge")
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_INVALID")
            try:
                code = self.provider.issue(
                    subject,
                    claims.get("display_name", ""),
                    fields["nonce"],
                    fields["code_challenge"],
                    callback,
                )
            except OidcError as exc:
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_INVALID") from exc
            callback_response = await self._request(
                "GET", "/api/auth/oidc/callback", params={"code": code, "state": state}
            )
            location = urlsplit(callback_response.headers.get("location", ""))
            fragment = parse_qs(location.fragment, keep_blank_values=True)
            if (
                callback_response.status_code != 302
                or f"{location.scheme}://{location.netloc}" != self.base_url
                or location.path != "/login/oidc/complete"
                or location.query
                or len(fragment.get("code", [])) != 1
                or not fragment["code"][0]
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_FAILED")
            minted_at = int(time.time())
            result = self._json(
                await self._request(
                    "POST", "/api/auth/oidc/exchange", json={"code": fragment["code"][0]}
                )
            )
            token, user, ttl = (
                result.get("access_token"),
                result.get("user"),
                result.get("expires_in"),
            )
            if (
                not isinstance(token, str)
                or not token
                or not isinstance(user, dict)
                or type(user.get("id")) is not int
                or type(ttl) is not int
                or ttl <= 0
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_PROTOCOL_INVALID")
            uid = user["id"]
            if (
                uid == self._admin_id
                or (subject in self._users and self._users[subject] != uid)
                or any(s != subject and i == uid for s, i in self._users.items())
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_IDENTITY_MISMATCH", 403)
            headers = {"Authorization": "Bearer " + token}
            me = self._json(await self._request("GET", "/api/auth/me", headers=headers))
            if (
                me.get("id") != uid
                or me.get("has_password") is not False
                or me.get("sso_identities") != [{"kind": "oidc"}]
            ):
                raise BridgeUpstreamError("BOX_UPSTREAM_IDENTITY_MISMATCH", 403)
            self._users[subject] = uid
            if me.get("role") != role:
                patched = self._json(
                    await self._admin("PATCH", f"/api/users/{uid}", json={"role": role})
                )
                if patched.get("id") != uid or patched.get("role") != role:
                    raise BridgeUpstreamError("BOX_UPSTREAM_ROLE_SYNC_FAILED")
                me = self._json(await self._request("GET", "/api/auth/me", headers=headers))
            if me.get("role") != role:
                raise BridgeUpstreamError("BOX_UPSTREAM_ROLE_SYNC_FAILED")
            return {"access_token": token, "user": me, "expires_at": minted_at + ttl}

    async def close(self) -> None:
        self._initialized = False
        self._admin_token = ""
        await self._client.aclose()
