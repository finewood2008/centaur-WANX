"""Authenticate with an unmodified Octop using only its supported HTTP APIs."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx

from .admin_client import AdminClient
from .admin_client import BridgeUpstreamError as BridgeUpstreamError
from .oidc import OidcError, OidcProvider
from .zhijun_bootstrap import ensure_private_expert


class OctopAdapter(AdminClient):
    """Private server-side OIDC login; no Octop imports, DB or signing-secret access."""

    def __init__(
        self,
        base_url: str,
        provider: OidcProvider,
        credentials_file: str | Path,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(base_url, credentials_file, transport=transport)
        self.provider = provider
        self._lock = asyncio.Lock()
        self._initialized = False
        self._users: dict[str, int] = {}

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
            await ensure_private_expert(self, token, uid)
            return {"access_token": token, "user": me, "expires_at": minted_at + ttl}

    async def application_session(self, token: str, application_id: str) -> dict[str, Any]:
        # Only the upstream extension can mint a scoped JWT. The bridge does not
        # import upstream modules, inspect its DB, or access its signing secret.
        response = await self._request(
            "POST",
            "/api/auth/application/exchange",
            headers={"Authorization": "Bearer " + token},
            json={"application_id": application_id},
        )
        if response.status_code == 404:
            raise BridgeUpstreamError("BOX_APPLICATION_RUNTIME_UPDATE_REQUIRED", 409)
        if response.status_code in {401, 403}:
            raise BridgeUpstreamError("BOX_APPLICATION_ACCESS_DENIED", 403)
        result = self._json(response)
        ttl = result.get("expires_in")
        if type(ttl) is not int or ttl <= 0:
            raise BridgeUpstreamError("BOX_APPLICATION_SESSION_INVALID", 502)
        return {**result, "expires_at": time.time() + ttl}

    async def close(self) -> None:
        self._initialized = False
        await super().close()
