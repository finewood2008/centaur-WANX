"""Central authority configuration and verified WANX account/application identity."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from octop.infra.applications.service import assert_product_login
from octop.infra.credits.service import CreditService, fail
from octop.infra.db.services import SharedServices
from octop.infra.users.identity import User


@dataclass(frozen=True)
class CreditAuthority:
    issuer: str
    application_key_hashes: dict[str, str]

    @classmethod
    def configured(cls) -> CreditAuthority:
        if os.environ.get("WANX_CREDITS_AUTHORITY") != "1":
            fail("DISABLED")
        issuer = os.environ.get("WANX_CREDITS_ISSUER", "")
        try:
            parsed = urlsplit(issuer)
        except ValueError:
            fail("DISABLED")
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            fail("DISABLED")
        try:
            hashes = json.loads(os.environ.get("WANX_CREDITS_APP_KEY_HASHES", "{}"))
        except ValueError:
            fail("DISABLED")
        if not isinstance(hashes, dict) or any(
            not isinstance(k, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", k)
            or not isinstance(v, str)
            or not re.fullmatch(r"[a-f0-9]{64}", v)
            for k, v in hashes.items()
        ):
            fail("DISABLED")
        return cls(issuer, hashes)

    def account(self, services: SharedServices, user_id: int) -> CreditService:
        identities = services.user_repo.list_sso_identities(user_id)
        subjects: set[str] = set()
        for identity in identities:
            provider = services.sso_repo.get_by_id(identity.provider_id)
            if (
                provider
                and provider.enabled
                and provider.kind == "oidc"
                and provider.issuer == self.issuer
            ):
                subjects.add(identity.subject)
        if len(subjects) != 1:
            fail("IDENTITY")
        return CreditService(services, self.issuer, subjects.pop())

    def application(
        self, services: SharedServices, user: User, application_id: str, key: str | None = None
    ) -> None:
        if application_id not in self.application_key_hashes:
            fail("FORBIDDEN")
        assert_product_login(services, user.id, application_id)
        if key is not None:
            expected = self.application_key_hashes[application_id]
            if len(key) < 32 or not hmac.compare_digest(
                hashlib.sha256(key.encode()).hexdigest(), expected
            ):
                fail("FORBIDDEN")

    def settlement(
        self, services: SharedServices, user: User, application_id: str, key: str
    ) -> None:
        if user.application_id != application_id:
            fail("FORBIDDEN")
        self.application(services, user, application_id, key)
