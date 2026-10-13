"""Pinned platform grants exchanged for private upstream sessions at the bridge."""

from __future__ import annotations

import asyncio
import hashlib
import math
import secrets
import time
from dataclasses import dataclass
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .config import BridgeAuthError, PlatformConfig
from .store import Store

CONTRACT = "wanx-p2p-v1"
CHALLENGE_AUDIENCE = "wanx-p2p-challenge"
LOGIN_AUDIENCE = "wanx-p2p-login"
MAX_LEASE_SECONDS = 120


def fingerprint(key: Ed25519PublicKey) -> str:
    return hashlib.sha256(
        key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    ).hexdigest()


@dataclass(frozen=True)
class Session:
    upstream_token: str
    user: dict[str, Any]
    sid: str
    key: str
    expires_at: float
    upstream_expires_at: float


class PlatformAuthService:
    def __init__(self, config: PlatformConfig, store: Store | None = None) -> None:
        self.config = config
        self.store = store or Store(config.state_dir)
        self.sessions: dict[str, Session] = {}
        # Adapter login updates the upstream user's role. Serialize the complete
        # exchange, including that mutation, rather than only the SQLite commit.
        self._exchange_lock = asyncio.Lock()
        self._pending_exchanges = 0

    def challenge(self, account_id: str, client_id: str, network_session_id: str) -> dict[str, Any]:
        if any(
            not isinstance(v, str) or not 1 <= len(v) <= 256
            for v in (account_id, client_id, network_session_id)
        ):
            raise BridgeAuthError()
        now = int(time.time())
        proof = {
            "contract": CONTRACT,
            "iss": "wanx-box",
            "aud": CHALLENGE_AUDIENCE,
            "sub": account_id,
            "client_id": client_id,
            "device_id": self.config.device_id,
            "network_session_id": network_session_id,
            "challenge_id": secrets.token_urlsafe(24),
            "nonce": secrets.token_urlsafe(32),
            "iat": now,
            "exp": now + 60,
            "jti": secrets.token_urlsafe(24),
        }
        self.store.challenge(proof)
        receipt = jwt.encode(
            proof,
            self.config.box_key,
            algorithm="EdDSA",
            headers={"kid": fingerprint(self.config.box_key.public_key())},
        )
        return {"challengeReceipt": receipt, "expiresIn": 60}

    def verify_grant(self, grant: str) -> dict[str, Any]:
        required = {
            "contract",
            "iss",
            "aud",
            "sub",
            "client_id",
            "device_id",
            "network_session_id",
            "challenge_id",
            "nonce",
            "iat",
            "exp",
            "jti",
            "ownership_epoch",
            "authorization_version",
            "client_session_version",
            "account_auth_version",
            "role",
            "membership_id",
            "membership_version",
            "display_name",
            "lease_exp",
        }
        try:
            if not isinstance(grant, str) or len(grant) > 16384:
                raise ValueError("size")
            header = jwt.get_unverified_header(grant)
            if header.get("kid") != fingerprint(self.config.platform_key) or set(header) - {
                "kid",
                "typ",
                "alg",
            }:
                raise ValueError("key")
            claims = jwt.decode(
                grant,
                self.config.platform_key,
                algorithms=["EdDSA"],
                issuer=self.config.issuer,
                audience=LOGIN_AUDIENCE,
                options={"require": sorted(required)},
            )
            now = time.time()
            if (
                set(claims) != required
                or claims["contract"] != CONTRACT
                or claims["aud"] != LOGIN_AUDIENCE
                or claims["device_id"] != self.config.device_id
            ):
                raise ValueError("context")
            versions = ("ownership_epoch", "authorization_version", "membership_version")
            zero_versions = ("client_session_version", "account_auth_version")
            if any(
                type(claims[k]) is not int
                for k in ("iat", "exp", "lease_exp", *versions, *zero_versions)
            ):
                raise ValueError("versions")
            if any(claims[k] < 1 for k in versions) or any(claims[k] < 0 for k in zero_versions):
                raise ValueError("versions")
            if (
                not 0 < claims["exp"] - claims["iat"] <= 60
                or not now < claims["lease_exp"] <= claims["iat"] + MAX_LEASE_SECONDS
                or claims["exp"] > claims["lease_exp"]
            ):
                raise ValueError("lease")
            if (
                claims["role"] not in ("admin", "user")
                or not isinstance(claims["display_name"], str)
                or len(claims["display_name"]) > 256
            ):
                raise ValueError("identity")
            for k in (
                "sub",
                "client_id",
                "device_id",
                "network_session_id",
                "challenge_id",
                "nonce",
                "jti",
                "membership_id",
            ):
                if not isinstance(claims[k], str) or not 1 <= len(claims[k]) <= 256:
                    raise ValueError("identity")
            return dict(claims)
        except (jwt.PyJWTError, ValueError, TypeError) as exc:
            raise BridgeAuthError() from exc

    async def exchange(self, grant: str, adapter: Any) -> dict[str, Any]:
        self.verify_grant(grant)
        if self._pending_exchanges >= 64:
            raise BridgeAuthError("BOX_PLATFORM_BUSY", 429)
        self._pending_exchanges += 1
        task = asyncio.create_task(self._serialized_exchange(grant, adapter))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # A disconnected caller must not release the lock while the upstream
            # role write is still in flight. Finish it before accepting a successor.
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not task.cancelled():
                task.exception()  # Retrieve any failure without leaking credentials.
            raise
        finally:
            self._pending_exchanges -= 1

    async def _serialized_exchange(self, grant: str, adapter: Any) -> dict[str, Any]:
        async with self._exchange_lock:
            return await self._exchange(grant, adapter)

    async def _exchange(self, grant: str, adapter: Any) -> dict[str, Any]:
        claims = self.verify_grant(grant)
        await asyncio.to_thread(self.store.consume, claims)
        upstream = await adapter.login(claims)
        upstream_token = upstream.get("access_token")
        user = upstream.get("user")
        upstream_exp = upstream.get("expires_at")
        if (
            not isinstance(upstream_token, str)
            or not upstream_token
            or not isinstance(user, dict)
            or type(upstream_exp) not in (int, float)
            or not math.isfinite(upstream_exp)
        ):
            raise BridgeAuthError("BOX_PLATFORM_UPSTREAM_INVALID", 502)
        # Exchange may include network I/O. Validate both authority and time again afterwards.
        claims = self.verify_grant(grant)
        expires_at = min(claims["lease_exp"], upstream_exp)
        if expires_at <= time.time():
            raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED")
        token = secrets.token_urlsafe(48)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        key, sid = await asyncio.to_thread(self.store.activate, claims, token_hash, expires_at)
        session = Session(upstream_token, user, sid, key, expires_at, upstream_exp)
        # No await between final authorization check and making the token visible.
        self.store.assert_live(key, sid)
        self.sessions = {k: v for k, v in self.sessions.items() if v.expires_at > time.time()}
        self.sessions[token_hash] = session
        return {
            "access_token": token,
            "token_type": "Bearer",
            "expires_in": max(1, int(expires_at - time.time())),
            "user": user,
        }

    async def application_session(
        self, marker: str, application_id: str, adapter: Any
    ) -> dict[str, Any]:
        """Derive an opaque application token under the same revocable platform lease."""
        parent = self.authorize(marker)
        if (
            application_id != "super-advisory"
            or parent.user.get("application_id", "wanx") != "wanx"
        ):
            raise BridgeAuthError("BOX_APPLICATION_SCOPE_FORBIDDEN", 403)
        # Bound concurrent issuance and memory without extending the parent authority.
        async with self._exchange_lock:
            self.authorize(marker)
            self.sessions = {k: v for k, v in self.sessions.items() if v.expires_at > time.time()}
            if len(self.sessions) >= 4096:
                raise BridgeAuthError("BOX_PLATFORM_BUSY", 429)
            upstream = await adapter.application_session(parent.upstream_token, application_id)
            user, token, expires_at = (
                upstream.get("user"),
                upstream.get("access_token"),
                upstream.get("expires_at"),
            )
            if (
                not isinstance(user, dict)
                or type(user.get("id")) is not int
                or user.get("id") != parent.user.get("id")
                or user.get("role") != parent.user.get("role")
                or user.get("application_id") != application_id
                or not isinstance(token, str)
                or not token
                or type(expires_at) not in (int, float)
                or not math.isfinite(expires_at)
            ):
                raise BridgeAuthError("BOX_APPLICATION_SESSION_INVALID", 502)
            self.authorize(marker)
            expires_at = min(parent.expires_at, parent.upstream_expires_at, expires_at)
            if expires_at <= time.time():
                raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED")
            opaque = secrets.token_urlsafe(48)
            self.sessions[hashlib.sha256(opaque.encode()).hexdigest()] = Session(
                token,
                user,
                parent.sid,
                parent.key,
                expires_at,
                min(parent.upstream_expires_at, upstream["expires_at"]),
            )
            return {
                "access_token": opaque,
                "token_type": "Bearer",
                "expires_in": max(1, int(expires_at - time.time())),
                "user": user,
            }

    def authorize(self, token: str) -> Session:
        if not isinstance(token, str) or len(token) > 256:
            raise BridgeAuthError()
        session = self.sessions.get(hashlib.sha256(token.encode()).hexdigest())
        if session is None or session.expires_at <= time.time():
            raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED")
        self.assert_live(session)
        return session

    def assert_live(self, session: Session) -> None:
        # Only accepted streams may follow the renewed server lease. New requests must
        # also pass authorize(), which enforces the presented token's fixed expiration.
        if session.upstream_expires_at <= time.time():
            raise BridgeAuthError("BOX_PLATFORM_SESSION_EXPIRED")
        self.store.assert_live(session.key, session.sid)

    def close(self) -> None:
        self.sessions.clear()
        self.store.close()
