"""Private OIDC provider used only by the loopback Octop authentication adapter."""

from __future__ import annotations

import base64
import hashlib
import re
import secrets
import threading
import time
from typing import Any
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives.asymmetric import ec


class OidcError(ValueError):
    """OAuth error with a public, non-sensitive code."""

    def __init__(self, code: str = "invalid_grant") -> None:
        self.code = code
        super().__init__(code)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def loopback_origin(url: str) -> str:
    """Accept literal loopback origins, avoiding DNS and proxy trust dependencies."""
    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("WANX_BRIDGE_LOOPBACK_ORIGIN_REQUIRED")
    try:
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("WANX_BRIDGE_LOOPBACK_ORIGIN_REQUIRED") from exc
    return url.rstrip("/")


class OidcProvider:
    """One-use authorization codes bound to nonce, client, redirect and S256 PKCE.

    The issuing method is deliberately not exposed as a public authorize endpoint.
    Only a verified platform grant may cause the adapter to call it.
    """

    def __init__(
        self,
        issuer: str,
        client_id: str,
        client_secret: str,
        key: ec.EllipticCurvePrivateKey,
    ) -> None:
        self.issuer = loopback_origin(issuer)
        if not client_id or len(client_secret) < 32 or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("WANX_BRIDGE_OIDC_CONFIG_INVALID")
        self.client_id = client_id
        self.client_secret = client_secret
        self.key = key
        numbers = key.public_key().public_numbers()
        self._public = {
            "kty": "EC",
            "crv": "P-256",
            "alg": "ES256",
            "use": "sig",
            "x": _b64(numbers.x.to_bytes(32, "big")),
            "y": _b64(numbers.y.to_bytes(32, "big")),
        }
        self._kid = _b64(hashlib.sha256((self._public["x"] + self._public["y"]).encode()).digest())
        self._codes: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def discovery(self) -> dict[str, Any]:
        return {
            "issuer": self.issuer,
            "authorization_endpoint": self.issuer + "/authorize",
            "token_endpoint": self.issuer + "/token",
            "jwks_uri": self.issuer + "/jwks",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "subject_types_supported": ["public"],
            "id_token_signing_alg_values_supported": ["ES256"],
            "token_endpoint_auth_methods_supported": ["client_secret_post"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["openid", "profile"],
        }

    def jwks(self) -> dict[str, Any]:
        return {"keys": [{**self._public, "kid": self._kid}]}

    def issue(
        self,
        subject: str,
        display_name: str,
        nonce: str,
        code_challenge: str,
        redirect_uri: str,
    ) -> str:
        parsed = urlsplit(redirect_uri)
        loopback_origin(f"{parsed.scheme}://{parsed.netloc}")
        if (
            not isinstance(subject, str)
            or not 1 <= len(subject) <= 256
            or not isinstance(nonce, str)
            or not 16 <= len(nonce) <= 256
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", code_challenge)
            or parsed.path != "/api/auth/oidc/callback"
            or parsed.query
            or parsed.fragment
        ):
            raise OidcError("invalid_request")
        now = time.time()
        code = secrets.token_urlsafe(32)
        with self._lock:
            self._codes = {k: v for k, v in self._codes.items() if v["expires"] > now}
            if len(self._codes) >= 1024:
                raise OidcError("temporarily_unavailable")
            self._codes[hashlib.sha256(code.encode()).hexdigest()] = {
                "subject": subject,
                "name": str(display_name)[:200],
                "nonce": nonce,
                "challenge": code_challenge,
                "redirect": redirect_uri,
                "expires": now + 30,
            }
        return code

    def exchange(self, form: dict[str, Any]) -> dict[str, Any]:
        if (
            not isinstance(form.get("client_secret"), str)
            or not secrets.compare_digest(form["client_secret"], self.client_secret)
            or form.get("client_id") != self.client_id
        ):
            raise OidcError("invalid_client")
        if form.get("grant_type") != "authorization_code":
            raise OidcError("unsupported_grant_type")
        code, verifier = form.get("code"), form.get("code_verifier")
        if not isinstance(code, str) or len(code) > 256:
            raise OidcError()
        with self._lock:
            record = self._codes.pop(hashlib.sha256(code.encode()).hexdigest(), None)
        if (
            not record
            or record["expires"] <= time.time()
            or form.get("redirect_uri") != record["redirect"]
            or not isinstance(verifier, str)
            or not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier)
            or not secrets.compare_digest(
                _b64(hashlib.sha256(verifier.encode()).digest()), record["challenge"]
            )
        ):
            raise OidcError()
        now = int(time.time())
        token = jwt.encode(
            {
                "iss": self.issuer,
                "aud": self.client_id,
                "sub": record["subject"],
                "name": record["name"],
                "nonce": record["nonce"],
                "iat": now,
                "exp": now + 60,
            },
            self.key,
            algorithm="ES256",
            headers={"kid": self._kid},
        )
        return {
            "id_token": token,
            "access_token": secrets.token_urlsafe(32),
            "token_type": "Bearer",
            "expires_in": 60,
        }
