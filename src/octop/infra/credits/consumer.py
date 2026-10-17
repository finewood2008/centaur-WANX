"""Read-only account ledger access after online Consumer session verification."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Mapping
from typing import Any

import httpx

from octop.infra.credits.access import CreditAuthority
from octop.infra.credits.service import CreditService, fail
from octop.infra.db.services import SharedServices

logger = logging.getLogger(__name__)

BOOTSTRAP = "/app-api/v1/sync/bootstrap"
PROOF_HEADERS = (
    "authorization",
    "x-nexus-client-id",
    "x-nexus-timestamp",
    "x-nexus-nonce",
    "x-nexus-body-sha256",
    "x-nexus-signature",
    "x-nexus-signature-version",
)


async def verified_account(headers: Mapping[str, str]) -> tuple[str, str]:
    authority = CreditAuthority.configured()
    base = os.environ.get("WANX_CREDITS_CONSUMER_URL", "")
    # This namespace is pinned by the operator, never selected by the caller.
    if not base or base != authority.issuer or base.endswith("/"):
        fail("DISABLED")
    proof = {key: headers.get(key, "") for key in PROOF_HEADERS}
    if (
        any(not value or len(value) > 16384 for value in proof.values())
        or not proof["authorization"].startswith("Bearer ")
        or proof["x-nexus-signature-version"] != "NEXUSAOS-CONSUMER-APP-V1"
        or proof["x-nexus-body-sha256"] != hashlib.sha256(b"").hexdigest()
    ):
        fail("IDENTITY")
    # The authority validates token, registered client signature, nonce and revocation.
    # Do not log or persist its token, bootstrap profile, or device list.
    try:
        async with (
            httpx.AsyncClient(timeout=15, follow_redirects=False, trust_env=False) as client,
            client.stream("GET", base + BOOTSTRAP, headers=proof) as response,
        ):
            if response.status_code != 200:
                logger.warning("Credit Consumer verification HTTP status=%s", response.status_code)
                fail("IDENTITY" if response.status_code in (401, 403) else "DISABLED")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > 2 * 1024 * 1024:
                    fail("IDENTITY")
            data: Any = json.loads(body)
    except (httpx.HTTPError, ValueError):
        fail("DISABLED")
    if (
        not isinstance(data, dict)
        or not (
            data.get("code") in (0, 200)
            or (data.get("code") is None and data.get("success") is True)
        )
        or data.get("success") is False
    ):
        logger.warning(
            "Credit Consumer rejected envelope: code=%s",
            data.get("code") if isinstance(data, dict) else "invalid",
        )
        fail("IDENTITY")
    account = data.get("data", {}).get("account", {}) if isinstance(data.get("data"), dict) else {}
    current = account.get("currentClient", {}) if isinstance(account, dict) else {}
    subject = account.get("accountId") if isinstance(account, dict) else None
    if (
        not isinstance(subject, str)
        or not 1 <= len(subject) <= 256
        or account.get("accountStatus") != "active"
        or not isinstance(current, dict)
        or current.get("clientId") != proof["x-nexus-client-id"]
        or current.get("clientStatus") != "active"
        or current.get("isCurrent") is not True
        or current.get("hasActiveSession") is not True
    ):
        fail("IDENTITY")
    return base, subject


async def account_service(services: SharedServices, headers: Mapping[str, str]) -> CreditService:
    issuer, subject = await verified_account(headers)
    return CreditService(services, issuer, subject)
